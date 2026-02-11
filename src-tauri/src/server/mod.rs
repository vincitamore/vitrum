pub mod document;
pub mod federation;
pub mod index;
pub mod peers;
pub mod projects;
pub mod routes;
pub mod static_files;
pub mod sync;
pub mod watcher;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{Any, CorsLayer};

use index::DocumentIndex;
use peers::PeerRegistry;
use sync::SyncService;
use watcher::FileWatcher;

pub fn log_to_file(msg: &str) {
    let log_path = env::temp_dir().join("vitrum.log");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] [server] {}", timestamp, msg);
    }
}

pub struct AppState {
    pub index: Arc<RwLock<DocumentIndex>>,
    pub org_root: PathBuf,
    pub start_time: std::time::Instant,
    pub ws_tx: broadcast::Sender<String>,
}

/// Federation state wraps AppState + federation-specific services
pub struct FederationState {
    pub app_state: Arc<AppState>,
    pub peer_registry: Arc<PeerRegistry>,
    pub sync_service: Arc<SyncService>,
    pub local_host: RwLock<Option<(String, u16)>>,
}

/// WebSocket upgrade handler
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    log_to_file("[ws] Client connecting...");
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

/// Handle an individual WebSocket connection
async fn handle_ws_connection(mut socket: WebSocket, state: Arc<AppState>) {
    log_to_file("[ws] Client connected");
    let mut rx = state.ws_tx.subscribe();

    loop {
        tokio::select! {
            // Forward broadcast messages to this client
            msg = rx.recv() => {
                match msg {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            log_to_file("[ws] Client disconnected (send failed)");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log_to_file(&format!("[ws] Client lagged by {} messages", n));
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        log_to_file("[ws] Broadcast channel closed");
                        break;
                    }
                }
            }
            // Handle incoming messages from client (ping/pong, close)
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => {
                        log_to_file("[ws] Client disconnected");
                        break;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(_)) => {
                        // Ignore other messages
                    }
                    Some(Err(e)) => {
                        log_to_file(&format!("[ws] Client error: {}", e));
                        break;
                    }
                }
            }
        }
    }
}

