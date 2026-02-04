# org-viewer Architecture

> A native app + PWA for viewing claude-org documents over Tailscale.

## Design Principles

This architecture follows the principle lattice:

- **1->7 (Single-Source Multiplicity)**: One org folder, multiple access points (native app, PWA, MCP)
- **<> (Self-Sovereignty)**: Runs entirely on your machine; no cloud dependencies
- **= (Structural Correctness)**: Reuse proven patterns from amore.build rather than reinvent
- **infinity->0 (Inversion)**: Complex file-watching and rendering hidden behind simple HTTP/WS interface

---

## 1. Project Structure

```
org-viewer/
├── ARCHITECTURE.md            # This file
├── CLAUDE.md                  # Development instructions
├── package.json               # Monorepo root (workspace config)
├── turbo.json                 # Turborepo config (optional)
│
├── packages/
│   ├── server/                # Bun + Hono backend
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts       # Entry point, server bootstrap
│   │   │   ├── routes/
│   │   │   │   ├── files.ts   # GET /api/files - list with metadata
│   │   │   │   ├── file.ts    # GET /api/file/:path - single document
│   │   │   │   ├── search.ts  # GET /api/search?q=... - full-text
│   │   │   │   ├── graph.ts   # GET /api/graph - link graph data
│   │   │   │   └── status.ts  # GET /api/status - dashboard stats
│   │   │   ├── services/
│   │   │   │   ├── watcher.ts # File watcher (Bun native)
│   │   │   │   ├── parser.ts  # Markdown + frontmatter processing
│   │   │   │   ├── index.ts   # Document index (in-memory)
│   │   │   │   └── search.ts  # Full-text search engine
│   │   │   ├── ws/
│   │   │   │   └── reload.ts  # WebSocket live reload hub
│   │   │   └── types.ts       # Shared TypeScript types
│   │   └── dist/              # Compiled output
│   │
│   ├── client/                # React + PWA frontend
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   ├── public/
│   │   │   ├── manifest.json  # PWA manifest
│   │   │   └── icons/         # PWA icons (192, 512)
│   │   └── src/
│   │       ├── main.tsx       # React entry
│   │       ├── App.tsx        # Root component
│   │       ├── index.css      # Tailwind + theme vars
│   │       ├── features/
│   │       │   └── org/       # Ported from amore.build
│   │       │       ├── OrgApp.tsx
│   │       │       ├── OrgDashboard.tsx
│   │       │       ├── OrgDocumentList.tsx
│   │       │       ├── OrgDocumentView.tsx
│   │       │       ├── OrgGraph.tsx
│   │       │       └── OrgStyles.css
│   │       ├── shared/
│   │       │   ├── lib/
│   │       │   │   ├── api.ts         # API client (fetch wrapper)
│   │       │   │   ├── themes.ts      # 23 themes from amore.build
│   │       │   │   ├── markdown.ts    # TUI markdown renderer
│   │       │   │   └── ws.ts          # WebSocket reconnection
│   │       │   ├── hooks/
│   │       │   │   ├── useTheme.ts
│   │       │   │   └── useLiveReload.ts
│   │       │   └── ui/
│   │       │       ├── tui/           # TuiBox, TuiMenu, etc.
│   │       │       └── markdown/      # MarkdownContent component
│   │       └── sw.ts                  # Service worker
│   │
│   └── mcp/                   # MCP server for Claude Code
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts       # MCP tool definitions
│
├── src-tauri/                 # Tauri native wrapper
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs            # Tauri entry + IPC handlers
│   │   └── tray.rs            # System tray logic
│   ├── icons/                 # App icons per platform
│   └── capabilities/          # Tauri v2 capability files
│
└── scripts/
    ├── dev.ts                 # Start dev servers
    └── build.ts               # Production build
```

**Rationale**: Monorepo with pnpm workspaces keeps server/client/mcp as separate packages but allows shared types. Tauri sits at root level per Tauri conventions.

---

## 2. Server Design (Bun + Hono)

### 2.1 Why Bun + Hono

| Consideration | Choice | Reason |
|---------------|--------|--------|
| Runtime | Bun | Native file watching, fast startup, single binary compile |
| Framework | Hono | Minimal, fast, excellent TypeScript, runs anywhere |
| Alternative | Express | Heavier, less Bun-optimized |

