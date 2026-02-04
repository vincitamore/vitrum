use crate::server::document::{parse_document, OrgDocument};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

const INDEX_FILENAME: &str = ".org-viewer-index.json";

/// Cached entry with modification time for incremental updates
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedEntry {
    pub document: OrgDocument,
    /// Unix timestamp (seconds since epoch) of file modification
    pub mtime_secs: u64,
}

/// Persisted index structure for serialization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedIndex {
    /// Version for future compatibility
    pub version: u32,
    /// Cached document entries keyed by relative path
    pub entries: HashMap<String, CachedEntry>,
}

impl Default for PersistedIndex {
    fn default() -> Self {
        Self {
            version: 1,
            entries: HashMap::new(),
        }
    }
}

pub struct DocumentIndex {
    org_root: PathBuf,
    documents: HashMap<String, OrgDocument>,
    /// Modification times for incremental updates
    mtimes: HashMap<String, u64>,
}

impl DocumentIndex {
    pub fn new(org_root: &Path) -> Self {
        Self {
            org_root: org_root.to_path_buf(),
            documents: HashMap::new(),
            mtimes: HashMap::new(),
        }
    }

    /// Get path to the persisted index file
    fn index_path(&self) -> PathBuf {
        self.org_root.join(INDEX_FILENAME)
    }

