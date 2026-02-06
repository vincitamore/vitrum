use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::server::index::DocumentIndex;
use crate::server::log_to_file;
use crate::server::peers::PeerRegistry;

const SYNC_POLL_INTERVAL_SECS: u64 = 60;

// --- Federation frontmatter types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationMeta {
    #[serde(rename = "origin-peer")]
    pub origin_peer: String,
    #[serde(rename = "origin-name")]
    pub origin_name: String,
    #[serde(rename = "origin-host")]
    pub origin_host: String,
    #[serde(rename = "origin-path")]
    pub origin_path: String,
    #[serde(rename = "adopted-at")]
    pub adopted_at: String,
    #[serde(rename = "origin-checksum")]
    pub origin_checksum: String,
    #[serde(rename = "local-checksum")]
    pub local_checksum: String,
    #[serde(rename = "sync-status")]
    pub sync_status: String,
    #[serde(rename = "last-sync-check")]
    pub last_sync_check: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SharedDocument {
    #[serde(rename = "localPath")]
    pub local_path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: String,
    pub tags: Vec<String>,
    pub federation: FederationMeta,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictDiff {
    #[serde(rename = "localContent")]
    pub local_content: String,
    #[serde(rename = "originContent")]
    pub origin_content: String,
    #[serde(rename = "baseContent")]
    pub base_content: String,
    #[serde(rename = "localChecksum")]
    pub local_checksum: String,
    #[serde(rename = "originChecksum")]
    pub origin_checksum: String,
}

/// Callback type for sync status changes
pub type SyncStatusCallback = Box<
    dyn Fn(SyncStatusEvent) + Send + Sync,
>;

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatusEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub path: String,
    #[serde(rename = "oldStatus")]
    pub old_status: String,
    #[serde(rename = "newStatus")]
    pub new_status: String,
    pub peer: Option<String>,
    pub timestamp: i64,
}

// --- SyncService ---

pub struct SyncService {
    org_root: PathBuf,
    index: Arc<RwLock<DocumentIndex>>,
    peer_registry: Arc<PeerRegistry>,
    on_status_change: RwLock<Option<SyncStatusCallback>>,
    local_host: RwLock<Option<(String, u16)>>,
}

impl SyncService {
    pub fn new(
        org_root: &Path,
        index: Arc<RwLock<DocumentIndex>>,
        peer_registry: Arc<PeerRegistry>,
    ) -> Self {
        SyncService {
            org_root: org_root.to_path_buf(),
            index,
            peer_registry,
            on_status_change: RwLock::new(None),
            local_host: RwLock::new(None),
        }
    }

    pub async fn set_local_host(&self, host: String, port: u16) {
        *self.local_host.write().await = Some((host, port));
    }

    pub async fn on_status_change(&self, callback: SyncStatusCallback) {
        *self.on_status_change.write().await = Some(callback);
    }

    /// Adopt a document from a peer: fetch, write locally with federation frontmatter.
    pub async fn adopt_document(
        &self,
        peer_id: &str,
        peer_host: &str,
        peer_port: u16,
        peer_protocol: &str,
        peer_name: &str,
        source_path: &str,
        target_path: Option<&str>,
    ) -> Result<(String, String), String> {
        let url = format!(
            "{}://{}:{}/api/federation/files/{}",
            peer_protocol, peer_host, peer_port, source_path
        );

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch from peer: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Peer returned {}", resp.status()));
        }

        let peer_doc: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse peer response: {}", e))?;