### 2.2 Routes and API Design

```typescript
// packages/server/src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';

const app = new Hono();

app.use('*', cors());

// API routes
app.get('/api/files', listFiles);        // List all documents with metadata
app.get('/api/file/*', getFile);         // Get single document by path
app.get('/api/search', searchDocuments); // Full-text search
app.get('/api/graph', getGraph);         // Link graph for D3 visualization
app.get('/api/status', getStatus);       // Dashboard stats

// Static files (client build)
app.use('/*', serveStatic({ root: '../client/dist' }));

// WebSocket upgrade for live reload
app.get('/ws', upgradeWebSocket);

export default {
  port: 3847,  // "ORG" on phone keypad
  fetch: app.fetch,
  websocket: wsHandler,
};
```

### 2.3 API Contracts

**GET /api/files**
```typescript
interface FileListResponse {
  files: Array<{
    path: string;           // Relative path from org root
    title: string;          // From H1 or frontmatter
    type: 'task' | 'knowledge' | 'inbox' | 'project' | 'other';
    status?: string;        // For tasks
    tags: string[];
    created: string;        // ISO date
    updated: string;        // File mtime
    excerpt: string;        // First 200 chars
  }>;
  lastIndexed: string;
}
```

**GET /api/file/:path**
```typescript
interface FileResponse {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  content: string;          // Raw markdown
  links: string[];          // Outgoing wikilinks
  backlinks: string[];      // Incoming wikilinks
  toc: Array<{ level: number; text: string; slug: string }>;
}
```

**GET /api/search?q=query&type=task&tag=react**
```typescript
interface SearchResponse {
  results: Array<{
    path: string;
    title: string;
    excerpt: string;        // With <mark> highlights
    score: number;
  }>;
  query: string;
  took: number;             // ms
}
```

**GET /api/graph**
```typescript
interface GraphResponse {
  nodes: Array<{
    id: string;             // path
    label: string;          // title
    type: string;
    group: string;          // folder for clustering
  }>;
  links: Array<{
    source: string;
    target: string;
  }>;
}
```

### 2.4 File Watching Strategy

**Use Bun's native fs.watch** - lighter than chokidar, already bundled:

```typescript
// packages/server/src/services/watcher.ts
import { watch } from 'fs';
import { debounce } from './utils';

export function watchOrgFolder(
  orgRoot: string,
  onUpdate: (path: string, event: 'change' | 'rename') => void
) {
  const watcher = watch(
    orgRoot,
    { recursive: true },
    debounce((event, filename) => {
      if (filename?.endsWith('.md')) {
        onUpdate(filename, event as 'change' | 'rename');
      }
    }, 100)
  );

  return () => watcher.close();
}
```

**Index rebuild strategy**:
1. Full index on startup (scan all .md files)
2. Incremental updates on file change (reparse single file)
3. Debounce rapid changes (100ms)
4. Broadcast to all WebSocket clients after index update

### 2.5 Markdown Processing Pipeline

```typescript
// packages/server/src/services/parser.ts
import matter from 'gray-matter';

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  content: string;
  title: string;
  links: string[];          // [[wikilinks]]
  toc: TocEntry[];
}

export function parseDocument(filePath: string, raw: string): ParsedDocument {
  const { data: frontmatter, content } = matter(raw);

  // Extract title: frontmatter.title || first H1 || filename
  const title = extractTitle(frontmatter, content, filePath);

  // Extract [[wikilinks]]
  const links = extractWikilinks(content);

  // Build TOC from headings
  const toc = buildToc(content);

  return { frontmatter, content, title, links, toc };
}
```

### 2.6 WebSocket Live Reload

```typescript
// packages/server/src/ws/reload.ts
const clients = new Set<WebSocket>();

export const wsHandler = {
  open(ws: WebSocket) {
    clients.add(ws);
  },
  close(ws: WebSocket) {
    clients.delete(ws);
  },
  message(ws: WebSocket, message: string) {
    // Client can request specific subscriptions
    const data = JSON.parse(message);
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  },
};

export function broadcast(event: { type: string; payload: unknown }) {
  const message = JSON.stringify(event);
  for (const client of clients) {
    client.send(message);
  }
}

// Called by watcher on file changes
export function notifyFileChange(path: string) {
  broadcast({ type: 'file-changed', payload: { path } });
}
```

