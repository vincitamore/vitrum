use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::server::log_to_file;
use crate::server::sync::compute_checksum;
use crate::server::FederationState;

// --- Request/Response types ---

#[derive(Serialize)]
struct HelloResponse {
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "apiVersion")]
    api_version: String,
    #[serde(rename = "sharedFolders")]
    shared_folders: Vec<String>,
    #[serde(rename = "sharedTags")]
    shared_tags: Vec<String>,
    stats: HelloStats,
    online: bool,
    uptime: u64,
}

#[derive(Serialize)]
struct HelloStats {
    #[serde(rename = "documentCount")]
    document_count: usize,
    #[serde(rename = "knowledgeCount")]
    knowledge_count: usize,
    #[serde(rename = "taskCount")]
    task_count: usize,
}

#[derive(Serialize)]
struct PeersResponse {
    #[serde(rename = "self")]
    self_info: PeersSelfInfo,
    peers: Vec<crate::server::peers::PeerLiveStatus>,
}

#[derive(Serialize)]
struct PeersSelfInfo {
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    host: String,
    port: u16,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    #[serde(rename = "type")]
    doc_type: Option<String>,
    tag: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct SearchResponse {
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    query: String,
    count: usize,
    items: Vec<SearchItem>,
}

#[derive(Serialize)]
struct SearchItem {
    path: String,
    title: String,
    #[serde(rename = "type")]
    doc_type: String,
    tags: Vec<String>,
    score: i64,
    snippet: String,
}

#[derive(Deserialize)]
struct FilesQuery {
    folder: Option<String>,
    tag: Option<String>,
}

#[derive(Serialize)]
struct FilesResponse {
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    count: usize,
    items: Vec<FileListItem>,
}

#[derive(Serialize)]
struct FileListItem {
    path: String,
    title: String,
    #[serde(rename = "type")]
    doc_type: String,
    tags: Vec<String>,
    created: Option<String>,
    updated: Option<String>,
}

#[derive(Deserialize)]
struct SingleFileQuery {
    #[serde(rename = "checksumOnly")]
    checksum_only: Option<String>,
}

#[derive(Serialize)]
struct SingleFileResponse {
    path: String,
    title: String,
    #[serde(rename = "type")]
    doc_type: String,
    tags: Vec<String>,
    content: String,
    frontmatter: serde_json::Value,
    created: Option<String>,
    updated: Option<String>,
    links: Vec<String>,
    backlinks: Vec<String>,
    checksum: String,
}

#[derive(Serialize)]
struct ChecksumResponse {
    checksum: String,
    updated: Option<String>,
}

#[derive(Deserialize)]
struct CrossSearchQuery {
    q: Option<String>,
    #[serde(rename = "type")]
    doc_type: Option<String>,
    tag: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct CrossSearchResponse {
    query: String,
    results: Vec<CrossSearchResult>,
    #[serde(rename = "totalPeersQueried")]
    total_peers_queried: usize,
    #[serde(rename = "totalPeersResponded")]
    total_peers_responded: usize,
    #[serde(rename = "peerResults")]
    peer_results: HashMap<String, PeerSearchStats>,
}

#[derive(Serialize)]
struct CrossSearchResult {
    peer: String,
    #[serde(rename = "peerId")]
    peer_id: String,
    #[serde(rename = "peerHost")]
    peer_host: String,
    path: String,
    title: String,
    #[serde(rename = "type")]
    doc_type: String,
    tags: Vec<String>,
    score: f64,
    snippet: String,
}

#[derive(Serialize)]
struct PeerSearchStats {
    count: usize,
    took: u64,
}

#[derive(Deserialize)]
struct CrossFilesQuery {
    peer: Option<String>,
    folder: Option<String>,
    tag: Option<String>,
}

#[derive(Deserialize)]
struct CrossFileQuery {
    peer: Option<String>,
    #[serde(rename = "checksumOnly")]
    checksum_only: Option<String>,
}

#[derive(Deserialize)]
struct AdoptRequest {
    #[serde(rename = "peerId")]
    peer_id: String,
    #[serde(rename = "peerHost")]
    peer_host: String,
    #[serde(rename = "sourcePath")]
    source_path: String,
    #[serde(rename = "targetPath")]
    target_path: Option<String>,
}

#[derive(Deserialize)]
struct SendRequest {
    #[serde(rename = "peerHost")]
    peer_host: String,
    #[serde(rename = "sourcePath")]
    source_path: String,
    message: Option<String>,
}

#[derive(Deserialize)]
struct ReceiveRequest {
    from: ReceiveFrom,
    document: ReceiveDocument,
    message: Option<String>,
}

#[derive(Deserialize)]
struct ReceiveFrom {
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    host: String,
}

#[derive(Deserialize)]
struct ReceiveDocument {
    title: String,
    content: String,
    tags: Option<Vec<String>>,
    #[serde(rename = "sourcePath")]
    source_path: String,
}

#[derive(Deserialize)]
struct ResolveRequest {
    path: Option<String>,
    action: Option<String>,
    #[serde(rename = "mergedContent")]
    merged_content: Option<String>,
    comment: Option<String>,
}

#[derive(Deserialize)]
struct RespondRequest {
    from: ReceiveFrom,
    action: String,
    #[serde(rename = "originalPath")]
    original_path: String,
    comment: Option<String>,
}

#[derive(Deserialize)]
struct DiffQuery {
    path: Option<String>,
}

// --- Build federation router ---

pub fn create_federation_routes() -> Router<Arc<FederationState>> {
    Router::new()
        .route("/hello", get(hello))
        .route("/peers", get(peers))
        .route("/search", get(search))
        .route("/files", get(list_files))
        .route("/files/{*path}", get(get_file))
        .route("/cross-search", get(cross_search))
        .route("/cross-files", get(cross_files))
        .route("/cross-file/{*path}", get(cross_file))
        .route("/adopt", post(adopt))
        .route("/send", post(send))
        .route("/receive", post(receive))
        .route("/shared", get(shared))
        .route("/shared/diff", get(shared_diff))
        .route("/shared/resolve", post(shared_resolve))
        .route("/shared/respond", post(shared_respond))
}

// --- Handlers ---

async fn hello(State(state): State<Arc<FederationState>>) -> Json<HelloResponse> {
    let self_info = state.peer_registry.get_self().await;
    let index = state.app_state.index.read().await;
    let docs = index.get_documents();

    let doc_count = docs.len();
    let knowledge_count = docs.iter().filter(|d| d.doc_type == "knowledge").count();
    let task_count = docs.iter().filter(|d| d.doc_type == "task").count();

    Json(HelloResponse {
        instance_id: self_info.instance_id,
        display_name: self_info.display_name,
        api_version: "1".to_string(),
        shared_folders: self_info.shared_folders,
        shared_tags: self_info.shared_tags,
        stats: HelloStats {
            document_count: doc_count,
            knowledge_count,
            task_count,
        },
        online: true,
        uptime: state.app_state.start_time.elapsed().as_secs(),
    })
}

async fn peers(State(state): State<Arc<FederationState>>) -> Json<PeersResponse> {
    let self_info = state.peer_registry.get_self().await;
    let local = state.local_host.read().await;
    let (host, port) = local
        .as_ref()
        .map(|(h, p)| (h.clone(), *p))
        .unwrap_or(("localhost".to_string(), 3847));

    Json(PeersResponse {
        self_info: PeersSelfInfo {
            instance_id: self_info.instance_id,
            display_name: self_info.display_name,
            host,
            port,
        },
        peers: state.peer_registry.get_peer_status().await,
    })
}

async fn search(
    State(state): State<Arc<FederationState>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<SearchResponse>, StatusCode> {
    let q = query.q.as_deref().unwrap_or("");
    if q.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let self_info = state.peer_registry.get_self().await;
    let index = state.app_state.index.read().await;

    let results = index.search(q);
    let limit = query.limit.unwrap_or(20);

    // Filter to shared folders only
    let items: Vec<SearchItem> = results
        .into_iter()
        .filter(|doc| {
            self_info
                .shared_folders
                .iter()
                .any(|f| doc.path.starts_with(f))
        })
        .filter(|doc| {
            query
                .doc_type
                .as_ref()
                .map(|t| doc.doc_type == *t)
                .unwrap_or(true)
        })
        .filter(|doc| {
            query
                .tag
                .as_ref()
                .map(|t| doc.tags.contains(t))
                .unwrap_or(true)
        })
        .take(limit)
        .map(|doc| {
            // Read content for snippet
            let full_path = state.app_state.org_root.join(&doc.path);
            let content = std::fs::read_to_string(&full_path).unwrap_or_default();
            let snippet = extract_snippet(&content, q, 100);

            SearchItem {
                path: doc.path.clone(),
                title: doc.title.clone(),
                doc_type: doc.doc_type.clone(),
                tags: doc.tags.clone(),
                score: 0,
                snippet,
            }
        })
        .collect();

    Ok(Json(SearchResponse {
        instance_id: self_info.instance_id,
        display_name: self_info.display_name,
        query: q.to_string(),
        count: items.len(),
        items,
    }))
}

async fn list_files(
    State(state): State<Arc<FederationState>>,
    Query(query): Query<FilesQuery>,
) -> Json<FilesResponse> {
    let self_info = state.peer_registry.get_self().await;
    let index = state.app_state.index.read().await;
    let docs = index.get_documents();

    let items: Vec<FileListItem> = docs
        .into_iter()
        .filter(|d| {
            self_info
                .shared_folders
                .iter()
                .any(|f| d.path.starts_with(f))
        })
        .filter(|d| {
            query
                .folder
                .as_ref()
                .map(|f| d.path.starts_with(f))
                .unwrap_or(true)
        })
        .filter(|d| {
            query
                .tag
                .as_ref()
                .map(|t| d.tags.contains(t))
                .unwrap_or(true)
        })
        .map(|d| FileListItem {
            path: d.path.clone(),
            title: d.title.clone(),
            doc_type: d.doc_type.clone(),
            tags: d.tags.clone(),
            created: d.created.clone(),
            updated: d.updated.clone(),
        })
        .collect();

    Json(FilesResponse {
        instance_id: self_info.instance_id,
        display_name: self_info.display_name,
        count: items.len(),
        items,
    })
}

async fn get_file(
    State(state): State<Arc<FederationState>>,
    Path(path): Path<String>,
    Query(query): Query<SingleFileQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let self_info = state.peer_registry.get_self().await;

    // Check if path is within shared folders
    let is_shared = self_info
        .shared_folders
        .iter()
        .any(|f| path.starts_with(f));
    if !is_shared {
        return Err(StatusCode::FORBIDDEN);
    }

    let index = state.app_state.index.read().await;
    let doc = index.get_document(&path).ok_or(StatusCode::NOT_FOUND)?;

    // Read file content
    let full_path = state.app_state.org_root.join(&path);
    let content = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    // Parse body (after frontmatter)
    let body = extract_body_from_content(&content);

    // Support checksumOnly
    if query.checksum_only.as_deref() == Some("true") {
        let checksum = compute_checksum(&body);
        return Ok(Json(serde_json::json!({
            "checksum": checksum,
            "updated": doc.updated,
        })));
    }

    let checksum = compute_checksum(&body);

    // Parse frontmatter as generic value
    let frontmatter = parse_frontmatter_as_value(&content);

    Ok(Json(serde_json::json!({
        "path": doc.path,
        "title": doc.title,
        "type": doc.doc_type,
        "tags": doc.tags,
        "content": body,
        "frontmatter": frontmatter,
        "created": doc.created,
        "updated": doc.updated,
        "links": doc.links,
        "backlinks": doc.backlinks,
        "checksum": checksum,
    })))
}

async fn cross_search(
    State(state): State<Arc<FederationState>>,
    Query(query): Query<CrossSearchQuery>,
) -> Result<Json<CrossSearchResponse>, StatusCode> {
    let q = query.q.as_deref().unwrap_or("");
    if q.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let limit = query.limit.unwrap_or(20);
    let online_peers = state.peer_registry.get_online_peers().await;

    let mut all_results: Vec<CrossSearchResult> = Vec::new();
    let mut peer_results: HashMap<String, PeerSearchStats> = HashMap::new();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_default();

    let mut handles = Vec::new();

    for peer in &online_peers {
        let mut params = vec![("q", q.to_string()), ("limit", limit.to_string())];
        if let Some(ref t) = query.doc_type {
            params.push(("type", t.clone()));
        }
        if let Some(ref t) = query.tag {
            params.push(("tag", t.clone()));
        }

        let url = format!(
            "{}://{}:{}/api/federation/search",
            peer.protocol, peer.host, peer.port
        );

        let client = client.clone();
        let peer_name = peer.name.clone();
        let peer_host = format!("{}:{}", peer.host, peer.port);

        handles.push(tokio::spawn(async move {
            let start = std::time::Instant::now();
            let resp = client.get(&url).query(&params).send().await;
            let took = start.elapsed().as_millis() as u64;

            match resp {
                Ok(r) if r.status().is_success() => {
                    if let Ok(data) = r.json::<serde_json::Value>().await {
                        let items = data["items"].as_array().cloned().unwrap_or_default();
                        let count = items.len();
                        let display = data["displayName"]
                            .as_str()
                            .unwrap_or(&peer_name)
                            .to_string();
                        let inst_id = data["instanceId"].as_str().unwrap_or("").to_string();

                        let results: Vec<CrossSearchResult> = items
                            .iter()
                            .filter_map(|item| {
                                Some(CrossSearchResult {
                                    peer: display.clone(),
                                    peer_id: inst_id.clone(),
                                    peer_host: peer_host.clone(),
                                    path: item["path"].as_str()?.to_string(),
                                    title: item["title"].as_str()?.to_string(),
                                    doc_type: item["type"].as_str()?.to_string(),
                                    tags: item["tags"]
                                        .as_array()
                                        .map(|a| {
                                            a.iter()
                                                .filter_map(|v| v.as_str().map(String::from))
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                    score: item["score"].as_f64().unwrap_or(0.0),
                                    snippet: item["snippet"].as_str().unwrap_or("").to_string(),
                                })
                            })
                            .collect();

                        (peer_name, count, took, results)
                    } else {
                        (peer_name, 0, took, vec![])
                    }
                }
                _ => (peer_name, 0, 0, vec![]),
            }
        }));
    }

    for handle in handles {
        if let Ok((name, count, took, results)) = handle.await {
            peer_results.insert(name, PeerSearchStats { count, took });
            all_results.extend(results);
        }
    }

    // Sort by score descending
    all_results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    all_results.truncate(limit);

    let responded = peer_results.len();

    Ok(Json(CrossSearchResponse {
        query: q.to_string(),
        results: all_results,
        total_peers_queried: online_peers.len(),
        total_peers_responded: responded,
        peer_results,
    }))
}

async fn cross_files(
    State(state): State<Arc<FederationState>>,
    Query(query): Query<CrossFilesQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let peer_host = query.peer.as_deref().ok_or(StatusCode::BAD_REQUEST)?;

    let parts: Vec<&str> = peer_host.split(':').collect();
    let host = parts[0];
    let port: u16 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(3847);

    let peers = state.peer_registry.get_peer_status().await;
    let peer = peers
        .iter()
        .find(|p| p.host == host && p.port == port && p.status == "online")
        .ok_or(StatusCode::NOT_FOUND)?;

    let mut params = Vec::new();
    if let Some(ref f) = query.folder {
        params.push(("folder", f.as_str()));
    }
    if let Some(ref t) = query.tag {
        params.push(("tag", t.as_str()));
    }

    let url = format!(
        "{}://{}:{}/api/federation/files",
        peer.protocol, peer.host, peer.port
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_default();

    let resp = client
        .get(&url)
        .query(&params)
        .send()
        .await
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?;

    if !resp.status().is_success() {
        return Err(StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));
    }

    let data: serde_json::Value = resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(data))
}

async fn cross_file(
    State(state): State<Arc<FederationState>>,
    Path(path): Path<String>,
    Query(query): Query<CrossFileQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let peer_host = query.peer.as_deref().ok_or(StatusCode::BAD_REQUEST)?;

    let parts: Vec<&str> = peer_host.split(':').collect();
    let host = parts[0];
    let port: u16 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(3847);

    let peers = state.peer_registry.get_peer_status().await;
    let peer = peers
        .iter()
        .find(|p| p.host == host && p.port == port && p.status == "online")
        .ok_or(StatusCode::NOT_FOUND)?;

    let mut params = Vec::new();
    if query.checksum_only.as_deref() == Some("true") {
        params.push(("checksumOnly", "true"));
    }

    let url = format!(
        "{}://{}:{}/api/federation/files/{}",
        peer.protocol, peer.host, peer.port, path
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_default();

    let resp = client
        .get(&url)
        .query(&params)
        .send()
        .await
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?;

    if !resp.status().is_success() {
        return Err(StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));
    }

    let data: serde_json::Value = resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(data))
}

async fn adopt(
    State(state): State<Arc<FederationState>>,
    Json(body): Json<AdoptRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let parts: Vec<&str> = body.peer_host.split(':').collect();
    let host = parts[0];
    let port: u16 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(3847);

    let peers = state.peer_registry.get_peer_status().await;
    let peer = peers
        .iter()
        .find(|p| p.host == host && p.port == port && p.status == "online")
        .ok_or(StatusCode::NOT_FOUND)?;

    match state
        .sync_service
        .adopt_document(
            &body.peer_id,
            host,
            peer.port,
            &peer.protocol,
            peer.display_name.as_deref().unwrap_or(&peer.name),
            &body.source_path,
            body.target_path.as_deref(),
        )
        .await
    {
        Ok((local_path, checksum)) => Ok(Json(serde_json::json!({
            "success": true,
            "localPath": local_path,
            "checksum": checksum,
        }))),
        Err(e) => {
            log_to_file(&format!("Adoption failed: {}", e));
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn send(
    State(state): State<Arc<FederationState>>,
    Json(body): Json<SendRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let index = state.app_state.index.read().await;
    let doc = index
        .get_document(&body.source_path)
        .ok_or(StatusCode::NOT_FOUND)?;

    let self_info = state.peer_registry.get_self().await;
    let local = state.local_host.read().await;
    let host_str = local
        .as_ref()
        .map(|(h, p)| format!("{}:{}", h, p))
        .unwrap_or_else(|| "localhost:3847".to_string());

    let parts: Vec<&str> = body.peer_host.split(':').collect();
    let host = parts[0];
    let port: u16 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(3847);

    let peers = state.peer_registry.get_peer_status().await;
    let peer = peers
        .iter()
        .find(|p| p.host == host && p.port == port && p.status == "online")
        .ok_or(StatusCode::NOT_FOUND)?;

    // Read file content
    let full_path = state.app_state.org_root.join(&doc.path);
    let content = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let body_content = extract_body_from_content(&content);

    let url = format!(
        "{}://{}:{}/api/federation/receive",
        peer.protocol, peer.host, peer.port
    );

    let payload = serde_json::json!({
        "from": {
            "instanceId": self_info.instance_id,
            "displayName": self_info.display_name,
            "host": host_str,
        },
        "document": {
            "title": doc.title,
            "content": body_content,
            "tags": doc.tags,
            "sourcePath": doc.path,
        },
        "message": body.message,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_default();

    match client.post(&url).json(&payload).send().await {
        Ok(resp) if resp.status().is_success() => Ok(Json(serde_json::json!({
            "success": true,
            "sentTo": peer.display_name.as_deref().unwrap_or(&peer.name),
        }))),
        _ => Err(StatusCode::BAD_GATEWAY),
    }
}

async fn receive(
    State(state): State<Arc<FederationState>>,
    Json(body): Json<ReceiveRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let tags = body.document.tags.unwrap_or_default();

    match state.sync_service.write_incoming_document(
        &body.from.instance_id,
        &body.from.display_name,
        &body.from.host,
        &body.document.title,
        &body.document.content,
        &tags,
        &body.document.source_path,
        body.message.as_deref(),
    ) {
        Ok(inbox_path) => Ok(Json(serde_json::json!({
            "accepted": true,
            "inboxPath": inbox_path,
        }))),
        Err(e) => {
            log_to_file(&format!("Failed to write incoming document: {}", e));
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn shared(State(state): State<Arc<FederationState>>) -> Json<serde_json::Value> {
    let shared = state.sync_service.get_shared_documents().await;
    Json(serde_json::json!({
        "count": shared.len(),
        "items": shared,
    }))
}

async fn shared_diff(
    State(state): State<Arc<FederationState>>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let path = query.path.as_deref().ok_or(StatusCode::BAD_REQUEST)?;

    match state.sync_service.get_conflict_diff(path).await {
        Some(diff) => Ok(Json(serde_json::to_value(diff).unwrap())),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn shared_resolve(
    State(state): State<Arc<FederationState>>,
    Json(body): Json<ResolveRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let path = body.path.as_deref().ok_or(StatusCode::BAD_REQUEST)?;
    let action = body.action.as_deref().ok_or(StatusCode::BAD_REQUEST)?;

    let valid = ["accept-origin", "keep-local", "merge", "reject"];
    if !valid.contains(&action) {
        return Err(StatusCode::BAD_REQUEST);
    }

    if action == "merge" && body.merged_content.is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let success = state
        .sync_service
        .resolve_conflict(
            path,
            action,
            body.merged_content.as_deref(),
            body.comment.as_deref(),
        )
        .await;

    if success {
        Ok(Json(serde_json::json!({
            "success": true,
            "path": path,
            "action": action,
        })))
    } else {
        Err(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

async fn shared_respond(
    State(state): State<Arc<FederationState>>,
    Json(body): Json<RespondRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if body.action == "rejected" {
        if let Some(comment) = &body.comment {
            let _ = state.sync_service.write_incoming_document(
                &body.from.instance_id,
                &body.from.display_name,
                &body.from.host,
                &format!(
                    "Federation: {} {} your update",
                    body.from.display_name, body.action
                ),
                &format!(
                    "**Document**: {}\n**Action**: {}\n**Comment**: {}",
                    body.original_path, body.action, comment
                ),
                &["federation".to_string(), "resolution".to_string()],
                &body.original_path,
                Some(comment.as_str()),
            );
        }
    }

    Ok(Json(serde_json::json!({ "accepted": true })))
}

// --- Utility functions ---

fn extract_snippet(content: &str, query: &str, context_length: usize) -> String {
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();

    match lower_content.find(&lower_query) {
        Some(idx) => {
            let start = idx.saturating_sub(context_length);
            let end = std::cmp::min(content.len(), idx + query.len() + context_length);
            let mut snippet = content[start..end].to_string();
            if start > 0 {
                snippet = format!("...{}", snippet);
            }
            if end < content.len() {
                snippet = format!("{}...", snippet);
            }
            snippet
        }
        None => {
            let end = std::cmp::min(content.len(), context_length * 2);
            let mut snippet = content[..end].to_string();
            if end < content.len() {
                snippet.push_str("...");
            }
            snippet
        }
    }
}

fn extract_body_from_content(content: &str) -> String {
    if !content.starts_with("---") {
        return content.to_string();
    }
    let rest = &content[3..];
    match rest.find("---") {
        Some(idx) => {
            let after = &rest[idx + 3..];
            if after.starts_with('\n') {
                after[1..].to_string()
            } else {
                after.to_string()
            }
        }
        None => content.to_string(),
    }
}

fn parse_frontmatter_as_value(content: &str) -> serde_json::Value {
    if !content.starts_with("---") {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    let rest = &content[3..];
    let end = match rest.find("---") {
        Some(idx) => idx,
        None => return serde_json::Value::Object(serde_json::Map::new()),
    };

    let fm_str = &rest[..end];

    // Use gray_matter for proper parsing
    let full = format!("---{}---\n", fm_str);
    let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
    let result = matter.parse(&full);

    match result.data {
        Some(data) => {
            // Convert gray_matter Pod to serde_json::Value
            pod_to_json(&data)
        }
        None => serde_json::Value::Object(serde_json::Map::new()),
    }
}

fn pod_to_json(pod: &gray_matter::Pod) -> serde_json::Value {
    match pod {
        gray_matter::Pod::Null => serde_json::Value::Null,
        gray_matter::Pod::Boolean(b) => serde_json::Value::Bool(*b),
        gray_matter::Pod::Integer(i) => serde_json::json!(i),
        gray_matter::Pod::Float(f) => serde_json::json!(f),
        gray_matter::Pod::String(s) => serde_json::Value::String(s.clone()),
        gray_matter::Pod::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(pod_to_json).collect())
        }
        gray_matter::Pod::Hash(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                obj.insert(k.clone(), pod_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
    }
}
