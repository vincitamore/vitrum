/**
 * API client for org-viewer server
 *
 * DIAGNOSTIC VERSION - logs via Tauri IPC
 */

const SERVER_URL = 'http://127.0.0.1:3847';

// Log via Tauri IPC (bypasses mixed content restrictions)
async function log(msg: string) {
  try {
    // Try Tauri invoke for logging
    if ('__TAURI__' in window) {
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
};

logSync('api.ts fully loaded');
