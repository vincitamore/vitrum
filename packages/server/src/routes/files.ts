import { Hono } from 'hono';
import type { DocumentIndex } from '../services/index';
import type { OrgDocument, FileListItem } from '../types';

export function createFilesRoutes(index: DocumentIndex) {
  const app = new Hono();

  // GET /api/files - List all documents with metadata
  app.get('/', (c) => {
    const docs = index.getAll();

    // Optional filters
    const type = c.req.query('type');
    const tag = c.req.query('tag');
    const folder = c.req.query('folder');

    let filtered = docs;

    if (type) {
      filtered = filtered.filter(d => d.type === type);
    }
    if (tag) {
      filtered = filtered.filter(d => d.tags.includes(tag));
    }
    if (folder) {
      filtered = filtered.filter(d => d.path.startsWith(folder));
    }

    // Transform to list items (without full content)
    const items: FileListItem[] = filtered.map(d => ({
      path: d.path,
      title: d.title,
      type: d.type,
      status: d.status,
      tags: d.tags,
      created: d.created,
      updated: d.updated,
      linkCount: d.links.length,
      backlinkCount: d.backlinks.length,
    }));

    // Sort by updated date, newest first
    items.sort((a, b) => {
      const aDate = a.updated || a.created || '';
      const bDate = b.updated || b.created || '';
      return bDate.localeCompare(aDate);
    });

    return c.json({
      count: items.length,
      items,
    });
  });

  // GET /api/files/:path - Get single document with full content
  app.get('/*', (c) => {
    // Extract path from URL (everything after /api/files/)
    const path = c.req.path.replace('/api/files/', '');

    if (!path) {
      return c.json({ error: 'Path required' }, 400);
    }

    const doc = index.get(path);

    if (!doc) {
      return c.json({ error: 'Document not found' }, 404);
    }

    // Resolve backlink documents for display
    const backlinks = doc.backlinks
      .map(p => index.get(p))
      .filter((d): d is OrgDocument => d !== undefined)
      .map(d => ({
        path: d.path,
        title: d.title,
        type: d.type,
      }));

    return c.json({
      ...doc,
      resolvedBacklinks: backlinks,
    });
  });

  return app;
}
