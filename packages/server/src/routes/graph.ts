import { Hono } from 'hono';
import type { DocumentIndex } from '../services/index';

export function createGraphRoutes(index: DocumentIndex) {
  const app = new Hono();

  // GET /api/graph - Get D3 graph data
  app.get('/', (c) => {
    const graph = index.getGraph();

    // Optional: filter by folder
    const folder = c.req.query('folder');

    if (folder) {
      const nodeIds = new Set(
        graph.nodes
          .filter(n => n.id.startsWith(folder))
          .map(n => n.id)
      );

      return c.json({
        nodes: graph.nodes.filter(n => nodeIds.has(n.id)),
        links: graph.links.filter(l =>
          nodeIds.has(l.source) && nodeIds.has(l.target)
        ),
      });
    }

    return c.json(graph);
  });

  // GET /api/graph/neighbors/:path - Get immediate neighbors of a node
  app.get('/neighbors/*', (c) => {
    const path = c.req.path.replace('/api/graph/neighbors/', '');

    if (!path) {
      return c.json({ error: 'Path required' }, 400);
    }

    const doc = index.get(path);

    if (!doc) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const graph = index.getGraph();

    // Find all connected nodes
    const connectedIds = new Set<string>([path]);

    // Add outgoing links
    for (const link of doc.links) {
      const resolved = graph.nodes.find(n =>
        n.id === link || n.label.toLowerCase() === link.toLowerCase()
      );
      if (resolved) connectedIds.add(resolved.id);
    }

    // Add incoming links (backlinks)
    for (const backlink of doc.backlinks) {
      connectedIds.add(backlink);
    }

    return c.json({
      center: path,
      nodes: graph.nodes.filter(n => connectedIds.has(n.id)),
      links: graph.links.filter(l =>
        connectedIds.has(l.source) && connectedIds.has(l.target)
      ),
    });
  });

  return app;
}
