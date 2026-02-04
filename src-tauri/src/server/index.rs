use crate::server::document::{parse_document, OrgDocument};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub struct DocumentIndex {
    org_root: PathBuf,
    documents: HashMap<String, OrgDocument>,
}

impl DocumentIndex {
    pub fn new(org_root: &Path) -> Self {
        Self {
            org_root: org_root.to_path_buf(),
            documents: HashMap::new(),
        }
    }

    pub async fn build_index(&mut self) {
        self.documents.clear();
        let mut docs: Vec<OrgDocument> = Vec::new();

        // Walk the directory
        for entry in WalkDir::new(&self.org_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Self::should_exclude(e.path(), &self.org_root))
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.is_file() && path.extension().map(|e| e == "md").unwrap_or(false) {
                if let Ok(content) = tokio::fs::read_to_string(path).await {
                    let doc = parse_document(path, &self.org_root, &content);
                    docs.push(doc);
                }
            }
        }

        // Build backlinks
        let links_map: HashMap<String, Vec<String>> = docs
            .iter()
            .map(|d| (d.path.clone(), d.links.clone()))
            .collect();

        for doc in &mut docs {
            let doc_name = Path::new(&doc.path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            for (other_path, other_links) in &links_map {
                if other_path != &doc.path
                    && other_links
                        .iter()
                        .any(|link| link.to_lowercase() == doc_name.to_lowercase())
                {
                    doc.backlinks.push(other_path.clone());
                }
            }
        }

        // Store in hashmap
        for doc in docs {
            self.documents.insert(doc.path.clone(), doc);
        }

        println!("Indexed {} documents", self.documents.len());
    }

    fn should_exclude(path: &Path, org_root: &Path) -> bool {
        let relative = path.strip_prefix(org_root).unwrap_or(path);
        let first_component = relative.components().next();

        if let Some(component) = first_component {
            let name = component.as_os_str().to_string_lossy();
            let excluded = [
                "node_modules",
                ".git",
                ".obsidian",
                "scratchpad",
                "dist",
                "build",
                ".next",
                "target",
                "x", // Twitter archive
            ];

            if excluded.contains(&name.as_ref()) {
                return true;
            }

            // Handle projects folder specially - only index CLAUDE.md and README.md
            if name == "projects" && path.is_dir() {
                // We'll handle this in the filter logic
            }
        }

        // Skip hidden files/dirs (except .obsidian which we already excluded)
        if let Some(name) = path.file_name() {
            let name = name.to_string_lossy();
            if name.starts_with('.') && name != ".obsidian" {
                return true;
            }
        }

        false
    }

    pub fn get_documents(&self) -> Vec<&OrgDocument> {
        self.documents.values().collect()
    }

    pub fn get_document(&self, path: &str) -> Option<&OrgDocument> {
        self.documents.get(path)
    }

    pub async fn get_document_with_content(&self, path: &str) -> Option<OrgDocument> {
        let doc = self.documents.get(path)?;
        let mut doc = doc.clone();

        let full_path = self.org_root.join(path);
        if let Ok(content) = tokio::fs::read_to_string(&full_path).await {
            doc.content = Some(content);
        }

        Some(doc)
    }

    pub fn search(&self, query: &str) -> Vec<&OrgDocument> {
        use fuzzy_matcher::skim::SkimMatcherV2;
        use fuzzy_matcher::FuzzyMatcher;

        let matcher = SkimMatcherV2::default();
        let query_lower = query.to_lowercase();

        let mut results: Vec<(&OrgDocument, i64)> = self
            .documents
            .values()
            .filter_map(|doc| {
                // Search in title
                let title_score = matcher.fuzzy_match(&doc.title, &query_lower).unwrap_or(0);

                // Search in path
                let path_score = matcher.fuzzy_match(&doc.path, &query_lower).unwrap_or(0);

                // Search in tags
                let tag_score: i64 = doc
                    .tags
                    .iter()
                    .filter_map(|tag| matcher.fuzzy_match(tag, &query_lower))
                    .max()
                    .unwrap_or(0);

                let total_score = title_score * 3 + path_score + tag_score * 2;

                if total_score > 0 {
                    Some((doc, total_score))
                } else {
                    None
                }
            })
            .collect();

        results.sort_by(|a, b| b.1.cmp(&a.1));
        results.into_iter().map(|(doc, _)| doc).take(50).collect()
    }

    pub fn get_stats(&self) -> IndexStats {
        let mut by_type: HashMap<String, usize> = HashMap::new();
        let mut by_status: HashMap<String, usize> = HashMap::new();

        for doc in self.documents.values() {
            *by_type.entry(doc.doc_type.clone()).or_insert(0) += 1;
            if let Some(status) = &doc.status {
                *by_status.entry(status.clone()).or_insert(0) += 1;
            }
        }

        IndexStats {
            total: self.documents.len(),
            by_type,
            by_status,
        }
    }

    pub fn refresh_document(&mut self, path: &Path) {
        let relative = path
            .strip_prefix(&self.org_root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        if let Ok(content) = std::fs::read_to_string(path) {
            let doc = parse_document(path, &self.org_root, &content);
            self.documents.insert(relative, doc);
        }
    }

    pub fn remove_document(&mut self, path: &Path) {
        let relative = path
            .strip_prefix(&self.org_root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        self.documents.remove(&relative);
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexStats {
    pub total: usize,
    pub by_type: HashMap<String, usize>,
    pub by_status: HashMap<String, usize>,
}