pub async fn start_server(org_root: PathBuf, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    log_to_file(&format!("start_server called with org_root={:?}, port={}", org_root, port));

    // Install rustls crypto provider (required before any TLS operations)
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let start_time = std::time::Instant::now();

    // Load index from cache or build incrementally
    log_to_file("Loading document index...");
    let mut index = DocumentIndex::new(&org_root);
    let (total, cached, parsed, removed) = index.load_or_build().await;
    log_to_file(&format!(
        "Index loaded: {} total ({} cached, {} parsed, {} removed)",
        total, cached, parsed, removed
    ));

    // Create broadcast channel for WebSocket live reload
    let (ws_tx, _) = broadcast::channel::<String>(64);

    let app_state = Arc::new(AppState {
        index: Arc::new(RwLock::new(index)),
        org_root: org_root.clone(),
        start_time,
        ws_tx,
    });

    // Initialize federation services
    log_to_file("Initializing federation services...");
    let peer_registry = Arc::new(PeerRegistry::new(&org_root));
    let sync_service = Arc::new(SyncService::new(
        &org_root,
        Arc::clone(&app_state.index),
        Arc::clone(&peer_registry),
    ));

    let fed_state = Arc::new(FederationState {
        app_state: Arc::clone(&app_state),
        peer_registry: Arc::clone(&peer_registry),
        sync_service: Arc::clone(&sync_service),
        local_host: RwLock::new(None),
    });

    // Set local host info
    sync_service.set_local_host("localhost".to_string(), port).await;
    *fed_state.local_host.write().await = Some(("localhost".to_string(), port));

    // Start peer discovery polling
    let peer_count = peer_registry.get_peers().await.len();
    log_to_file(&format!("Starting peer polling ({} peers configured)...", peer_count));
    peer_registry.start_polling();

    // Count shared documents BEFORE spawning file watcher to avoid RwLock deadlock.
    // The file watcher takes write locks on index for every file event, and
    // get_shared_documents() needs a read lock — on a large repo, events flood in
    // immediately and the write lock blocks the read lock indefinitely.
    let shared_count = sync_service.get_shared_documents().await.len();
    log_to_file(&format!("Starting sync polling ({} adopted documents)...", shared_count));

    // Set up sync status callback to broadcast via WebSocket
    let ws_tx_for_sync = app_state.ws_tx.clone();
    sync_service.on_status_change(Box::new(move |event| {
        log_to_file(&format!(
            "Sync: {} {} → {}{}",
            event.path,
            event.old_status,
            event.new_status,
            event.peer.as_ref().map(|p| format!(" ({})", p)).unwrap_or_default()
        ));
        let msg = serde_json::json!({
            "type": "sync-status-changed",
            "path": event.path,
            "peer": event.peer,
            "timestamp": event.timestamp,
        });
        let _ = ws_tx_for_sync.send(msg.to_string());
    })).await;

    sync_service.start_sync_polling();

    // Start file watcher LAST — it takes write locks on the index for every file
    // event, so all setup that needs read locks must complete first.
    log_to_file("Starting file watcher...");
    let watcher_state = Arc::clone(&app_state);
    let watcher_sync = Arc::clone(&sync_service);
    tokio::spawn(async move {
        if let Err(e) = FileWatcher::watch_with_sync(watcher_state, watcher_sync).await {
            log_to_file(&format!("File watcher error: {}", e));
        }
    });

    // CORS configuration
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build federation sub-router with its own state
    let fed_router = federation::create_federation_routes().with_state(Arc::clone(&fed_state));

    // Build router — API routes first, then static file fallback
    let app = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/status", get(routes::status))
        .route("/api/files", get(routes::list_files))
        .route("/api/files/{*path}", get(routes::get_file).put(routes::put_file))
        .route("/api/search", get(routes::search))
        .route("/api/graph", get(routes::graph))
        .route("/api/projects", get(projects::list_projects))
        .route("/api/projects/{name}/tree", get(projects::get_tree))
        .route("/api/projects/{name}/file/{*path}", get(projects::get_file).put(projects::put_file))
        .route("/api/debug-log", post(routes::debug_log))
        .route("/ws", get(ws_handler))
        // Federation routes (nested with their own state)
        .nest("/api/federation", fed_router)
        // Static file serving (embedded client dist)
        .fallback(static_files::static_handler)
        .layer(cors)
        .with_state(app_state);

    log_to_file("File watcher spawned, now binding server...");
    log_to_file(&format!("Federation: {} peers configured", peer_count));
    log_to_file(&format!("Sync: watching {} adopted document(s)", shared_count));

    // Check for TLS certificates (for Tailscale HTTPS access)
    let tls_cert = env::var("ORG_VIEWER_TLS_CERT").ok();
    let tls_key = env::var("ORG_VIEWER_TLS_KEY").ok();

    match (&tls_cert, &tls_key) {
        (Some(cert_path), Some(key_path)) => {
            // Dual-listener mode: HTTP on localhost (for Tauri WebView) + HTTPS on 0.0.0.0 (for Tailscale)
            log_to_file(&format!("TLS enabled: cert={}, key={}", cert_path, key_path));

            let config = match RustlsConfig::from_pem_file(cert_path, key_path).await {
                Ok(c) => c,
                Err(e) => {
                    log_to_file(&format!("FAILED to load TLS certs: {}", e));
                    log_to_file("Hint: Run 'tailscale cert <your-hostname>' to generate certs");
                    return Err(e.into());
                }
            };

            // Spawn HTTP listener on localhost only (for Tauri WebView IPC)
            let local_addr = SocketAddr::from(([127, 0, 0, 1], port));
            let local_app = app.clone();
            tokio::spawn(async move {
                match tokio::net::TcpListener::bind(local_addr).await {
                    Ok(listener) => {
                        log_to_file(&format!("SUCCESS: HTTP listener on http://{} (WebView)", local_addr));
                        if let Err(e) = axum::serve(listener, local_app).await {
                            log_to_file(&format!("HTTP serve error: {}", e));
                        }
                    }
                    Err(e) => {
                        log_to_file(&format!("FAILED to bind HTTP on {}: {}", local_addr, e));
                    }
                }
            });

            // HTTPS listener on 0.0.0.0 (for Tailscale/remote access)
            let tls_port = port + 1;
            let tls_addr = SocketAddr::from(([0, 0, 0, 0], tls_port));
            log_to_file(&format!("SUCCESS: HTTPS listener on https://0.0.0.0:{} (Tailscale)", tls_port));

            if let Err(e) = axum_server::bind_rustls(tls_addr, config)
                .serve(app.into_make_service())
                .await
            {
                log_to_file(&format!("Axum TLS serve error: {}", e));
                return Err(e.into());
            }
        }
        _ => {
            if tls_cert.is_some() || tls_key.is_some() {
                log_to_file("WARNING: Both ORG_VIEWER_TLS_CERT and ORG_VIEWER_TLS_KEY must be set for TLS. Falling back to HTTP.");
            }

            // Single HTTP listener on 0.0.0.0 (no TLS)
            let addr = SocketAddr::from(([0, 0, 0, 0], port));
            log_to_file(&format!("Attempting to bind to http://{}", addr));

            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => {
                    log_to_file(&format!("SUCCESS: Server listening on http://{}", addr));
                    l
                }
                Err(e) => {
                    log_to_file(&format!("FAILED to bind: {}", e));
                    return Err(e.into());
                }
            };

            log_to_file("Starting axum serve loop...");
            if let Err(e) = axum::serve(listener, app).await {
                log_to_file(&format!("Axum serve error: {}", e));
                return Err(e.into());
            }
        }
    }

    log_to_file("Server shut down normally");
    Ok(())
}