        let content = peer_doc["content"]
            .as_str()
            .ok_or("Missing content field")?;
        let checksum = peer_doc["checksum"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let local_path = target_path.unwrap_or(source_path);
        let full_local_path = self.org_root.join(local_path);

        // Ensure directory exists
        if let Some(dir) = full_local_path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        // Build federation frontmatter
        let now = chrono::Utc::now().to_rfc3339();
        let computed_checksum = if checksum.is_empty() {
            compute_checksum(content)
        } else {
            checksum.clone()
        };

        // Extract original frontmatter fields from peer doc
        let mut frontmatter_lines = vec!["---".to_string()];

        // Copy type, tags from peer doc frontmatter if present
        if let Some(fm) = peer_doc.get("frontmatter") {
            if let Some(t) = fm.get("type").and_then(|v| v.as_str()) {
                frontmatter_lines.push(format!("type: {}", t));
            }
            if let Some(status) = fm.get("status").and_then(|v| v.as_str()) {
                frontmatter_lines.push(format!("status: {}", status));
            }
            if let Some(created) = fm.get("created").and_then(|v| v.as_str()) {
                frontmatter_lines.push(format!("created: {}", created));
            }
            if let Some(tags) = fm.get("tags").and_then(|v| v.as_array()) {
                let tag_strs: Vec<String> = tags
                    .iter()
                    .filter_map(|t| t.as_str().map(String::from))
                    .collect();
                if tag_strs.is_empty() {
                    frontmatter_lines.push("tags: []".to_string());
                } else {
                    frontmatter_lines.push(format!("tags: [{}]", tag_strs.join(", ")));
                }
            }
        }

        // Add federation block
        frontmatter_lines.push("federation:".to_string());
        frontmatter_lines.push(format!("  origin-peer: '{}'", peer_id));
        frontmatter_lines.push(format!("  origin-name: '{}'", peer_name));
        frontmatter_lines.push(format!("  origin-host: '{}:{}'", peer_host, peer_port));
        frontmatter_lines.push(format!("  origin-path: '{}'", source_path));
        frontmatter_lines.push(format!("  adopted-at: '{}'", now));
        frontmatter_lines.push(format!("  origin-checksum: '{}'", computed_checksum));
        frontmatter_lines.push(format!("  local-checksum: '{}'", computed_checksum));
        frontmatter_lines.push("  sync-status: 'synced'".to_string());
        frontmatter_lines.push(format!("  last-sync-check: '{}'", now));
        frontmatter_lines.push("---".to_string());

        let full_content = format!("{}\n{}", frontmatter_lines.join("\n"), content);

        std::fs::write(&full_local_path, &full_content)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        log_to_file(&format!(
            "Adopted document: {} → {} (from {})",
            source_path, local_path, peer_name
        ));

        Ok((local_path.to_string(), computed_checksum))
    }

    /// Write an incoming document (sent by a peer) to the inbox.
    pub fn write_incoming_document(
        &self,
        from_instance_id: &str,
        from_display_name: &str,
        from_host: &str,
        title: &str,
        content: &str,
        tags: &[String],
        source_path: &str,
        message: Option<&str>,
    ) -> Result<String, String> {
        let timestamp = chrono::Utc::now()
            .format("%Y-%m-%dT%H-%M-%S")
            .to_string();
        let slug: String = title
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .chars()
            .take(50)
            .collect();
        let from_slug: String = from_display_name
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();

        let filename = format!("{}-from-{}-{}.md", timestamp, from_slug, slug);
        let inbox_path = self.org_root.join("inbox").join(&filename);

        // Ensure inbox dir exists
        if let Some(dir) = inbox_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }

        let tags_str = if tags.is_empty() {
            "[]".to_string()
        } else {
            format!(
                "[{}]",
                tags.iter()
                    .map(|t| format!("\"{}\"", t))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let frontmatter = format!(
            "---\ntype: inbox\ncreated: '{}'\nsource: peer\nfrom-name: {}\nfrom-instance: {}\nfrom-host: {}\noriginal-path: {}\ntags: {}\n---",
            chrono::Utc::now().format("%Y-%m-%d"),
            from_display_name,
            from_instance_id,
            from_host,
            source_path,
            tags_str,
        );

        let mut body = format!("# {}\n\n", title);
        if let Some(msg) = message {
            body.push_str(&format!(
                "> **Message from {}**: {}\n\n",
                from_display_name, msg
            ));
        }
        body.push_str(&format!(
            "*Shared from {} ({})*\n\n---\n\n{}",
            from_display_name, source_path, content
        ));

        let full = format!("{}\n{}", frontmatter, body);
        std::fs::write(&inbox_path, &full)
            .map_err(|e| format!("Failed to write inbox: {}", e))?;

        log_to_file(&format!(
            "Received document from {}: {}",
            from_display_name, filename
        ));

        Ok(format!("inbox/{}", filename))
    }

    /// Get all adopted (shared) documents by scanning files for federation frontmatter.
    pub async fn get_shared_documents(&self) -> Vec<SharedDocument> {
        let index = self.index.read().await;
        let docs = index.get_documents();
        let mut shared = Vec::new();

        for doc in docs {
            let full_path = self.org_root.join(&doc.path);
            if let Ok(content) = std::fs::read_to_string(&full_path) {
                if let Some(fed) = extract_federation_meta(&content) {
                    if !fed.origin_peer.is_empty() {
                        shared.push(SharedDocument {
                            local_path: doc.path.clone(),
                            title: doc.title.clone(),
                            doc_type: doc.doc_type.clone(),
                            tags: doc.tags.clone(),
                            federation: fed,
                        });
                    }
                }
            }
        }

        shared
    }

    /// Handle a local file change — check if it's a federation doc and update sync status.
    pub async fn handle_local_change(&self, path: &str) {
        let full_path = self.org_root.join(path);
        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => return,
        };

        let fed = match extract_federation_meta(&content) {
            Some(f) => f,
            None => return,
        };

        if fed.origin_peer.is_empty() || fed.sync_status == "rejected" {
            return;
        }

        // Extract body content (after frontmatter)
        let body = extract_body(&content);
        let current_checksum = compute_checksum(&body);

        if current_checksum != fed.local_checksum {
            let old_status = fed.sync_status.clone();
            let new_status = if old_status == "origin-modified" {
                "conflict"
            } else {
                "local-modified"
            };

            if old_status != new_status {
                self.update_federation_field(
                    path,
                    &[
                        ("local-checksum", &current_checksum),
                        ("sync-status", new_status),
                    ],
                );

                self.emit_status_change(SyncStatusEvent {
                    event_type: "sync-status-changed".to_string(),
                    path: path.to_string(),
                    old_status,
                    new_status: new_status.to_string(),
                    peer: Some(fed.origin_name.clone()),
                    timestamp: chrono::Utc::now().timestamp_millis(),
                })
                .await;
            }
        }
    }

