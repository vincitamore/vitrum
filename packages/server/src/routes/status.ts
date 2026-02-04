import { Hono } from 'hono';
import type { DocumentIndex } from '../services/index';
import type { LiveReloadServer } from '../ws/reload';

export function createStatusRoutes(
  index: DocumentIndex,
  reloadServer: LiveReloadServer,
  startTime: Date
) {
  const app = new Hono();

  // GET /api/status - Dashboard stats
  app.get('/', (c) => {
    const docs = index.getAll();
    const stats = index.getStats();

    // Count by type
    const byType: Record<string, number> = {};
    for (const doc of docs) {
      byType[doc.type] = (byType[doc.type] || 0) + 1;
    }

    // Count by status (for tasks)
    const byStatus: Record<string, number> = {};
    for (const doc of docs) {
      if (doc.status) {
        byStatus[doc.status] = (byStatus[doc.status] || 0) + 1;
      }
    }

    // Collect all tags with counts
    const tagCounts: Record<string, number> = {};
    for (const doc of docs) {
      for (const tag of doc.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    // Top tags
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    // Recent documents (last 5 updated)
    const recent = docs
      .filter(d => d.updated || d.created)
      .sort((a, b) => {
        const aDate = a.updated || a.created || '';
        const bDate = b.updated || b.created || '';
        return bDate.localeCompare(aDate);
      })
      .slice(0, 5)
      .map(d => ({
        path: d.path,
        title: d.title,
        type: d.type,
        updated: d.updated || d.created,
      }));

    return c.json({
      server: {
        uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
        connectedClients: reloadServer.clientCount,
        lastIndexed: stats.lastIndexed,
      },
      documents: {
        total: stats.documentCount,
        byType,
        byStatus,
      },
      tags: {
        total: Object.keys(tagCounts).length,
        top: topTags,
      },
      recent,
    });
  });

  // POST /api/status/reindex - Force reindex
  app.post('/reindex', async (c) => {
    await index.buildIndex();
    reloadServer.notifyReload();

    return c.json({
      success: true,
      stats: index.getStats(),
    });
  });

  return app;
}
