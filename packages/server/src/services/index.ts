import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import Fuse from 'fuse.js';
import { parseDocument } from './parser';
import type { OrgDocument, GraphResponse } from '../types';

export class DocumentIndex {
  private documents: Map<string, OrgDocument> = new Map();
  private fuse: Fuse<OrgDocument> | null = null;
  private orgRoot: string;
  private lastIndexed: Date = new Date();

  constructor(orgRoot: string) {
    this.orgRoot = orgRoot;
  }

  async buildIndex(): Promise<void> {
    this.documents.clear();
    const mdFiles = this.findMarkdownFiles(this.orgRoot);

    for (const filePath of mdFiles) {
      try {
        const doc = parseDocument(filePath, this.orgRoot);
        this.documents.set(doc.path, doc);
      } catch (e) {
        console.error(`Failed to parse ${filePath}:`, e);
      }
    }

    // Compute backlinks
    this.computeBacklinks();

    // Build search index
    this.buildSearchIndex();

    this.lastIndexed = new Date();
    console.log(`Indexed ${this.documents.size} documents`);
  }

  // Directories to completely exclude from indexing
  private static EXCLUDED_DIRS = new Set([
    'node_modules',
    'scratchpad',
    'dist',
    'build',
    '.git',
  ]);

  // Files to index from project directories (shallow - no recursion)
  private static PROJECT_INDEX_FILES = new Set([
    'CLAUDE.md',
    'README.md',
  ]);

  private findMarkdownFiles(dir: string, files: string[] = [], depth = 0): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const dirName = dir.split(/[/\\]/).pop();

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Skip hidden files/folders and excluded directories
      if (entry.name.startsWith('.') || DocumentIndex.EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        // Special handling for projects/ - only index CLAUDE.md and README.md from each project
        if (entry.name === 'projects' && depth === 0) {
          this.findProjectFiles(fullPath, files);
        } else {
          this.findMarkdownFiles(fullPath, files, depth + 1);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // Index only CLAUDE.md and README.md from each project subdirectory
  private findProjectFiles(projectsDir: string, files: string[]): void {
    const entries = readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(projectsDir, entry.name);

      if (entry.isDirectory()) {
        // This is a project folder - only index specific files
        for (const indexFile of DocumentIndex.PROJECT_INDEX_FILES) {
          const filePath = join(fullPath, indexFile);
          try {
            const stat = statSync(filePath);
            if (stat.isFile()) {
              files.push(filePath);
            }
          } catch {
            // File doesn't exist, skip
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Also index any .md files directly in projects/ (like README.md)
        files.push(fullPath);
      }
    }
  }

  private computeBacklinks(): void {
    // First pass: collect all links
    const linkMap = new Map<string, string[]>();

    for (const [path, doc] of this.documents) {
      for (const link of doc.links) {
        // Normalize link to path
        const targetPath = this.resolveLink(link);
        if (targetPath) {
          if (!linkMap.has(targetPath)) {
            linkMap.set(targetPath, []);
          }
          linkMap.get(targetPath)!.push(path);
        }
      }
    }

    // Second pass: assign backlinks
    for (const [path, backlinks] of linkMap) {
      const doc = this.documents.get(path);
      if (doc) {
        doc.backlinks = backlinks;
      }
    }
  }

  private resolveLink(link: string): string | null {
    // Try exact match
    if (this.documents.has(link)) {
      return link;
    }

    // Try with .md extension
    if (this.documents.has(link + '.md')) {
      return link + '.md';
    }

    // Try matching by title or filename
    for (const [path, doc] of this.documents) {
      const filename = path.split('/').pop()?.replace('.md', '');
      if (
        filename?.toLowerCase() === link.toLowerCase() ||
        doc.title.toLowerCase() === link.toLowerCase()
      ) {
        return path;
      }
    }

    return null;
  }

  private buildSearchIndex(): void {
    const docs = Array.from(this.documents.values());

    this.fuse = new Fuse(docs, {
      keys: [
        { name: 'title', weight: 2 },
        { name: 'content', weight: 1 },
        { name: 'tags', weight: 1.5 },
      ],
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true,
    });
  }

  updateDocument(filePath: string): void {
    try {
      const doc = parseDocument(filePath, this.orgRoot);
      this.documents.set(doc.path, doc);
      this.computeBacklinks();
      this.buildSearchIndex();
      console.log(`Updated: ${doc.path}`);
    } catch (e) {
      console.error(`Failed to update ${filePath}:`, e);
    }
  }

  removeDocument(relativePath: string): void {
    this.documents.delete(relativePath);
    this.computeBacklinks();
    this.buildSearchIndex();
    console.log(`Removed: ${relativePath}`);
  }

  getAll(): OrgDocument[] {
    return Array.from(this.documents.values());
  }

  get(path: string): OrgDocument | undefined {
    return this.documents.get(path);
  }

  search(
    query: string,
    filters?: { type?: string; tag?: string }
  ): Array<{ item: OrgDocument; score: number }> {
    if (!this.fuse) return [];

    let results = this.fuse.search(query);

    // Apply filters
    if (filters?.type) {
      results = results.filter(r => r.item.type === filters.type);
    }
    if (filters?.tag) {
      results = results.filter(r => r.item.tags.includes(filters.tag));
    }

    return results.map(r => ({
      item: r.item,
      score: r.score ?? 0,
    }));
  }

  getGraph(): GraphResponse {
    const nodes: GraphResponse['nodes'] = [];
    const links: GraphResponse['links'] = [];

    for (const [path, doc] of this.documents) {
      nodes.push({
        id: path,
        label: doc.title,
        type: doc.type,
        status: doc.status,
        linkCount: doc.links.length + doc.backlinks.length,
      });

      for (const link of doc.links) {
        const targetPath = this.resolveLink(link);
        if (targetPath && this.documents.has(targetPath)) {
          links.push({
            source: path,
            target: targetPath,
          });
        }
      }
    }

    return { nodes, links };
  }

  getStats() {
    return {
      documentCount: this.documents.size,
      lastIndexed: this.lastIndexed.toISOString(),
    };
  }
}