    /// Start periodic origin-checksum polling.
    pub fn start_sync_polling(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(SYNC_POLL_INTERVAL_SECS));
            loop {
                interval.tick().await;
                service.check_all_origins().await;
            }
        })
    }

    async fn check_all_origins(&self) {
        let shared = self.get_shared_documents().await;
        if shared.is_empty() {
            return;
        }

        for doc in &shared {
            if doc.federation.sync_status == "rejected" {
                continue;
            }
            self.check_origin_checksum(&doc.local_path, &doc.federation)
                .await;
        }
    }

    async fn check_origin_checksum(&self, local_path: &str, fed: &FederationMeta) {
        let origin_host = &fed.origin_host;
        let origin_path = &fed.origin_path;

        // Find peer
        let peers = self.peer_registry.get_peer_status().await;
        let parts: Vec<&str> = origin_host.split(':').collect();
        let host = parts[0];
        let port: u16 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(3847);

        let peer = peers
            .iter()
            .find(|p| p.host == host && p.port == port);

        let peer = match peer {
            Some(p) if p.status == "online" => p,
            _ => return,
        };

        let url = format!(
            "{}://{}:{}/api/federation/files/{}?checksumOnly=true",
            peer.protocol, peer.host, peer.port, origin_path
        );

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap_or_default();

        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    let remote_checksum = data["checksum"].as_str().unwrap_or("");

                    if remote_checksum != fed.origin_checksum {
                        let old_status = fed.sync_status.clone();
                        let new_status = if old_status == "local-modified" {
                            "conflict"
                        } else {
                            "origin-modified"
                        };

                        if old_status != new_status {
                            let now = chrono::Utc::now().to_rfc3339();
                            self.update_federation_field(
                                local_path,
                                &[
                                    ("origin-checksum", remote_checksum),
                                    ("sync-status", new_status),
                                    ("last-sync-check", &now),
                                ],
                            );

                            self.emit_status_change(SyncStatusEvent {
                                event_type: "sync-status-changed".to_string(),
                                path: local_path.to_string(),
                                old_status,
                                new_status: new_status.to_string(),
                                peer: Some(fed.origin_name.clone()),
                                timestamp: chrono::Utc::now().timestamp_millis(),
                            })
                            .await;

                            log_to_file(&format!(
                                "Sync: {} → {} (origin changed)",
                                local_path, new_status
                            ));
                        }
                    } else {
                        // Just update last-sync-check
                        let now = chrono::Utc::now().to_rfc3339();
                        self.update_federation_field(
                            local_path,
                            &[("last-sync-check", &now)],
                        );
                    }
                }
            }
            _ => {
                // Origin unreachable, skip silently
            }
        }
    }

    /// Get 3-way diff for conflict resolution.
    pub async fn get_conflict_diff(&self, local_path: &str) -> Option<ConflictDiff> {
        let full_path = self.org_root.join(local_path);
        let content = std::fs::read_to_string(&full_path).ok()?;
        let fed = extract_federation_meta(&content)?;

        let origin_host = &fed.origin_host;
        let origin_path = &fed.origin_path;

        let parts: Vec<&str> = origin_host.split(':').collect();
        let host = parts[0];
        let port: u16 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(3847);

        let peers = self.peer_registry.get_peer_status().await;
        let peer = peers
            .iter()
            .find(|p| p.host == host && p.port == port && p.status == "online")?;

        let url = format!(
            "{}://{}:{}/api/federation/files/{}",
            peer.protocol, peer.host, peer.port, origin_path
        );

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .danger_accept_invalid_certs(true)
            .build()
            .ok()?;

        let resp = client.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }

        let origin_doc: serde_json::Value = resp.json().await.ok()?;
        let origin_content = origin_doc["content"].as_str().unwrap_or("");
        let origin_checksum = origin_doc["checksum"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let local_body = extract_body(&content);
        let local_checksum = compute_checksum(&local_body);

        Some(ConflictDiff {
            local_content: local_body,
            origin_content: origin_content.to_string(),
            base_content: String::new(),
            local_checksum,
            origin_checksum,
        })
    }

    /// Resolve a sync conflict.
    pub async fn resolve_conflict(
        &self,
        local_path: &str,
        action: &str,
        merged_content: Option<&str>,
        comment: Option<&str>,
    ) -> bool {
        let full_path = self.org_root.join(local_path);
        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => return false,
        };

        let fed = match extract_federation_meta(&content) {
            Some(f) => f,
            None => return false,
        };

        let now = chrono::Utc::now().to_rfc3339();

        match action {
            "accept-origin" => {
                let diff = match self.get_conflict_diff(local_path).await {
                    Some(d) => d,
                    None => return false,
                };

                // Replace content after frontmatter
                let fm_end = find_frontmatter_end(&content);
                let new_file = format!("{}\n{}", &content[..fm_end], diff.origin_content);
                let _ = std::fs::write(&full_path, &new_file);

                self.update_federation_field(
                    local_path,
                    &[
                        ("local-checksum", &diff.origin_checksum),
                        ("origin-checksum", &diff.origin_checksum),
                        ("sync-status", "synced"),
                        ("last-sync-check", &now),
                    ],
                );
            }
            "keep-local" => {
                self.update_federation_field(
                    local_path,
                    &[("sync-status", "synced"), ("last-sync-check", &now)],
                );
            }
            "merge" => {
                let merged = match merged_content {
                    Some(c) => c,
                    None => return false,
                };

                let fm_end = find_frontmatter_end(&content);
                let new_file = format!("{}\n{}", &content[..fm_end], merged);
                let _ = std::fs::write(&full_path, &new_file);

                let new_checksum = compute_checksum(merged);
                self.update_federation_field(
                    local_path,
                    &[
                        ("local-checksum", &new_checksum),
                        ("sync-status", "synced"),
                        ("last-sync-check", &now),
                    ],
                );
            }
            "reject" => {
                self.update_federation_field(local_path, &[("sync-status", "rejected")]);

                // Send rejection comment back to origin
                if let Some(cmt) = comment {
                    let origin_host = &fed.origin_host;
                    let parts: Vec<&str> = origin_host.split(':').collect();
                    let host = parts[0];
                    let port: u16 =
                        parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(3847);

                    let peers = self.peer_registry.get_peer_status().await;
                    if let Some(peer) = peers.iter().find(|p| {
                        p.host == host && p.port == port && p.status == "online"
                    }) {
                        let self_info = self.peer_registry.get_self().await;
                        let local_host = self.local_host.read().await;
                        let host_str = local_host
                            .as_ref()
                            .map(|(h, p)| format!("{}:{}", h, p))
                            .unwrap_or_else(|| "unknown".to_string());

                        let url = format!(
                            "{}://{}:{}/api/federation/shared/respond",
                            peer.protocol, peer.host, peer.port
                        );

                        let body = serde_json::json!({
                            "from": {
                                "instanceId": self_info.instance_id,
                                "displayName": self_info.display_name,
                                "host": host_str,
                            },
                            "action": "rejected",
                            "originalPath": fed.origin_path,
                            "comment": cmt,
                        });

                        let client = reqwest::Client::builder()
                            .timeout(std::time::Duration::from_secs(5))
                            .danger_accept_invalid_certs(true)
                            .build()
                            .unwrap_or_default();

                        let _ = client
                            .post(&url)
                            .json(&body)
                            .send()
                            .await;
                    }
                }
            }
            _ => return false,
        }

        true
    }

    /// Update specific federation fields in a document's frontmatter.
    fn update_federation_field(&self, local_path: &str, updates: &[(&str, &str)]) {
        let full_path = self.org_root.join(local_path);
        if !full_path.exists() {
            return;
        }

        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => return,
        };

        let mut result = content;
        for (key, value) in updates {
            // Simple regex replace in federation YAML block
            let pattern = format!(r"({}:)\s*'[^']*'", regex::escape(key));
            if let Ok(re) = regex::Regex::new(&pattern) {
                let replacement = format!("${{1}} '{}'", value.replace('\'', "''"));
                result = re.replace_all(&result, replacement.as_str()).to_string();
            }
        }

        let _ = std::fs::write(&full_path, &result);
    }

    async fn emit_status_change(&self, event: SyncStatusEvent) {
        let cb = self.on_status_change.read().await;
        if let Some(callback) = cb.as_ref() {
            callback(event);
        }
    }
}

