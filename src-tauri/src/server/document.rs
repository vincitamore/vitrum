use gray_matter::{engine::YAML, Matter};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgDocument {
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: String,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub links: Vec<String>,
    pub backlinks: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Frontmatter {
    #[serde(rename = "type")]
    doc_type: Option<String>,
    status: Option<String>,
    tags: Option<Vec<String>>,
    created: Option<String>,
    updated: Option<String>,
}

pub fn parse_document(path: &Path, org_root: &Path, content: &str) -> OrgDocument {
    let matter = Matter::<YAML>::new();
    let result = matter.parse(content);

    // Parse frontmatter
    let frontmatter: Frontmatter = result
        .data
        .and_then(|d| d.deserialize().ok())
        .unwrap_or_default();

    // Extract title from first heading or filename
    let title = extract_title(content, path);

    // Extract wikilinks
    let links = extract_wikilinks(content);

    // Infer document type
    let doc_type = infer_type(&frontmatter.doc_type, path, org_root);

    // Get relative path
    let relative_path = path
        .strip_prefix(org_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");

    OrgDocument {
        path: relative_path,
        title,
        doc_type,
        status: frontmatter.status,
        tags: frontmatter.tags.unwrap_or_default(),
        created: frontmatter.created,
        updated: frontmatter.updated,
        links,
        backlinks: Vec::new(), // Populated later
        content: None,
    }
}

fn extract_title(content: &str, path: &Path) -> String {
    // Try to find first H1 heading
    let heading_re = Regex::new(r"^#\s+(.+)$").unwrap();
    for line in content.lines() {
        if let Some(caps) = heading_re.captures(line) {
            return caps[1].to_string();
        }
    }

    // Fall back to filename without extension
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".to_string())
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let link_re = Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap();
    link_re
        .captures_iter(content)
        .map(|cap| cap[1].to_string())
        .collect()
}

fn infer_type(frontmatter_type: &Option<String>, path: &Path, org_root: &Path) -> String {
    // Check frontmatter first
    if let Some(t) = frontmatter_type {
        let t = t.to_lowercase();
        match t.as_str() {
            "task" => return "task".to_string(),
            "knowledge" => return "knowledge".to_string(),
            "inbox" => return "inbox".to_string(),
            "project" => return "project".to_string(),
            "tag-index" | "tag" => return "tag".to_string(),
            _ => {}
        }
    }

    // Infer from path
    let relative = path
        .strip_prefix(org_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");

    let first_dir = relative.split('/').next().unwrap_or("");

    match first_dir {
        "tasks" => "task".to_string(),
        "knowledge" => "knowledge".to_string(),
        "inbox" => "inbox".to_string(),
        "projects" => "project".to_string(),
        "tags" => "tag".to_string(),
        _ => "other".to_string(),
    }
}