    /// Load persisted index from disk, or return None if not found/invalid
    fn load_persisted(&self) -> Option<PersistedIndex> {
        let path = self.index_path();
        if !path.exists() {
            return None;
        }

        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(index) => Some(index),
                Err(e) => {
                    println!("Failed to parse index cache: {}", e);
                    None
                }
            },
            Err(e) => {
                println!("Failed to read index cache: {}", e);
                None
            }
        }
    }

    /// Save current index to disk
    pub fn save_to_disk(&self) {
        let entries: HashMap<String, CachedEntry> = self
            .documents
            .iter()
            .filter_map(|(path, doc)| {
                self.mtimes.get(path).map(|&mtime_secs| {
                    (
                        path.clone(),
                        CachedEntry {
                            document: doc.clone(),
                            mtime_secs,
                        },
                    )
                })
            })
            .collect();

        let persisted = PersistedIndex {
            version: 1,
            entries,
        };

        match serde_json::to_string_pretty(&persisted) {
            Ok(json) => {
                if let Err(e) = std::fs::write(self.index_path(), json) {
                    println!("Failed to save index cache: {}", e);
                } else {
                    println!("Saved index cache ({} entries)", persisted.entries.len());
                }
            }
            Err(e) => println!("Failed to serialize index: {}", e),
        }
    }

    /// Get file modification time as unix timestamp
    fn get_mtime(path: &Path) -> Option<u64> {
        std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
    }

    /// Load from cache and incrementally update only changed files
    /// Returns (total_docs, cached_count, parsed_count, removed_count)
    pub async fn load_or_build(&mut self) -> (usize, usize, usize, usize) {
        let cached = self.load_persisted();

        // Collect all current markdown files with their mtimes
        let mut current_files: HashMap<String, u64> = HashMap::new();
        for entry in WalkDir::new(&self.org_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Self::should_exclude(e.path(), &self.org_root))
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.is_file() && path.extension().map(|e| e == "md").unwrap_or(false) {
                let relative = path
                    .strip_prefix(&self.org_root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");

                if let Some(mtime) = Self::get_mtime(path) {
                    current_files.insert(relative, mtime);
                }
            }
        }

        let mut cached_count = 0;
        let mut parsed_count = 0;
        let mut docs_to_parse: Vec<(PathBuf, String, u64)> = Vec::new();

        // Check each current file against cache
        for (rel_path, current_mtime) in &current_files {
            let full_path = self.org_root.join(rel_path);

            // Check if we have a valid cached entry
            let use_cache = cached.as_ref().map_or(false, |c| {
                c.entries.get(rel_path).map_or(false, |entry| {
                    entry.mtime_secs == *current_mtime
                })
            });

            if use_cache {
                // Use cached document
                if let Some(entry) = cached.as_ref().and_then(|c| c.entries.get(rel_path)) {
                    self.documents.insert(rel_path.clone(), entry.document.clone());
                    self.mtimes.insert(rel_path.clone(), entry.mtime_secs);
                    cached_count += 1;
                }
            } else {
                // Need to parse this file
                docs_to_parse.push((full_path, rel_path.clone(), *current_mtime));
            }
        }

        // Parse files that weren't in cache or were modified
        let mut newly_parsed: Vec<OrgDocument> = Vec::new();
        for (full_path, rel_path, mtime) in docs_to_parse {
            if let Ok(content) = tokio::fs::read_to_string(&full_path).await {
                let doc = parse_document(&full_path, &self.org_root, &content);
                self.mtimes.insert(rel_path.clone(), mtime);
                newly_parsed.push(doc);
                parsed_count += 1;
            }
        }

        // Add newly parsed documents
        for doc in newly_parsed {
            self.documents.insert(doc.path.clone(), doc);
        }

        // Count removed (files in cache but not on disk)
        let removed_count = cached.as_ref().map_or(0, |c| {
            c.entries.keys().filter(|p| !current_files.contains_key(*p)).count()
        });

        // Rebuild backlinks for all documents
        self.rebuild_backlinks();

        println!(
            "Index loaded: {} total ({} cached, {} parsed, {} removed)",
            self.documents.len(),
            cached_count,
            parsed_count,
            removed_count
        );

        // Save updated index
        self.save_to_disk();

        (self.documents.len(), cached_count, parsed_count, removed_count)
    }

    /// Rebuild backlinks across all documents
    fn rebuild_backlinks(&mut self) {
        // First, collect all links
        let links_map: HashMap<String, Vec<String>> = self
            .documents
            .iter()
            .map(|(path, doc)| (path.clone(), doc.links.clone()))
            .collect();

        // Clear existing backlinks
        for doc in self.documents.values_mut() {
            doc.backlinks.clear();
        }

        // Rebuild backlinks
        for (doc_path, doc) in self.documents.iter_mut() {
            let doc_name = Path::new(doc_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            for (other_path, other_links) in &links_map {
                if other_path != doc_path
                    && other_links
                        .iter()
                        .any(|link| link.to_lowercase() == doc_name.to_lowercase())
                {
                    doc.backlinks.push(other_path.clone());
                }
            }
        }
    }

    /// Full rebuild - clears everything and re-parses all files
    pub async fn build_index(&mut self) {
        self.documents.clear();
        self.mtimes.clear();
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

                    // Track mtime
                    let relative = path
                        .strip_prefix(&self.org_root)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    if let Some(mtime) = Self::get_mtime(path) {
                        self.mtimes.insert(relative, mtime);
                    }

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

        println!("Full index built: {} documents", self.documents.len());

        // Save to disk
        self.save_to_disk();
    }

    fn should_exclude(path: &Path, org_root: &Path) -> bool {
        let relative = path.strip_prefix(org_root).unwrap_or(path);
        let components: Vec<_> = relative.components().collect();

        if let Some(first) = components.first() {
            let name = first.as_os_str().to_string_lossy();
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
            // at the immediate project level (projects/<name>/CLAUDE.md or README.md)
            if name == "projects" {
                // Allow the projects directory itself and immediate subdirectories
                // But for files, only allow CLAUDE.md and README.md at project root
                if path.is_file() {
                    // Check if this is projects/<project>/CLAUDE.md or README.md
                    // components would be: ["projects", "<project-name>", "CLAUDE.md"]
                    if components.len() == 3 {
                        if let Some(filename) = path.file_name() {
                            let fname = filename.to_string_lossy();
                            if fname == "CLAUDE.md" || fname == "README.md" {
                                return false; // Allow these files
                            }
                        }
                    }
                    // Exclude all other files in projects/
                    return true;
                }
                // For directories inside projects/, exclude deeply nested ones
                // Allow: projects/, projects/<name>/
                // Exclude: projects/<name>/<anything>/
                if path.is_dir() && components.len() > 2 {
                    return true;
                }
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

            // Update mtime
            if let Some(mtime) = Self::get_mtime(path) {
                self.mtimes.insert(relative.clone(), mtime);
            }

            self.documents.insert(relative, doc);

            // Rebuild backlinks since links may have changed
            self.rebuild_backlinks();

            // Save updated index (debounce this in production)
            self.save_to_disk();
        }
    }

    pub fn remove_document(&mut self, path: &Path) {
        let relative = path
            .strip_prefix(&self.org_root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        self.documents.remove(&relative);
        self.mtimes.remove(&relative);

        // Rebuild backlinks since a document was removed
        self.rebuild_backlinks();

        // Save updated index
        self.save_to_disk();
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexStats {
    pub total: usize,
    pub by_type: HashMap<String, usize>,
    pub by_status: HashMap<String, usize>,
}