// --- Utility functions ---

pub fn compute_checksum(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let result = hasher.finalize();
    format!("sha256:{:x}", result)
}

/// Extract federation metadata from raw file content by parsing the YAML block.
pub fn extract_federation_meta(content: &str) -> Option<FederationMeta> {
    // Find the federation block in frontmatter
    let fm = extract_frontmatter(content)?;

    if !fm.contains("federation:") {
        return None;
    }

    // Find the federation section and parse its fields
    let mut in_fed = false;
    let mut origin_peer = String::new();
    let mut origin_name = String::new();
    let mut origin_host = String::new();
    let mut origin_path = String::new();
    let mut adopted_at = String::new();
    let mut origin_checksum = String::new();
    let mut local_checksum = String::new();
    let mut sync_status = String::new();
    let mut last_sync_check = String::new();

    for line in fm.lines() {
        let trimmed = line.trim();
        if trimmed == "federation:" {
            in_fed = true;
            continue;
        }

        if in_fed {
            // Check if we've left the federation block (non-indented line)
            if !line.starts_with(' ') && !line.starts_with('\t') && !trimmed.is_empty() {
                break;
            }

            if let Some((key, value)) = parse_yaml_field(trimmed) {
                match key.as_str() {
                    "origin-peer" => origin_peer = value,
                    "origin-name" => origin_name = value,
                    "origin-host" => origin_host = value,
                    "origin-path" => origin_path = value,
                    "adopted-at" => adopted_at = value,
                    "origin-checksum" => origin_checksum = value,
                    "local-checksum" => local_checksum = value,
                    "sync-status" => sync_status = value,
                    "last-sync-check" => last_sync_check = value,
                    _ => {}
                }
            }
        }
    }

    if origin_peer.is_empty() {
        return None;
    }

    Some(FederationMeta {
        origin_peer,
        origin_name,
        origin_host,
        origin_path,
        adopted_at,
        origin_checksum,
        local_checksum,
        sync_status,
        last_sync_check,
    })
}

