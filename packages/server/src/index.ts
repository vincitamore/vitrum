import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';

import { DocumentIndex } from './services/index';
import { FileWatcher } from './services/watcher';
import { LiveReloadServer } from './ws/reload';
import { PeerRegistry } from './services/peers';
import { SyncService } from './services/sync';
import {
  createFilesRoutes,
  createSearchRoutes,
  createGraphRoutes,
  createStatusRoutes,
  createPublishRoutes,
  createFederationRoutes,
} from './routes';

// Configuration
const PORT = parseInt(process.env.PORT || '3847');
const ORG_ROOT = process.env.ORG_ROOT || process.cwd();
const STATIC_DIR = process.env.STATIC_DIR || '../client/dist';

// Initialize services
const startTime = new Date();
const index = new DocumentIndex(ORG_ROOT);
const watcher = new FileWatcher(ORG_ROOT, index);
const reloadServer = new LiveReloadServer();
const peerRegistry = new PeerRegistry(ORG_ROOT);
const syncService = new SyncService(ORG_ROOT, index, peerRegistry);

// Track local host info for federation
let localHost: { host: string; port: number } | null = null;

// Create Hono app
const app = new Hono();

// Middleware
app.use('*', logger());
app.use(
  '/api/*',
  cors({
    origin: ['http://localhost:5173', 'http://localhost:3847', 'http://127.0.0.1:5173'],
    credentials: true,
  })
);

// API Routes
app.route('/api/files', createFilesRoutes(index));
app.route('/api/search', createSearchRoutes(index));
app.route('/api/graph', createGraphRoutes(index));
app.route('/api/status', createStatusRoutes(index, reloadServer, startTime));
app.route('/api/publish', createPublishRoutes(index, ORG_ROOT));
app.route('/api/federation', createFederationRoutes(index, peerRegistry, startTime, () => localHost, syncService));

// Health check
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
);

// Static files (PWA client)
app.use('/*', serveStatic({ root: STATIC_DIR }));

// Fallback to index.html for SPA routing
app.get('*', serveStatic({ path: `${STATIC_DIR}/index.html` }));

// Wire up file watcher to live reload
watcher.onChange((event, path) => {
  console.log(`File ${event}: ${path}`);
  if (event === 'remove') {
    reloadServer.notifyRemove(path);
  } else {
    reloadServer.notifyChange(path);
  }
});

// Start server
async function main() {
  console.log(`Org Viewer Server starting...`);
  console.log(`  ORG_ROOT: ${ORG_ROOT}`);
  console.log(`  PORT: ${PORT}`);

  // Build initial index
  await index.buildIndex();

  // Start file watcher
  watcher.start();

  // Start HTTP server with WebSocket support
  const server = Bun.serve({
    port: PORT,
    fetch: app.fetch,
    websocket: {
      open(ws) {
        reloadServer.addClient(ws);
      },
      close(ws) {
        reloadServer.removeClient(ws);
      },
      message(ws, message) {
        // Handle ping/pong or other client messages
        if (message === 'ping') {
          ws.send('pong');
        }
      },
    },
  });

  localHost = { host: 'localhost', port: PORT };

  // Start peer discovery polling
  peerRegistry.onPeerStatusChange((peer) => {
    console.log(`Peer ${peer.name} (${peer.host}): ${peer.status}`);
    reloadServer.broadcast({
      type: peer.status === 'online' ? 'peer-online' : 'peer-offline',
      peer: peer.name,
      host: peer.host,
      timestamp: Date.now(),
    });
  });
  peerRegistry.startPolling();

  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`Federation: ${peerRegistry.getPeers().length} peers configured`);

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    peerRegistry.stopPolling();
    watcher.stop();
    server.stop();
    process.exit(0);
  });
}

main().catch(console.error);
