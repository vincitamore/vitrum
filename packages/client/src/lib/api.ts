/**
 * API client for Vitrum server
 *
 * DIAGNOSTIC VERSION - logs via Tauri IPC
 */

const SERVER_URL = 'http://127.0.0.1:3847';

// Log via Tauri IPC (bypasses mixed content restrictions)
async function log(msg: string) {
  try {
    // Only use Tauri IPC when running inside the Tauri WebView
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('frontend_log', { msg });
    }
  } catch {
    // ignore
  }
}

// Sync version for immediate logging (best effort)
function logSync(msg: string) {
  log(msg); // fire and forget
}

// Log startup immediately
logSync('api.ts loading, __TAURI__ in window: ' + ('__TAURI__' in window));

// Cached Tauri fetch function
let tauriFetch: typeof fetch | null = null;
let tauriFetchInitialized = false;

// Try to load Tauri HTTP plugin's fetch
async function getTauriFetch(): Promise<typeof fetch | null> {
  logSync(`getTauriFetch called, initialized=${tauriFetchInitialized}`);

  if (tauriFetchInitialized) {
    logSync(`returning cached tauriFetch: ${tauriFetch ? 'exists' : 'null'}`);
    return tauriFetch;
  }

  tauriFetchInitialized = true;

  // Only attempt Tauri fetch when running inside the Tauri WebView.
  // In a regular browser (remote/Tailscale access), skip straight to browser fetch.
  if (!('__TAURI_INTERNALS__' in window)) {
    logSync('not in Tauri WebView, skipping plugin import');
    return null;
  }

  try {
    logSync('attempting to import @tauri-apps/plugin-http...');
    const plugin = await import('@tauri-apps/plugin-http');
    logSync(`import succeeded, plugin keys: ${Object.keys(plugin).join(',')}`);

    if (plugin.fetch) {
      tauriFetch = plugin.fetch;
      logSync('tauriFetch assigned successfully');
      return tauriFetch;
    } else {
      logSync('plugin.fetch is undefined!');
      return null;
    }
  } catch (e) {
    logSync(`import FAILED: ${e}`);
    return null;
  }
}

export interface FileListItem {
  path: string;
  title: string;
  type: string;
  status?: string;
  tags: string[];
  created?: string;
  updated?: string;
  linkCount: number;
  backlinkCount: number;
}

export interface OrgDocument {
  path: string;
  title: string;
  type: string;
  status?: string;
  tags: string[];
  content: string;
  links: string[];
  backlinks: string[];
  created?: string;
  updated?: string;
  resolvedBacklinks?: Array<{
    path: string;
    title: string;
    type: string;
  }>;
}

export interface SearchResult {
  path: string;
  title: string;
  type: string;
  status?: string;
  tags: string[];
  score?: number;
  snippet: string;
}

export interface GraphData {
  nodes: Array<{
    id: string;
    label: string;
    type: string;
    status?: string;
    linkCount: number;
  }>;
  links: Array<{
    source: string;
    target: string;
  }>;
}

export interface ServerStatus {
  server: {
    uptime: number;
    connectedClients: number;
    lastIndexed: string;
  };
  documents: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
  };
  tags: {
    total: number;
    top: Array<{ tag: string; count: number }>;
  };
  recent: Array<{
    path: string;
    title: string;
    type: string;
    updated: string;
  }>;
}