/// Extract frontmatter string from markdown content.
fn extract_frontmatter(content: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }
    let rest = &content[3..];
    let end = rest.find("---")?;
    Some(rest[..end].to_string())
}

/// Extract body content (after frontmatter) from markdown.
fn extract_body(content: &str) -> String {
    let end = find_frontmatter_end(content);
    let body = &content[end..];
    // Trim leading newline
    if body.starts_with('\n') {
        body[1..].to_string()
    } else {
        body.to_string()
    }
}

/// Find the byte offset of the end of frontmatter (after closing ---).
fn find_frontmatter_end(content: &str) -> usize {
    if !content.starts_with("---") {
        return 0;
    }
    let rest = &content[3..];
    match rest.find("---") {
        Some(idx) => 3 + idx + 3, // skip opening "---" + content + closing "---"
        None => 0,
    }
}

/// Parse a simple YAML field line like "  key: 'value'" or "  key: value"
fn parse_yaml_field(line: &str) -> Option<(String, String)> {
    let colon_idx = line.find(':')?;
    let key = line[..colon_idx].trim().to_string();
    let value = line[colon_idx + 1..].trim().to_string();

    // Strip quotes
    let value = if (value.starts_with('\'') && value.ends_with('\''))
        || (value.starts_with('"') && value.ends_with('"'))
    {
        value[1..value.len() - 1].to_string()
    } else {
        value
    };

    Some((key, value))
}
