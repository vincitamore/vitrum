#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::PathBuf;

// Tauri command for frontend logging (uses IPC, bypasses mixed content)
#[tauri::command]
fn frontend_log(msg: String) {
    log_to_file(&format!("[frontend] {}", msg));
}

// Tauri command to proxy API requests through Rust (bypasses browser restrictions)
#[tauri::command]
async fn api_request(path: String) -> Result<String, String> {
    log_to_file(&format!("[cmd] api_request called with path: {}", path));
    let url = format!("http://127.0.0.1:3847{}", path);

    match reqwest::get(&url).await {
        Ok(response) => match response.text().await {
            Ok(text) => {
                log_to_file(&format!("[cmd] api_request success, {} bytes", text.len()));
                Ok(text)
            }
            Err(e) => {
                log_to_file(&format!("[cmd] api_request body error: {}", e));
                Err(format!("Failed to read response: {}", e))
            }
        },
        Err(e) => {
            log_to_file(&format!("[cmd] api_request failed: {}", e));
            Err(format!("Request failed: {}", e))
        }
    }
}

// Tauri command to get current org root for display
#[tauri::command]
fn get_org_root() -> String {
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 {
        args[1].clone()
    } else {
        env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    }
}

// Simple file logger
fn log_to_file(msg: &str) {
    let log_path = env::temp_dir().join("vitrum.log");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] {}", timestamp, msg);
    }
}

/// Compute a short hash of the org root path for cache isolation
fn hash_path(path: &PathBuf) -> String {
    let mut hasher = DefaultHasher::new();
    // Canonicalize to handle . and .. and get absolute path
    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
    canonical.to_string_lossy().to_lowercase().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Clear WebView cache for this instance
fn clear_webview_cache(cache_dir: &PathBuf) {
    let ebwebview = cache_dir.join("EBWebView");
    if ebwebview.exists() {
        log_to_file(&format!("Clearing WebView cache at {:?}", ebwebview));
        if let Err(e) = std::fs::remove_dir_all(&ebwebview) {
            log_to_file(&format!("Failed to clear WebView cache: {}", e));
        } else {
            log_to_file("WebView cache cleared successfully");
        }
    }
}

fn main() {
    // Clear log file on start
    let log_path = env::temp_dir().join("vitrum.log");
    let _ = std::fs::write(&log_path, "");

    // Set up panic hook to log panics
    let log_path_clone = log_path.clone();
    std::panic::set_hook(Box::new(move |panic_info| {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path_clone)
        {
            let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
            let _ = writeln!(file, "[{}] PANIC: {}", timestamp, panic_info);
        }
    }));

    log_to_file("=== Vitrum Starting ===");
    log_to_file(&format!("Log file: {:?}", log_path));
    log_to_file(&format!("Args: {:?}", env::args().collect::<Vec<_>>()));
    log_to_file(&format!("CWD: {:?}", env::current_dir()));

    // Get org root from: 1) command line arg, 2) cwd
    let args: Vec<String> = env::args().collect();
    let org_root = if args.len() > 1 {
        PathBuf::from(&args[1])
    } else {
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };

    // Compute hash for cache isolation
    let path_hash = hash_path(&org_root);
    log_to_file(&format!("ORG_ROOT: {:?}", org_root));
    log_to_file(&format!("Path hash: {}", path_hash));

    // Set custom app data directory based on org root hash
    // This isolates WebView cache per org folder
    let base_data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("vitrum")
        .join(&path_hash);

    log_to_file(&format!("Data directory: {:?}", base_data_dir));

    // Ensure directory exists
    if let Err(e) = std::fs::create_dir_all(&base_data_dir) {
        log_to_file(&format!("Failed to create data dir: {}", e));
    }

    // Clear WebView cache on startup to ensure fresh state
    // This prevents stale cached API responses
    clear_webview_cache(&base_data_dir);

    // Set environment variable for Tauri to use custom data directory
    env::set_var("TAURI_DATA_DIRECTORY", &base_data_dir);

    let org_root_for_server = org_root.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![api_request, frontend_log, get_org_root])
        .setup(move |_app| {
            log_to_file("Tauri setup starting");
            log_to_file(&format!("ORG_ROOT exists: {}", org_root_for_server.exists()));

            // Start the embedded server in a background task
            let port = 3847u16;
            log_to_file(&format!("Starting server on port {}", port));

            let org_root_clone = org_root_for_server.clone();
            tauri::async_runtime::spawn(async move {
                log_to_file("Server task spawned");
                match server::start_server(org_root_clone, port).await {
                    Ok(()) => log_to_file("Server exited normally"),
                    Err(e) => log_to_file(&format!("Server error: {}", e)),
                }
            });

            log_to_file("Tauri setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