---

## 3. Client Design

### 3.1 Component Hierarchy

```
App
├── ThemeProvider
├── Router
│   ├── / -> OrgApp
│   │   ├── OrgDashboard (default view)
│   │   ├── OrgDocumentList (tasks, knowledge, inbox)
│   │   ├── OrgDocumentView (single document)
│   │   └── OrgGraph (D3 visualization)
│   └── /settings -> SettingsView (theme picker, server URL)
└── LiveReloadProvider
```

### 3.2 Components to Port vs Build Fresh

**Port from amore.build** (copy and adapt):

| Component | Source | Adaptations Needed |
|-----------|--------|-------------------|
| `OrgApp.tsx` | `features/org/ui/` | Remove auth headers, use local API |
| `OrgDashboard.tsx` | `features/org/ui/` | Minor API path changes |
| `OrgDocumentList.tsx` | `features/org/ui/` | Minor API path changes |
| `OrgDocumentView.tsx` | `features/org/ui/` | Remove auth, simplify |
| `OrgGraph.tsx` | `features/org/ui/` | Use local API |
| `OrgStyles.css` | `features/org/ui/` | Copy as-is |
| `themes.ts` | `shared/lib/` | Copy as-is (all 23 themes) |
| `markdown.ts` | `shared/lib/` | Copy as-is (TUI renderer) |
| `TuiBox.tsx` | `shared/ui/tui/` | Copy as-is |
| `TuiMenu.tsx` | `shared/ui/tui/` | Copy as-is |
| `TouchNav.tsx` | `shared/ui/tui/` | Copy as-is |

**Build fresh**:

| Component | Reason |
|-----------|--------|
| `useLiveReload.ts` | New WebSocket connection to local server |
| `api.ts` | Simplified (no auth, local URLs) |
| `SettingsView.tsx` | Theme picker + server config |
| `sw.ts` | Service worker for PWA offline |

### 3.3 State Management

**Keep it simple - React context + hooks**:

```typescript
// ThemeContext - manages current theme
// Uses localStorage for persistence
// Applies CSS variables via themes.ts

// LiveReloadContext - WebSocket connection
// Auto-reconnect on disconnect
// Exposes lastChange timestamp for components to react

// No XState needed - simpler navigation than amore.build
// Use React Router for URL-based navigation
```

### 3.4 API Client

```typescript
// packages/client/src/shared/lib/api.ts
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3847';

export async function fetchFiles() {
  const res = await fetch(`${API_BASE}/api/files`);
  if (!res.ok) throw new Error('Failed to fetch files');
  return res.json();
}

export async function fetchFile(path: string) {
  const res = await fetch(`${API_BASE}/api/file/${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error('Failed to fetch file');
  return res.json();
}

export async function search(query: string, filters?: SearchFilters) {
  const params = new URLSearchParams({ q: query, ...filters });
  const res = await fetch(`${API_BASE}/api/search?${params}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}
```

### 3.5 PWA Manifest and Service Worker

**manifest.json**:
```json
{
  "name": "Org Viewer",
  "short_name": "OrgView",
  "description": "View claude-org documents anywhere",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1c1e26",
  "theme_color": "#e95678",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

**Service Worker Strategy**:

```typescript
// packages/client/src/sw.ts
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';

// Precache app shell
precacheAndRoute(self.__WB_MANIFEST);

// API calls: network-first (fresh data preferred)
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 3,
  })
);

