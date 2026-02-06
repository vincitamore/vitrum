use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::server::sync::SyncService;
use crate::server::{log_to_file, AppState};

pub struct FileWatcher;

impl FileWatcher {
    pub async fn watch(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (tx, mut rx) = mpsc::channel(100);

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.blocking_send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_secs(2)),
        )?;

        watcher.watch(&state.org_root, RecursiveMode::Recursive)?;

        log_to_file(&format!("File watcher started for {:?}", state.org_root));

        // Keep watcher alive and process events
        while let Some(event) = rx.recv().await {
            Self::handle_event(&state, &event, None).await;
        }

        Ok(())
    }

    /// Watch with sync service integration — notifies sync service on file changes.
    pub async fn watch_with_sync(
        state: Arc<AppState>,
        sync_service: Arc<SyncService>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (tx, mut rx) = mpsc::channel(100);

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.blocking_send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_secs(2)),
        )?;

        watcher.watch(&state.org_root, RecursiveMode::Recursive)?;

        log_to_file(&format!(
            "File watcher started for {:?} (with sync)",
            state.org_root
        ));

        // Keep watcher alive and process events
        while let Some(event) = rx.recv().await {
            Self::handle_event(&state, &event, Some(&sync_service)).await;
        }

        Ok(())
    }

    async fn handle_event(
        state: &AppState,
        event: &Event,
        sync_service: Option<&Arc<SyncService>>,
    ) {
        use notify::EventKind;

        for path in &event.paths {
            // Only handle markdown files
            if !path.extension().map(|e| e == "md").unwrap_or(false) {
                continue;
            }

            // Skip excluded directories
            if Self::is_excluded(path, &state.org_root) {
                continue;
            }

            let relative_path = path
                .strip_prefix(&state.org_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    log_to_file(&format!("File changed: {}", relative_path));
                    let mut index = state.index.write().await;
                    index.refresh_document(path);

                    // Notify WebSocket clients
                    let msg = serde_json::json!({
                        "type": "update",
                        "path": relative_path,
                        "timestamp": chrono::Utc::now().timestamp_millis()
                    });
                    let _ = state.ws_tx.send(msg.to_string());

                    // Drop index lock before calling sync service
                    drop(index);

                    // Check if this is a federation-tracked document
                    if let Some(sync) = sync_service {
                        sync.handle_local_change(&relative_path).await;
                    }
                }
                EventKind::Remove(_) => {
                    log_to_file(&format!("File removed: {}", relative_path));
                    let mut index = state.index.write().await;
                    index.remove_document(path);

                    // Notify WebSocket clients
                    let msg = serde_json::json!({
                        "type": "remove",
                        "path": relative_path,
                        "timestamp": chrono::Utc::now().timestamp_millis()
                    });
                    let _ = state.ws_tx.send(msg.to_string());
                }
                _ => {}
            }
        }
    }

    fn is_excluded(path: &Path, org_root: &Path) -> bool {
        let relative = path.strip_prefix(org_root).unwrap_or(path);
        let path_str = relative.to_string_lossy();

        let excluded = [
            "node_modules",
            ".git",
            ".obsidian",
            "scratchpad",
            "dist",
            "build",
            ".next",
            "target",
        ];

        for exc in &excluded {
            if path_str.contains(exc) {
                return true;
            }
        }

        false
    }
}
