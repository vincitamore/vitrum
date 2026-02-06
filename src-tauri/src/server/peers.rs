use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::server::log_to_file;

const PEER_CONFIG_FILE: &str = ".org-viewer-peers.json";
const POLL_INTERVAL_SECS: u64 = 30;
const BACKOFF_INTERVAL_SECS: u64 = 120;
const FAILURE_THRESHOLD: u32 = 3;
const HELLO_TIMEOUT_SECS: u64 = 3;

// --- Config types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerConfig {
    #[serde(rename = "self")]
    pub self_info: PeerSelf,
    pub peers: Vec<PeerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerSelf {
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "sharedFolders")]
    pub shared_folders: Vec<String>,
    #[serde(rename = "sharedTags")]
    pub shared_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerEntry {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub protocol: String,
}

// --- Live status ---

#[derive(Debug, Clone, Serialize)]
pub struct PeerLiveStatus {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub protocol: String,
    pub status: String, // "online" | "offline" | "unknown"
    #[serde(rename = "instanceId", skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(rename = "sharedFolders", skip_serializing_if = "Option::is_none")]
    pub shared_folders: Option<Vec<String>>,
    #[serde(rename = "sharedTags", skip_serializing_if = "Option::is_none")]
    pub shared_tags: Option<Vec<String>>,
    #[serde(rename = "documentCount", skip_serializing_if = "Option::is_none")]
    pub document_count: Option<usize>,
    #[serde(rename = "lastSeen", skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    #[serde(rename = "latencyMs", skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(rename = "consecutiveFailures")]
    pub consecutive_failures: u32,
}

// --- Hello response (from remote peer) ---

#[derive(Debug, Deserialize)]
pub struct PeerHelloResponse {
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "sharedFolders")]
    pub shared_folders: Vec<String>,
    #[serde(rename = "sharedTags")]
    pub shared_tags: Vec<String>,
    pub stats: PeerHelloStats,
}

#[derive(Debug, Deserialize)]
pub struct PeerHelloStats {
    #[serde(rename = "documentCount")]
    pub document_count: usize,
}

// --- PeerRegistry ---

pub struct PeerRegistry {
    config_path: PathBuf,
    config: RwLock<PeerConfig>,
    status: RwLock<HashMap<String, PeerLiveStatus>>,
    last_config_mtime: RwLock<u64>,
}

impl PeerRegistry {
    pub fn new(org_root: &Path) -> Self {
        let config_path = org_root.join(PEER_CONFIG_FILE);
        let config = Self::load_or_create(&config_path);
        let status = Self::init_status(&config);

        PeerRegistry {
            config_path,
            config: RwLock::new(config),
            status: RwLock::new(status),
            last_config_mtime: RwLock::new(0),
        }
    }

    fn load_or_create(path: &Path) -> PeerConfig {
        if path.exists() {
            if let Ok(raw) = std::fs::read_to_string(path) {
                if let Ok(config) = serde_json::from_str::<PeerConfig>(&raw) {
                    return config;
                }
                log_to_file(&format!("Failed to parse {}", PEER_CONFIG_FILE));
            }
        }

        let config = PeerConfig {
            self_info: PeerSelf {
                instance_id: Uuid::new_v4().to_string(),
                display_name: "My Org".to_string(),
                shared_folders: vec!["knowledge/".to_string()],
                shared_tags: vec![],
            },
            peers: vec![],
        };

        if let Ok(json) = serde_json::to_string_pretty(&config) {
            let _ = std::fs::write(path, json);
            log_to_file(&format!(
                "Created {} with instanceId: {}",
                PEER_CONFIG_FILE, config.self_info.instance_id
            ));
        }

        config
    }

    fn init_status(config: &PeerConfig) -> HashMap<String, PeerLiveStatus> {
        let mut map = HashMap::new();
        for peer in &config.peers {
            let key = format!("{}:{}", peer.host, peer.port);
            map.insert(
                key,
                PeerLiveStatus {
                    name: peer.name.clone(),
                    host: peer.host.clone(),
                    port: peer.port,
                    protocol: peer.protocol.clone(),
                    status: "unknown".to_string(),
                    instance_id: None,
                    display_name: None,
                    shared_folders: None,
                    shared_tags: None,
                    document_count: None,
                    last_seen: None,
                    latency_ms: None,
                    consecutive_failures: 0,
                },
            );
        }
        map
    }

    pub async fn get_self(&self) -> PeerSelf {
        self.config.read().await.self_info.clone()
    }

    pub async fn get_peers(&self) -> Vec<PeerEntry> {
        self.config.read().await.peers.clone()
    }

    pub async fn get_peer_status(&self) -> Vec<PeerLiveStatus> {
        self.status.read().await.values().cloned().collect()
    }

