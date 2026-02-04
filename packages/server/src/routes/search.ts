import { Hono } from 'hono';
import type { DocumentIndex } from '../services/index';

export function createSearchRoutes(index: DocumentIndex) {
  const app = new Hono();

  // GET /api/search?q=...&type=...&tag=...
  app.get('/', (c) => {
    const query = c.req.query('q');

    if (!query) {
      return c.json({ error: 'Query parameter "q" required' }, 400);
    }

    const type = c.req.query('type');
    const tag = c.req.query('tag');
    const limit = parseInt(c.req.query('limit') || '20');

    const results = index.search(query, { type, tag });

    // Transform results for API response
    const items = results.slice(0, limit).map(r => ({
      path: r.item.path,
      title: r.item.title,
      type: r.item.type,
      status: r.item.status,
      tags: r.item.tags,
      score: r.score,
      // Include snippet from content
      snippet: extractSnippet(r.item.content, query),
    }));

    return c.json({
      query,
      count: items.length,
      total: results.length,
      items,
    });
  });

  return app;
}

function extractSnippet(content: string, query: string, contextLength = 100): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();

  const index = lowerContent.indexOf(lowerQuery);

  if (index === -1) {
    // Return start of content if query not found
    return content.slice(0, contextLength * 2) + (content.length > contextLength * 2 ? '...' : '');
  }

  const start = Math.max(0, index - contextLength);
  const end = Math.min(content.length, index + query.length + contextLength);

  let snippet = content.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}