// Static assets: cache-first
registerRoute(
  ({ request }) => request.destination === 'style' || request.destination === 'script',
  new CacheFirst({ cacheName: 'static-cache' })
);
```

**Key PWA behaviors**:
- Network-first for API (want fresh file data)
- Cache-first for static assets (themes, fonts)
- App installable on mobile via "Add to Home Screen"
- Works offline with cached data (stale but usable)

---

## 4. Tauri Integration

### 4.1 Architecture

```
┌─────────────────────────────────────────────┐
│           Tauri Native Shell                │
│  ┌───────────────────────────────────────┐  │
│  │          WebView (Chromium)           │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │      React Client (Vite)        │  │  │
│  │  │         localhost:5173          │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─────────────────────────────────────────┐│
│  │ Bun Server (spawned as sidecar)        ││
│  │           localhost:3847               ││
│  └─────────────────────────────────────────┘│
│                                             │
│  [System Tray Icon]                         │
└─────────────────────────────────────────────┘
```

### 4.2 Server as Sidecar

Tauri v2 supports sidecar binaries. The Bun server compiles to a single binary and runs alongside:

```json
// src-tauri/tauri.conf.json
{
  "bundle": {
    "externalBin": ["../packages/server/dist/server"]
  },
  "plugins": {
    "shell": {
      "sidecar": true,
      "scope": [
        { "name": "server", "sidecar": true }
      ]
    }
  }
}
```

```rust
// src-tauri/src/main.rs
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let shell = app.shell();

            // Spawn server sidecar
            let (mut rx, _child) = shell
                .sidecar("server")
                .expect("failed to spawn server")
                .spawn()
                .expect("failed to execute server");

            // Log server output
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let tauri_plugin_shell::process::CommandEvent::Stdout(line) = event {
                        println!("[server] {}", String::from_utf8_lossy(&line));
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 4.3 System Tray Behavior

```rust
// src-tauri/src/tray.rs
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Manager, Runtime,
};

pub fn create_tray<R: Runtime>(app: &tauri::App<R>) -> TrayIcon<R> {
    let open = MenuItem::with_id(app, "open", "Open in Browser", true, None::<&str>).unwrap();
    let copy_url = MenuItem::with_id(app, "copy_url", "Copy Tailscale URL", true, None::<&str>).unwrap();
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).unwrap();

    let menu = Menu::with_items(app, &[&open, &copy_url, &quit]).unwrap();

    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Org Viewer")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                open_browser(&get_local_url());
            }
            "copy_url" => {
                copy_to_clipboard(&get_tailscale_url());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
        .unwrap()
}
```

### 4.4 IPC Commands (Tauri <-> Web)

```rust
// src-tauri/src/main.rs

#[tauri::command]
fn get_server_url() -> String {
    "http://localhost:3847".to_string()
}

#[tauri::command]
fn get_tailscale_hostname() -> Option<String> {
    // Run `tailscale status --json` and parse
    let output = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output()
        .ok()?;

    let status: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    status["Self"]["DNSName"].as_str().map(|s| s.trim_end_matches('.').to_string())
}

#[tauri::command]
fn get_org_root() -> String {
    // Return configured org root path
    std::env::var("ORG_ROOT")
        .unwrap_or_else(|_| "C:\\Users\\AlexMoyer\\Documents\\claude-org".to_string())
}
```

### 4.5 Build Configuration

```json
// src-tauri/tauri.conf.json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Org Viewer",
  "version": "0.1.0",
  "identifier": "build.amore.org-viewer",
  "build": {
    "frontendDist": "../packages/client/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm --filter client dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "windows": [
      {
        "title": "Org Viewer",
        "width": 1200,
        "height": 800,
        "minWidth": 600,
        "minHeight": 400,
        "decorations": true,
        "transparent": false
      }
    ],
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true
    }
  },
  "bundle": {
    "active": true,
    "targets": ["msi", "dmg", "deb"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "externalBin": ["../packages/server/dist/server"]
  }
}
```

---

## 5. MCP Server Design

### 5.1 Tool Definitions

```typescript
// packages/mcp/src/index.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'org-viewer', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'org_viewer_status',
      description: 'Check if org-viewer is running and get server info',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'org_viewer_open',
      description: 'Open a specific document in the viewer',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to document' },
        },
        required: ['path'],
      },
    },
    {
      name: 'org_viewer_url',
      description: 'Get the viewer URL (local or Tailscale)',
      inputSchema: {
        type: 'object',
        properties: {
          tailscale: { type: 'boolean', description: 'Return Tailscale URL if available' },
        },
      },
    },
    {
      name: 'org_viewer_refresh',
      description: 'Force refresh the document index',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));
```

### 5.2 Communication with Viewer

The MCP server communicates with the running org-viewer server via HTTP:

```typescript
const SERVER_URL = 'http://localhost:3847';

async function handleToolCall(name: string, args: unknown) {
  switch (name) {
    case 'org_viewer_status': {
      try {
        const res = await fetch(`${SERVER_URL}/api/status`);
        if (!res.ok) throw new Error('Server not responding');
        const data = await res.json();
        return { running: true, ...data };
      } catch {
        return { running: false, error: 'Org viewer not running' };
      }
    }

    case 'org_viewer_open': {
      const { path } = args as { path: string };
      // Notify server to broadcast URL to clients
      await fetch(`${SERVER_URL}/api/navigate`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      });
      return { success: true, url: `${SERVER_URL}/#/doc/${encodeURIComponent(path)}` };
    }

    case 'org_viewer_url': {
      const { tailscale } = args as { tailscale?: boolean };
      if (tailscale) {
        const hostname = await getTailscaleHostname();
        if (hostname) return { url: `http://${hostname}:3847` };
      }
      return { url: SERVER_URL };
    }

    case 'org_viewer_refresh': {
      await fetch(`${SERVER_URL}/api/refresh`, { method: 'POST' });
      return { success: true };
    }
  }
}
```

---

## 6. Tailscale Considerations

### 6.1 Detecting Tailscale Hostname

```typescript
// packages/server/src/services/tailscale.ts
import { execSync } from 'child_process';

