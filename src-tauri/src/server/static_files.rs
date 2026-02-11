use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../packages/client/dist"]
struct ClientDist;

/// Serve embedded static files, with SPA fallback to index.html
pub async fn static_handler(req: Request<Body>) -> impl IntoResponse {
    let path = req.uri().path().trim_start_matches('/');

    // Try the exact path first
    if let Some(file) = ClientDist::get(path) {
        return serve_file(path, &file.data);
    }

    // SPA fallback: serve index.html for non-file paths
    if let Some(file) = ClientDist::get("index.html") {
        return serve_file("index.html", &file.data);
    }

    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("Not Found"))
        .unwrap()
}

fn serve_file(path: &str, data: &[u8]) -> Response<Body> {
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();

    // Tiered cache-control: index.html always revalidates (picks up new hashed asset refs),
    // Vite-hashed assets are immutable, everything else gets a short cache.
    let cache_control = if path.ends_with(".html") || path == "index.html" {
        "no-cache" // Always revalidate — new hashed filenames in index.html
    } else if path.starts_with("assets/") {
        "public, max-age=31536000, immutable" // 1 year — Vite content-hashes filenames
    } else {
        "public, max-age=3600" // 1 hour — icons, manifest, service worker
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(data.to_vec()))
        .unwrap()
}
