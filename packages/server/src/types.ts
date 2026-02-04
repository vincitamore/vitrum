export interface OrgDocument {
  path: string;
  title: string;
  type: 'task' | 'knowledge' | 'inbox' | 'project' | 'tag' | 'other';
  status?: string;
  tags: string[];
  created: string;
  updated: string;
  excerpt: string;
  frontmatter: Record<string, unknown>;
  content: string;
  links: string[];
  backlinks: string[];
}

export interface FileListResponse {
  files: Array<{
    path: string;
    title: string;
    type: OrgDocument['type'];
    status?: string;
    tags: string[];
    created: string;
    updated: string;
    excerpt: string;
  }>;
  lastIndexed: string;
}

export interface FileResponse {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  content: string;
  links: string[];
  backlinks: string[];
  toc: Array<{ level: number; text: string; slug: string }>;
}

export interface SearchResponse {
  results: Array<{
    path: string;
    title: string;
    excerpt: string;
    score: number;
  }>;
  query: string;
  took: number;
}

export interface GraphResponse {
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

export interface StatusResponse {
  running: boolean;
  orgRoot: string;
  documentCount: number;
  lastIndexed: string;
  tailscale?: {
    available: boolean;
    hostname?: string;
    dnsName?: string;
    ip?: string;
  };
}

export interface TailscaleStatus {
  available: boolean;
  hostname?: string;
  dnsName?: string;
  ip?: string;
}
