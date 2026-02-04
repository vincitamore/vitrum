use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::server::{log_to_file, AppState};

#[derive(Serialize)]
pub struct HealthResponse {
    status: String,
    timestamp: String,
}

pub async fn health() -> Json<HealthResponse> {
    log_to_file("[server] /api/health endpoint hit");
    Json(HealthResponse {
        status: "ok".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

// Debug logging endpoint for frontend
#[derive(Deserialize)]
pub struct DebugLogRequest {
    msg: String,
}

pub async fn debug_log(Json(payload): Json<DebugLogRequest>) -> StatusCode {
    log_to_file(&payload.msg);
    StatusCode::OK
}

#[derive(Serialize)]
pub struct StatusResponse {
    server: ServerStats,
    documents: DocumentStats,
    tags: TagStats,
    recent: Vec<RecentDoc>,
}

#[derive(Serialize)]
pub struct ServerStats {
    uptime: u64,
    #[serde(rename = "connectedClients")]
    connected_clients: u32,
    #[serde(rename = "lastIndexed")]
    last_indexed: String,
}

#[derive(Serialize)]
pub struct DocumentStats {
    total: usize,
    #[serde(rename = "byType")]
    by_type: HashMap<String, usize>,
    #[serde(rename = "byStatus")]
    by_status: HashMap<String, usize>,
}

#[derive(Serialize)]
pub struct TagStats {
    total: usize,
    top: Vec<TagCount>,
}

#[derive(Serialize)]
pub struct TagCount {
    tag: String,
    count: usize,
}

#[derive(Serialize)]
pub struct RecentDoc {
    path: String,
    title: String,
    #[serde(rename = "type")]
    doc_type: String,
    updated: String,
}

pub async fn status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    log_to_file("[server] /api/status endpoint hit");
    let index = state.index.read().await;
    let stats = index.get_stats();
    let docs = index.get_documents();

    // Get tag counts
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    for doc in &docs {
        for tag in &doc.tags {
            *tag_counts.entry(tag.clone()).or_insert(0) += 1;
        }
    }
    let mut top_tags: Vec<TagCount> = tag_counts
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect();
    top_tags.sort_by(|a, b| b.count.cmp(&a.count));
    top_tags.truncate(10);

    // Get recent docs (sorted by updated date, take 5)
    let mut recent: Vec<RecentDoc> = docs
        .iter()
        .filter(|d| d.updated.is_some())
        .map(|d| RecentDoc {
            path: d.path.clone(),
            title: d.title.clone(),
            doc_type: d.doc_type.clone(),
            updated: d.updated.clone().unwrap_or_default(),
        })
        .collect();
    recent.sort_by(|a, b| b.updated.cmp(&a.updated));
    recent.truncate(5);

    Json(StatusResponse {
        server: ServerStats {
            uptime: state.start_time.elapsed().as_secs(),
            connected_clients: 1,
            last_indexed: chrono::Utc::now().to_rfc3339(),
        },
        documents: DocumentStats {
            total: stats.total,
            by_type: stats.by_type,
            by_status: stats.by_status,
        },
        tags: TagStats {
            total: top_tags.len(),
            top: top_tags,
        },
        recent,
    })
}

#[derive(Deserialize)]
pub struct ListFilesQuery {
    #[serde(rename = "type")]
    doc_type: Option<String>,
}

#[derive(Serialize)]
pub struct ListFilesResponse {
    count: usize,
    items: Vec<serde_json::Value>,
}

pub async fn list_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListFilesQuery>,
) -> Json<ListFilesResponse> {
    let index = state.index.read().await;
    let docs = index.get_documents();

    let items: Vec<serde_json::Value> = docs
        .into_iter()
        .filter(|d| {
            query
                .doc_type
                .as_ref()
                .map(|t| &d.doc_type == t)
                .unwrap_or(true)
        })
        .map(|d| serde_json::to_value(d).unwrap())
        .collect();

    Json(ListFilesResponse {
        count: items.len(),
        items,
    })
}

pub async fn get_file(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let index = state.index.read().await;

    if let Some(doc) = index.get_document_with_content(&path).await {
        Ok(Json(serde_json::to_value(doc).unwrap()))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

#[derive(Serialize)]
pub struct SearchResponse {
    query: String,
    count: usize,
    total: usize,
    items: Vec<serde_json::Value>,
}

pub async fn search(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Json<SearchResponse> {
    let index = state.index.read().await;
    let results = index.search(&query.q);

    let items: Vec<serde_json::Value> = results
        .into_iter()
        .map(|d| serde_json::to_value(d).unwrap())
        .collect();

    Json(SearchResponse {
        query: query.q,
        count: items.len(),
        total: items.len(),
        items,
    })
}

#[derive(Serialize)]
pub struct GraphResponse {
    nodes: Vec<GraphNode>,
    links: Vec<GraphLink>,
}

#[derive(Serialize)]
pub struct GraphNode {
    id: String,
    label: String,
    #[serde(rename = "type")]
    node_type: String,
    status: Option<String>,
    #[serde(rename = "linkCount")]
    link_count: usize,
}

#[derive(Serialize)]
pub struct GraphLink {
    source: String,
    target: String,
}

pub async fn graph(State(state): State<Arc<AppState>>) -> Json<GraphResponse> {
    let index = state.index.read().await;
    let docs = index.get_documents();

    // Build node map
    let node_map: HashMap<String, &_> = docs.iter().map(|d| (d.path.clone(), *d)).collect();

    let nodes: Vec<GraphNode> = docs
        .iter()
        .map(|d| GraphNode {
            id: d.path.clone(),
            label: d.title.clone(),
            node_type: d.doc_type.clone(),
            status: d.status.clone(),
            link_count: d.links.len() + d.backlinks.len(),
        })
        .collect();

    // Build links from backlinks
    let mut links: Vec<GraphLink> = Vec::new();
    for doc in docs {
        for backlink in &doc.backlinks {
            if node_map.contains_key(backlink) {
                links.push(GraphLink {
                    source: backlink.clone(),
                    target: doc.path.clone(),
                });
            }
        }
    }

    Json(GraphResponse { nodes, links })
}
