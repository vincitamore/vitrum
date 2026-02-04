pub mod document;
pub mod index;
pub mod routes;
pub mod watcher;

use axum::{routing::{get, post}, Router};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use index::DocumentIndex;
use watcher::FileWatcher;

pub fn log_to_file(msg: &str) {
    let log_path = env::temp_dir().join("org-viewer.log");
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
}

pub async fn start_server(org_root: PathBuf, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    log_to_file(&format!("start_server called with org_root={:?}, port={}", org_root, port));

    let start_time = std::time::Instant::now();

    // Build initial index
    log_to_file("Building document index...");
    let mut index = DocumentIndex::new(&org_root);
    index.build_index().await;
    log_to_file(&format!("Index built: {} documents", index.get_documents().len()));

    let state = Arc::new(AppState {
        index: Arc::new(RwLock::new(index)),
        org_root: org_root.clone(),
        start_time,
    });

    // Start file watcher
    log_to_file("Starting file watcher...");
    let watcher_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = FileWatcher::watch(watcher_state).await {
            log_to_file(&format!("File watcher error: {}", e));
        }
    });

    // CORS configuration
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let app = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/status", get(routes::status))
        .route("/api/files", get(routes::list_files))
        .route("/api/files/{*path}", get(routes::get_file))
        .route("/api/search", get(routes::search))
        .route("/api/graph", get(routes::graph))
        .route("/api/debug-log", post(routes::debug_log))
        .layer(cors)
        .with_state(state);

    log_to_file("File watcher spawned, now binding server...");

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
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

    log_to_file("Server shut down normally");
    Ok(())
}