async function fetchJSON<T>(path: string): Promise<T> {
  logSync(`fetchJSON called for path: ${path}`);

  try {
    const tFetch = await getTauriFetch();
    logSync(`getTauriFetch returned: ${tFetch ? 'function' : 'null'}`);

    if (tFetch) {
      const url = `${SERVER_URL}/api${path}`;
      logSync(`using tauriFetch for: ${url}`);

      try {
        const response = await tFetch(url);
        logSync(`tauriFetch response status: ${response.status}`);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        logSync(`tauriFetch success, got data`);
        return data;
      } catch (fetchErr) {
        logSync(`tauriFetch FAILED: ${fetchErr}`);
        throw fetchErr;
      }
    }

    // Fallback to browser fetch
    const url = `/api${path}`;
    logSync(`using browser fetch for: ${url}`);

    const response = await fetch(url);
    logSync(`browser fetch response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  } catch (err) {
    logSync(`fetchJSON ERROR: ${err}`);
    throw err;
  }
}

async function fetchWithMethod<T>(path: string, method: string): Promise<T> {
  const tFetch = await getTauriFetch();

  if (tFetch) {
    const url = `${SERVER_URL}/api${path}`;
    const response = await tFetch(url, { method });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  }

  const response = await fetch(`/api${path}`, { method });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  logSync(`postJSON called for path: ${path}`);

  const tFetch = await getTauriFetch();

  if (tFetch) {
    const url = `${SERVER_URL}/api${path}`;
    const response = await tFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  }

  const url = `/api${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

async function putJSON<T>(path: string, body: unknown): Promise<T> {
  logSync(`putJSON called for path: ${path}`);

  const tFetch = await getTauriFetch();

  if (tFetch) {
    const url = `${SERVER_URL}/api${path}`;
    logSync(`using tauriFetch PUT for: ${url}`);

    const response = await tFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    logSync(`tauriFetch PUT response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    // PUT returns 200 OK with no body
    return {} as T;
  }

  // Fallback to browser fetch
  const url = `/api${path}`;
  logSync(`using browser fetch PUT for: ${url}`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return {} as T;
}

export const api = {
  // Files
  async listFiles(filters?: { type?: string; tag?: string; folder?: string }): Promise<{ count: number; items: FileListItem[] }> {
    const params = new URLSearchParams();
    if (filters?.type) params.set('type', filters.type);
    if (filters?.tag) params.set('tag', filters.tag);
    if (filters?.folder) params.set('folder', filters.folder);
    const query = params.toString();
    return fetchJSON(`/files${query ? `?${query}` : ''}`);
  },

  async getFile(path: string): Promise<OrgDocument> {
    return fetchJSON(`/files/${path}`);
  },

  async updateFile(
    path: string,
    frontmatter: Record<string, unknown>,
    content: string
  ): Promise<void> {
    await putJSON(`/files/${path}`, { frontmatter, content });
  },

  // Search
  async search(query: string, filters?: { type?: string; tag?: string; limit?: number }): Promise<{ query: string; count: number; total: number; items: SearchResult[] }> {
    const params = new URLSearchParams({ q: query });
    if (filters?.type) params.set('type', filters.type);
    if (filters?.tag) params.set('tag', filters.tag);
    if (filters?.limit) params.set('limit', String(filters.limit));
    return fetchJSON(`/search?${params}`);
  },

  // Graph
  async getGraph(folder?: string): Promise<GraphData> {
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    return fetchJSON(`/graph${params}`);
  },

  async getNeighbors(path: string): Promise<{ center: string; nodes: GraphData['nodes']; links: GraphData['links'] }> {
    return fetchJSON(`/graph/neighbors/${path}`);
  },

  // Status
  async getStatus(): Promise<ServerStatus> {
    return fetchJSON('/status');
  },

  async reindex(): Promise<{ success: boolean; stats: { documentCount: number; lastIndexed: string } }> {
    return fetchWithMethod('/status/reindex', 'POST');
  },

  // Health
  async health(): Promise<{ status: string; timestamp: string }> {
    return fetchJSON('/health');
  },

  // Projects
  async listProjects(): Promise<Project[]> {
    return fetchJSON('/projects');
  },

  async getProjectTree(name: string): Promise<TreeEntry[]> {
    return fetchJSON(`/projects/${encodeURIComponent(name)}/tree`);
  },

  async getProjectFile(project: string, path: string): Promise<ProjectFile> {
    return fetchJSON(`/projects/${encodeURIComponent(project)}/file/${path}`);
  },

  async updateProjectFile(project: string, path: string, content: string): Promise<void> {
    await putJSON(`/projects/${encodeURIComponent(project)}/file/${path}`, { content });
  },
};

// --- Project Types ---

export interface Project {
  name: string;
  hasReadme: boolean;
  hasClaude: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  language?: string;
  children?: TreeEntry[];
}

export interface ProjectFile {
  path: string;
  content: string;
  language: string | null;
  size: number;
}

// --- Federation Types ---

export interface PeerLiveStatus {
  name: string;
  host: string;
  port: number;
  protocol: string;
  status: 'online' | 'offline' | 'unknown';
  instanceId?: string;
  displayName?: string;
  sharedFolders?: string[];
  sharedTags?: string[];
  documentCount?: number;
  lastSeen?: string;
  latencyMs?: number;
  consecutiveFailures: number;
}

export interface FederationPeersResponse {
  self: {
    instanceId: string;
    displayName: string;
    host: string;
    port: number;
  };
  peers: PeerLiveStatus[];
}

export interface CrossOrgSearchResult {
  peer: string;
  peerId: string;
  peerHost: string;
  path: string;
  title: string;
  type: string;
  tags: string[];
  score: number;
  snippet: string;
}

export interface CrossOrgSearchResponse {
  query: string;
  results: CrossOrgSearchResult[];
  totalPeersQueried: number;
  totalPeersResponded: number;
  peerResults: Record<string, { count: number; took: number }>;
}

export interface PeerFileListItem {
  path: string;
  title: string;
  type: string;
  tags: string[];
  created?: string;
  updated?: string;
  excerpt?: string;
}

export interface PeerFileListResponse {
  instanceId: string;
  displayName: string;
  count: number;
  items: PeerFileListItem[];
}

export interface PeerDocument {
  path: string;
  title: string;
  type: string;
  tags: string[];
  content: string;
  frontmatter: Record<string, unknown>;
  created?: string;
  updated?: string;
  links: string[];
  backlinks: string[];
  checksum: string;
}

export interface FederationMetaClient {
  'origin-peer': string;
  'origin-name': string;
  'origin-host': string;
  'origin-path': string;
  'adopted-at': string;
  'origin-checksum': string;
  'local-checksum': string;
  'sync-status': 'synced' | 'local-modified' | 'origin-modified' | 'conflict' | 'rejected';
  'last-sync-check': string;
}

export interface SharedDocumentItem {
  localPath: string;
  title: string;
  type: string;
  tags: string[];
  federation: FederationMetaClient;
}

export interface SharedDocumentsResponse {
  count: number;
  items: SharedDocumentItem[];
}

export interface ConflictDiffResponse {
  localContent: string;
  originContent: string;
  baseContent: string;
  localChecksum: string;
  originChecksum: string;
}

export type ResolutionAction = 'accept-origin' | 'keep-local' | 'merge' | 'reject';

// --- Federation API ---

export const federationApi = {
  async getPeers(): Promise<FederationPeersResponse> {
    return fetchJSON('/federation/peers');
  },

  async crossSearch(query: string, filters?: { type?: string; tag?: string; limit?: number }): Promise<CrossOrgSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (filters?.type) params.set('type', filters.type);
    if (filters?.tag) params.set('tag', filters.tag);
    if (filters?.limit) params.set('limit', String(filters.limit));
    return fetchJSON(`/federation/cross-search?${params}`);
  },

  async browsePeerFiles(peerHost: string, filters?: { folder?: string; tag?: string }): Promise<PeerFileListResponse> {
    const params = new URLSearchParams({ peer: peerHost });
    if (filters?.folder) params.set('folder', filters.folder);
    if (filters?.tag) params.set('tag', filters.tag);
    return fetchJSON(`/federation/cross-files?${params}`);
  },

  async getPeerDocument(peerHost: string, path: string): Promise<PeerDocument> {
    return fetchJSON(`/federation/cross-file/${path}?peer=${encodeURIComponent(peerHost)}`);
  },

  async adoptDocument(params: {
    peerId: string;
    peerHost: string;
    sourcePath: string;
    targetPath?: string;
  }): Promise<{ success: boolean; localPath: string; checksum: string }> {
    return postJSON('/federation/adopt', params);
  },

  async sendDocument(params: {
    peerHost: string;
    sourcePath: string;
    message?: string;
  }): Promise<{ success: boolean; sentTo: string }> {
    return postJSON('/federation/send', params);
  },

  async getSharedDocuments(): Promise<SharedDocumentsResponse> {
    return fetchJSON('/federation/shared');
  },

  async getConflictDiff(path: string): Promise<ConflictDiffResponse> {
    return fetchJSON(`/federation/shared/diff?path=${encodeURIComponent(path)}`);
  },

  async resolveConflict(params: {
    path: string;
    action: ResolutionAction;
    mergedContent?: string;
    comment?: string;
  }): Promise<{ success: boolean; path: string; action: string }> {
    return postJSON('/federation/shared/resolve', params);
  },
};

logSync('api.ts fully loaded');
