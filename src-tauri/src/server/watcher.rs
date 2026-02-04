use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::server::AppState;

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

        println!("File watcher started for {:?}", state.org_root);

        // Keep watcher alive and process events
        while let Some(event) = rx.recv().await {
            Self::handle_event(&state, &event).await;
        }

        Ok(())
    }

    async fn handle_event(state: &AppState, event: &Event) {
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

            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    println!("File changed: {:?}", path);
                    let mut index = state.index.write().await;
                    index.refresh_document(path);
                }
                EventKind::Remove(_) => {
                    println!("File removed: {:?}", path);
                    let mut index = state.index.write().await;
                    index.remove_document(path);
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