export interface TailscaleStatus {
  available: boolean;
  hostname?: string;    // e.g., "desktop-abc123"
  dnsName?: string;     // e.g., "desktop-abc123.tail12345.ts.net"
  ip?: string;          // Tailscale IP
}

export function getTailscaleStatus(): TailscaleStatus {
  try {
    const output = execSync('tailscale status --json', { encoding: 'utf-8' });
    const status = JSON.parse(output);

    return {
      available: true,
      hostname: status.Self?.HostName,
      dnsName: status.Self?.DNSName?.replace(/\.$/, ''),
      ip: status.TailscaleIPs?.[0],
    };
  } catch {
    return { available: false };
  }
}
```

### 6.2 Security Considerations

**Tailscale provides the security layer** - no additional auth needed:

| Concern | Resolution |
|---------|------------|
| Network exposure | Server binds to `0.0.0.0` but only Tailscale devices can reach it |
| Authentication | Tailscale handles device identity; only your devices on your tailnet |
| Encryption | Tailscale encrypts all traffic with WireGuard |
| File access | Server only reads org folder; no write operations |

**Server security settings**:

```typescript
// packages/server/src/index.ts
const app = new Hono();

// CORS: allow all origins (Tailscale handles network security)
app.use('*', cors());

// Read-only API (no POST/PUT/DELETE for documents)
// Only refresh/navigate endpoints allow POST

// Rate limiting: optional but not critical on private network
```

### 6.3 Displaying Connection Info

The client shows connection status in the UI:

```typescript
// packages/client/src/features/settings/ConnectionInfo.tsx
function ConnectionInfo() {
  const [status, setStatus] = useState<{
    local: string;
    tailscale?: string;
    connected: boolean;
  }>();

  useEffect(() => {
    fetch('/api/status').then(res => res.json()).then(data => {
      setStatus({
        local: 'http://localhost:3847',
        tailscale: data.tailscale?.dnsName
          ? `http://${data.tailscale.dnsName}:3847`
          : undefined,
        connected: true,
      });
    });
  }, []);

  return (
    <div className="connection-info">
      <div>Local: {status?.local}</div>
      {status?.tailscale && (
        <div>
          Tailscale: {status.tailscale}
          <button onClick={() => copyToClipboard(status.tailscale!)}>Copy</button>
        </div>
      )}
    </div>
  );
}
```

---

## 7. Build and Distribution

### 7.1 Compile to Single Executable

**Server (Bun compile)**:

```bash
# packages/server/package.json scripts
{
  "build": "bun build src/index.ts --compile --outfile dist/server"
}
```

This produces a single ~50MB binary (includes Bun runtime + dependencies).

**Client (Vite build)**:

```bash
# packages/client/package.json scripts
{
  "build": "vite build"
}
```

Produces static files in `dist/` (~2MB).

**Tauri (full app)**:

```bash
# From project root
pnpm tauri build
```

Produces:
- Windows: `src-tauri/target/release/bundle/msi/org-viewer_0.1.0_x64.msi` (~15MB)
- macOS: `src-tauri/target/release/bundle/dmg/org-viewer_0.1.0_aarch64.dmg` (~12MB)
- Linux: `src-tauri/target/release/bundle/deb/org-viewer_0.1.0_amd64.deb` (~10MB)

### 7.2 CI/CD Considerations

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
            target: x86_64-pc-windows-msvc
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: oven-sh/setup-bun@v2

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install dependencies
        run: pnpm install

      - name: Build server
        run: pnpm --filter server build

      - name: Build client
        run: pnpm --filter client build

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        with:
          tagName: v__VERSION__
          releaseName: 'Org Viewer v__VERSION__'
          releaseBody: 'See CHANGELOG.md for details.'
```