    pub async fn get_online_peers(&self) -> Vec<PeerLiveStatus> {
        self.status
            .read()
            .await
            .values()
            .filter(|p| p.status == "online")
            .cloned()
            .collect()
    }

    /// Start background peer polling task. Returns a JoinHandle.
    pub fn start_polling(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            // Initial poll
            registry.poll_all_peers().await;

            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(POLL_INTERVAL_SECS));
            loop {
                interval.tick().await;
                registry.poll_all_peers().await;
            }
        })
    }

    async fn poll_all_peers(&self) {
        self.check_config_reload().await;

        let peers = self.config.read().await.peers.clone();
        let mut handles = Vec::new();

        for peer in peers {
            let key = format!("{}:{}", peer.host, peer.port);

            // Check backoff
            let should_skip = {
                let status = self.status.read().await;
                if let Some(s) = status.get(&key) {
                    if s.consecutive_failures >= FAILURE_THRESHOLD {
                        if let Some(last) = &s.last_seen {
                            if let Ok(last_time) = chrono::DateTime::parse_from_rfc3339(last) {
                                let elapsed = chrono::Utc::now()
                                    .signed_duration_since(last_time)
                                    .num_seconds();
                                elapsed < BACKOFF_INTERVAL_SECS as i64
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    true // no status entry, skip
                }
            };

            if should_skip {
                continue;
            }

            handles.push(self.poll_peer(peer));
        }

        futures::future::join_all(handles).await;
    }

    async fn poll_peer(&self, peer: PeerEntry) {
        let key = format!("{}:{}", peer.host, peer.port);
        let url = format!(
            "{}://{}:{}/api/federation/hello",
            peer.protocol, peer.host, peer.port
        );

        let start = std::time::Instant::now();

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(HELLO_TIMEOUT_SECS))
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap_or_default();

        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(data) = resp.json::<PeerHelloResponse>().await {
                    let latency = start.elapsed().as_millis() as u64;
                    let mut status = self.status.write().await;
                    if let Some(s) = status.get_mut(&key) {
                        let was_offline = s.status != "online";
                        s.status = "online".to_string();
                        s.instance_id = Some(data.instance_id);
                        s.display_name = Some(data.display_name);
                        s.shared_folders = Some(data.shared_folders);
                        s.shared_tags = Some(data.shared_tags);
                        s.document_count = Some(data.stats.document_count);
                        s.last_seen = Some(chrono::Utc::now().to_rfc3339());
                        s.latency_ms = Some(latency);
                        s.consecutive_failures = 0;

                        if was_offline {
                            log_to_file(&format!("Peer {} ({}): online", peer.name, key));
                        }
                    }
                }
            }
            _ => {
                let mut status = self.status.write().await;
                if let Some(s) = status.get_mut(&key) {
                    let was_online = s.status == "online";
                    s.consecutive_failures += 1;
                    s.status = "offline".to_string();

                    if was_online {
                        log_to_file(&format!("Peer {} ({}): offline", peer.name, key));
                    }
                }
            }
        }
    }

    async fn check_config_reload(&self) {
        let mtime = std::fs::metadata(&self.config_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mut last = self.last_config_mtime.write().await;
        if mtime > *last {
            if *last > 0 {
                // Config changed — reload
                let new_config = Self::load_or_create(&self.config_path);
                let old_count = self.config.read().await.peers.len();
                let new_count = new_config.peers.len();

                // Reconcile status map
                let new_keys: std::collections::HashSet<String> = new_config
                    .peers
                    .iter()
                    .map(|p| format!("{}:{}", p.host, p.port))
                    .collect();

                {
                    let mut status = self.status.write().await;
                    // Add new peers
                    for peer in &new_config.peers {
                        let key = format!("{}:{}", peer.host, peer.port);
                        if !status.contains_key(&key) {
                            status.insert(
                                key,
                                PeerLiveStatus {
                                    name: peer.name.clone(),
                                    host: peer.host.clone(),
                                    port: peer.port,
                                    protocol: peer.protocol.clone(),
                                    status: "unknown".to_string(),
                                    instance_id: None,
                                    display_name: None,
                                    shared_folders: None,
                                    shared_tags: None,
                                    document_count: None,
                                    last_seen: None,
                                    latency_ms: None,
                                    consecutive_failures: 0,
                                },
                            );
                        }
                    }
                    // Remove peers no longer in config
                    status.retain(|k, _| new_keys.contains(k));
                }

                *self.config.write().await = new_config;

                if old_count != new_count {
                    log_to_file(&format!(
                        "Peer config hot-reloaded: {} → {} peers",
                        old_count, new_count
                    ));
                }
            }
            *last = mtime;
        }
    }
}
