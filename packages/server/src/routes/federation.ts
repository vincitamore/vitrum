import { Hono } from 'hono';
import type { DocumentIndex } from '../services/index';
import type { PeerRegistry } from '../services/peers';
import type { SyncService } from '../services/sync';
import type {
  PeerHelloResponse,
  FederationPeersResponse,
  CrossOrgSearchResult,
  CrossOrgSearchResponse,
} from '../types/federation';

export function createFederationRoutes(
  index: DocumentIndex,
  peerRegistry: PeerRegistry,
  startTime: Date,
  getLocalHost: () => { host: string; port: number } | null,
  syncService: SyncService,
) {
  const app = new Hono();

  // GET /api/federation/hello - Peer handshake (open to tailnet)
  app.get('/hello', (c) => {
    const self = peerRegistry.getSelf();
    const allDocs = index.getAll();

    const stats = {
      documentCount: allDocs.length,
      knowledgeCount: allDocs.filter(d => d.type === 'knowledge').length,
      taskCount: allDocs.filter(d => d.type === 'task').length,
    };

    const response: PeerHelloResponse = {
      instanceId: self.instanceId,
      displayName: self.displayName,
      apiVersion: '1',
      sharedFolders: self.sharedFolders,
      sharedTags: self.sharedTags,
      stats,
      online: true,
      uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
    };

    return c.json(response);
  });

  // GET /api/federation/peers - List peers with live status (local only)
  app.get('/peers', (c) => {
    const self = peerRegistry.getSelf();
    const localHost = getLocalHost();

    const response: FederationPeersResponse = {
      self: {
        instanceId: self.instanceId,
        displayName: self.displayName,
        host: localHost?.host || 'localhost',
        port: localHost?.port || 3847,
      },
      peers: peerRegistry.getPeerStatus(),
    };

    return c.json(response);
  });

  // GET /api/federation/cross-search?q=... - Fan-out search across all peers (local only)
  // The client calls THIS endpoint; server fans out to all online peers in parallel
  app.get('/cross-search', async (c) => {
    const query = c.req.query('q');
    if (!query) {
      return c.json({ error: 'Query parameter "q" required' }, 400);
    }

    const type = c.req.query('type');
    const tag = c.req.query('tag');
    const limit = parseInt(c.req.query('limit') || '20');

    const onlinePeers = peerRegistry.getOnlinePeers();
    const peerResults: Record<string, { count: number; took: number }> = {};
    const allResults: CrossOrgSearchResult[] = [];

    // Fan out to all online peers in parallel
    const peerPromises = onlinePeers.map(async (peer) => {
      const startMs = Date.now();
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (type) params.set('type', type);
      if (tag) params.set('tag', tag);

      const url = `${peer.protocol}://${peer.host}:${peer.port}/api/federation/search?${params}`;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' },
        });
        clearTimeout(timeout);

        if (!resp.ok) return;

        const data = await resp.json() as {
          instanceId: string;
          displayName: string;
          query: string;
          count: number;
          items: Array<{
            path: string;
            title: string;
            type: string;
            tags: string[];
            score: number;
            snippet: string;
          }>;
        };

        const took = Date.now() - startMs;
        peerResults[peer.name] = { count: data.count, took };

        for (const item of data.items) {
          allResults.push({
            peer: data.displayName || peer.name,
            peerId: data.instanceId || peer.instanceId || '',
            peerHost: `${peer.host}:${peer.port}`,
            path: item.path,
            title: item.title,
            type: item.type,
            tags: item.tags,
            score: item.score,
            snippet: item.snippet,
          });
        }
      } catch {
        // Peer didn't respond in time, skip silently
        peerResults[peer.name] = { count: 0, took: Date.now() - startMs };
      }
    });

    await Promise.allSettled(peerPromises);

    // Sort merged results by score (descending)
    allResults.sort((a, b) => b.score - a.score);

    const response: CrossOrgSearchResponse = {
      query,
      results: allResults.slice(0, limit),
      totalPeersQueried: onlinePeers.length,
      totalPeersResponded: Object.values(peerResults).filter(r => r.count >= 0).length,
      peerResults,
    };

    return c.json(response);
  });

  // GET /api/federation/cross-files?peer=host:port&folder=... - Browse a specific peer's files (local only)
  app.get('/cross-files', async (c) => {
    const peerHost = c.req.query('peer');
    if (!peerHost) {
      return c.json({ error: 'Query parameter "peer" required (host:port)' }, 400);
    }

    const folder = c.req.query('folder');
    const tag = c.req.query('tag');

    const [host, portStr] = peerHost.split(':');
    const peer = peerRegistry.getPeerStatus().find(
      p => p.host === host && p.port === parseInt(portStr || '3847')
    );

    if (!peer || peer.status !== 'online') {
      return c.json({ error: 'Peer not found or offline' }, 404);
    }

    const params = new URLSearchParams();
    if (folder) params.set('folder', folder);
    if (tag) params.set('tag', tag);

    const url = `${peer.protocol}://${peer.host}:${peer.port}/api/federation/files?${params}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return c.json({ error: `Peer returned ${resp.status}` }, resp.status as any);
      }

      const data = await resp.json();
      return c.json(data);
    } catch {
      return c.json({ error: 'Peer request timed out' }, 504);
    }
  });

  // GET /api/federation/cross-files/*?peer=host:port - Fetch single doc from peer (local only)
  app.get('/cross-file/*', async (c) => {
    const peerHost = c.req.query('peer');
    if (!peerHost) {
      return c.json({ error: 'Query parameter "peer" required (host:port)' }, 400);
    }

    const path = c.req.path.replace('/api/federation/cross-file/', '');
    const checksumOnly = c.req.query('checksumOnly');

    const [host, portStr] = peerHost.split(':');
    const peer = peerRegistry.getPeerStatus().find(
      p => p.host === host && p.port === parseInt(portStr || '3847')
    );

    if (!peer || peer.status !== 'online') {
      return c.json({ error: 'Peer not found or offline' }, 404);
    }

    const params = new URLSearchParams();
    if (checksumOnly === 'true') params.set('checksumOnly', 'true');

    const url = `${peer.protocol}://${peer.host}:${peer.port}/api/federation/files/${path}?${params}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return c.json({ error: `Peer returned ${resp.status}` }, resp.status as any);
      }

      const data = await resp.json();
      return c.json(data);
    } catch {
      return c.json({ error: 'Peer request timed out' }, 504);
    }
  });

  // GET /api/federation/search?q=... - Search shared content (peer-only)
  // Note: This is what remote peers call on THIS instance
  app.get('/search', (c) => {
    const query = c.req.query('q');
    if (!query) {
      return c.json({ error: 'Query parameter "q" required' }, 400);
    }

    const self = peerRegistry.getSelf();
    const type = c.req.query('type');
    const tag = c.req.query('tag');
    const limit = parseInt(c.req.query('limit') || '20');

    // Search only within shared folders
    let results = index.search(query, { type, tag });

    // Filter to shared folders only
    results = results.filter(r => {
      return self.sharedFolders.some(folder => r.item.path.startsWith(folder));
    });

    const items = results.slice(0, limit).map(r => ({
      path: r.item.path,
      title: r.item.title,
      type: r.item.type,
      tags: r.item.tags,
      score: r.score,
      snippet: extractSnippet(r.item.content, query),
    }));

    return c.json({
      instanceId: self.instanceId,
      displayName: self.displayName,
      query,
      count: items.length,
      items,
    });
  });

  // GET /api/federation/files?folder=... - List shared documents (peer-only)
  app.get('/files', (c) => {
    const self = peerRegistry.getSelf();
    const folder = c.req.query('folder');
    const tag = c.req.query('tag');

    let docs = index.getAll();

    // Filter to shared folders
    docs = docs.filter(d =>
      self.sharedFolders.some(f => d.path.startsWith(f))
    );

    // Optional additional folder filter
    if (folder) {
      docs = docs.filter(d => d.path.startsWith(folder));
    }

    // Optional tag filter
    if (tag) {
      docs = docs.filter(d => d.tags.includes(tag));
    }

    return c.json({
      instanceId: self.instanceId,
      displayName: self.displayName,
      count: docs.length,
      items: docs.map(d => ({
        path: d.path,
        title: d.title,
        type: d.type,
        tags: d.tags,
        created: d.created,
        updated: d.updated,
        excerpt: d.excerpt,
      })),
    });
  });

  // GET /api/federation/files/* - Fetch single shared document (peer-only)
  app.get('/files/*', (c) => {
    const self = peerRegistry.getSelf();
    const path = c.req.path.replace('/api/federation/files/', '');

    // Check if path is within shared folders
    const isShared = self.sharedFolders.some(f => path.startsWith(f));
    if (!isShared) {
      return c.json({ error: 'Document not in shared folders' }, 403);
    }

    const doc = index.get(path);
    if (!doc) {
      return c.json({ error: 'Document not found' }, 404);
    }

    // Support checksumOnly query for sync polling
    const checksumOnly = c.req.query('checksumOnly');
    if (checksumOnly === 'true') {
      const checksum = computeChecksum(doc.content);
      return c.json({
        checksum,
        updated: doc.updated,
      });
    }

    return c.json({
      path: doc.path,
      title: doc.title,
      type: doc.type,
      tags: doc.tags,
      content: doc.content,
      frontmatter: doc.frontmatter,
      created: doc.created,
      updated: doc.updated,
      links: doc.links,
      backlinks: doc.backlinks,
      checksum: computeChecksum(doc.content),
    });
  });

  // POST /api/federation/adopt - Adopt a peer's document locally (local only)
  app.post('/adopt', async (c) => {
    const body = await c.req.json();
    const { peerId, peerHost, sourcePath, targetPath } = body;

    if (!peerId || !peerHost || !sourcePath) {
      return c.json({ error: 'Missing peerId, peerHost, or sourcePath' }, 400);
    }

    // Find the peer's connection info
    const [host, portStr] = peerHost.split(':');
    const peer = peerRegistry.getPeerStatus().find(
      p => p.host === host && p.port === parseInt(portStr || '3847')
    );

    if (!peer || peer.status !== 'online') {
      return c.json({ error: 'Peer not found or offline' }, 404);
    }

    try {
      const result = await syncService.adoptDocument({
        peerId,
        peerHost: host,
        peerPort: peer.port,
        peerProtocol: peer.protocol,
        peerName: peer.displayName || peer.name,
        sourcePath,
        targetPath,
      });

      return c.json({
        success: true,
        localPath: result.localPath,
        checksum: result.checksum,
      });
    } catch (e) {
      return c.json({ error: `Adoption failed: ${e}` }, 500);
    }
  });

  // POST /api/federation/send - Send a document to a peer's inbox (local only)
  app.post('/send', async (c) => {
    const body = await c.req.json();
    const { peerHost, sourcePath, message } = body;

    if (!peerHost || !sourcePath) {
      return c.json({ error: 'Missing peerHost or sourcePath' }, 400);
    }

    const doc = index.get(sourcePath);
    if (!doc) {
      return c.json({ error: 'Local document not found' }, 404);
    }

    const self = peerRegistry.getSelf();
    const localHost = getLocalHost();

    // Find peer
    const [host, portStr] = peerHost.split(':');
    const peer = peerRegistry.getPeerStatus().find(
      p => p.host === host && p.port === parseInt(portStr || '3847')
    );

    if (!peer || peer.status !== 'online') {
      return c.json({ error: 'Peer not found or offline' }, 404);
    }

    // Send to peer's receive endpoint
    const url = `${peer.protocol}://${peer.host}:${peer.port}/api/federation/receive`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: {
            instanceId: self.instanceId,
            displayName: self.displayName,
            host: `${localHost?.host || 'localhost'}:${localHost?.port || 3847}`,
          },
          document: {
            title: doc.title,
            content: doc.content,
            tags: doc.tags,
            sourcePath: doc.path,
          },
          message,
        }),
      });

      if (!resp.ok) {
        throw new Error(`Peer returned ${resp.status}`);
      }

      return c.json({ success: true, sentTo: peer.displayName || peer.name });
    } catch (e) {
      return c.json({ error: `Send failed: ${e}` }, 500);
    }
  });

  // POST /api/federation/receive - Accept incoming document from peer (peer-only)
  app.post('/receive', async (c) => {
    const body = await c.req.json();

    const { from, document, message } = body;
    if (!from || !document) {
      return c.json({ error: 'Missing from or document' }, 400);
    }

    try {
      const inboxPath = syncService.writeIncomingDocument({
        from,
        title: document.title,
        content: document.content,
        tags: document.tags || [],
        sourcePath: document.sourcePath,
        message,
      });

      return c.json({ accepted: true, inboxPath });
    } catch (e) {
      return c.json({ error: `Failed to write incoming document: ${e}` }, 500);
    }
  });

  // GET /api/federation/shared - List all adopted/shared documents (local only)
  app.get('/shared', (c) => {
    const shared = syncService.getSharedDocuments();
    return c.json({
      count: shared.length,
      items: shared,
    });
  });

  // POST /api/federation/shared/respond - Receive resolution response from adopter (peer-only)
  app.post('/shared/respond', async (c) => {
    const body = await c.req.json();

    const { from, action, originalPath, comment } = body;
    if (!from || !action || !originalPath) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    // Write rejection/resolution to inbox
    if (action === 'rejected' && comment) {
      syncService.writeIncomingDocument({
        from,
        title: `Federation: ${from.displayName} ${action} your update`,
        content: `**Document**: ${originalPath}\n**Action**: ${action}\n**Comment**: ${comment}`,
        tags: ['federation', 'resolution'],
        sourcePath: originalPath,
        message: comment,
      });
    }

    return c.json({ accepted: true });
  });

  return app;
}

function extractSnippet(content: string, query: string, contextLength = 100): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerContent.indexOf(lowerQuery);

  if (idx === -1) {
    return content.slice(0, contextLength * 2) + (content.length > contextLength * 2 ? '...' : '');
  }

  const start = Math.max(0, idx - contextLength);
  const end = Math.min(content.length, idx + query.length + contextLength);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

function computeChecksum(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return 'sha256:' + hasher.digest('hex');
}
