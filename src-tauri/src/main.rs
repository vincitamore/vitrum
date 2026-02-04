#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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
        Ok(response) => {
            match response.text().await {
                Ok(text) => {
                    log_to_file(&format!("[cmd] api_request success, {} bytes", text.len()));
                    Ok(text)
                }
                Err(e) => {
                    log_to_file(&format!("[cmd] api_request body error: {}", e));
                    Err(format!("Failed to read response: {}", e))
                }
            }
        }
        Err(e) => {
            log_to_file(&format!("[cmd] api_request failed: {}", e));
            Err(format!("Request failed: {}", e))
        }
    }
}

// Simple file logger
fn log_to_file(msg: &str) {
    let log_path = env::temp_dir().join("org-viewer.log");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] {}", timestamp, msg);
    }
}

fn main() {
    // Clear log file on start
    let log_path = env::temp_dir().join("org-viewer.log");
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

    log_to_file(&format!("=== Org Viewer Starting ==="));
    log_to_file(&format!("Log file: {:?}", log_path));
    log_to_file(&format!("Args: {:?}", env::args().collect::<Vec<_>>()));
    log_to_file(&format!("CWD: {:?}", env::current_dir()));

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![api_request, frontend_log])
        .setup(|_app| {
            log_to_file("Tauri setup starting");

            // Get org root from: 1) command line arg, 2) cwd
            let args: Vec<String> = env::args().collect();
            let org_root = if args.len() > 1 {
                PathBuf::from(&args[1])
            } else {
                env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            };

            log_to_file(&format!("ORG_ROOT: {:?}", org_root));
            log_to_file(&format!("ORG_ROOT exists: {}", org_root.exists()));

            // Start the embedded server in a background task
            let port = 3847u16;
            log_to_file(&format!("Starting server on port {}", port));

            tauri::async_runtime::spawn(async move {
                log_to_file("Server task spawned");
                match server::start_server(org_root, port).await {
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