---

## 8. Dependencies

### 8.1 Root package.json

```json
{
  "name": "org-viewer",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "tauri": "tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "turbo": "^2.0.0"
  }
}
```

### 8.2 Server Dependencies

```json
{
  "name": "@org-viewer/server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts --compile --outfile dist/server"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "gray-matter": "^4.0.3"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0"
  }
}
```

### 8.3 Client Dependencies

```json
{
  "name": "@org-viewer/client",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0",
    "react-markdown": "^9.0.0",
    "remark-gfm": "^4.0.0",
    "framer-motion": "^11.5.0",
    "d3": "^7.9.0",
    "highlight.js": "^11.10.0",
    "katex": "^0.16.11",
    "marked": "^14.0.0",
    "marked-katex-extension": "^5.1.0",
    "fuse.js": "^7.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/d3": "^7.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vite-plugin-pwa": "^0.20.0",
    "workbox-precaching": "^7.1.0",
    "workbox-routing": "^7.1.0",
    "workbox-strategies": "^7.1.0"
  }
}
```

### 8.4 MCP Dependencies

```json
{
  "name": "@org-viewer/mcp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0"
  }
}
```

### 8.5 Tauri Cargo.toml

```toml
[package]
name = "org-viewer"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2.0", features = ["tray-icon"] }
tauri-plugin-shell = "2.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

[build-dependencies]
tauri-build = { version = "2.0", features = [] }
```

---

## 9. Implementation Phases

### Phase 1: Server Foundation (Day 1)
- [ ] Set up monorepo structure
- [ ] Implement Bun + Hono server with file listing
- [ ] Add gray-matter parsing for frontmatter
- [ ] Implement wikilink extraction
- [ ] Add WebSocket live reload

### Phase 2: Client Core (Day 2)
- [ ] Port OrgApp, OrgDocumentList, OrgDocumentView from amore.build
- [ ] Port theme system (23 themes)
- [ ] Port TUI markdown renderer
- [ ] Implement live reload hook

### Phase 3: Full Features (Day 3)
- [ ] Implement search (Fuse.js)
- [ ] Port OrgGraph (D3 visualization)
- [ ] Add PWA manifest and service worker
- [ ] Settings view (theme picker)

### Phase 4: Tauri Integration (Day 4)
- [ ] Set up Tauri v2 project
- [ ] Configure server as sidecar
- [ ] Implement system tray
- [ ] Add IPC commands

### Phase 5: MCP Server (Day 5)
- [ ] Implement MCP tool definitions
- [ ] Add HTTP communication with server
- [ ] Test Claude Code integration

### Phase 6: Polish and Build (Day 6)
- [ ] Cross-platform testing
- [ ] CI/CD setup
- [ ] Documentation
- [ ] First release

---

## 10. Open Questions Resolved

| Question | Decision | Rationale |
|----------|----------|-----------|
| Separate repo or in template? | **Separate repo** | Can be added to template as git submodule or npm package |
| Tailscale setup guidance? | **README + first-run dialog** | Keep simple; most users already have Tailscale |
| Port components or build fresh? | **Port from amore.build** | Proven TUI rendering, saves significant time |
