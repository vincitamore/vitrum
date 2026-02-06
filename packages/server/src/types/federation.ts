// Federation types for cross-org collaboration

export interface PeerConfig {
  self: {
    instanceId: string;
    displayName: string;
    sharedFolders: string[];
    sharedTags: string[];
  };
  peers: PeerEntry[];
}

export interface PeerEntry {
  name: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
}

export interface PeerHelloResponse {
  instanceId: string;
  displayName: string;
  apiVersion: string;
  sharedFolders: string[];
  sharedTags: string[];
  stats: {
    documentCount: number;
    knowledgeCount: number;
    taskCount: number;
  };
  online: true;
  uptime: number;
}

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

export interface FederationMeta {
  'origin-peer': string;
  'origin-name': string;
  'origin-host': string;
  'origin-path': string;
  'adopted-at': string;
  'origin-checksum': string;
  'local-checksum': string;
  'sync-status': SyncStatus;
  'last-sync-check': string;
}

export type SyncStatus = 'synced' | 'local-modified' | 'origin-modified' | 'conflict' | 'rejected';

export interface SharedDocument {
  localPath: string;
  federation: FederationMeta;
  title: string;
  type: string;
  tags: string[];
}

export interface ConflictDiff {
  localContent: string;
  originContent: string;
  baseContent: string;
  localChecksum: string;
  originChecksum: string;
}

export type ResolutionAction = 'accept-origin' | 'keep-local' | 'merge' | 'reject';

export interface Resolution {
  action: ResolutionAction;
  mergedContent?: string;
  comment?: string;
}

export interface IncomingDocument {
  from: {
    instanceId: string;
    displayName: string;
    host: string;
  };
  document: {
    title: string;
    content: string;
    tags: string[];
    sourcePath: string;
  };
  message?: string;
}

export interface FederationResponse {
  from: {
    instanceId: string;
    displayName: string;
  };
  action: 'rejected' | 'accepted';
  originalPath: string;
  comment?: string;
}
