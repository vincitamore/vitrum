import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import type { DocumentIndex } from './index';
import type { PeerRegistry } from './peers';
import type { FederationMeta, SyncStatus, ConflictDiff } from '../types/federation';

const SYNC_POLL_INTERVAL_MS = 60_000; // Check origins every 60s

type SyncStatusCallback = (event: {
  type: 'sync-status-changed';
  path: string;
  oldStatus: SyncStatus;
  newStatus: SyncStatus;
  peer?: string;
  timestamp: number;
}) => void;

/**
 * SyncService manages document adoption, shared document tracking,
 * and conflict detection for federation.
 */
export class SyncService {
  private syncPollTimer: ReturnType<typeof setInterval> | null = null;
  private onSyncStatusChange?: SyncStatusCallback;
  private getLocalHost: () => { host: string; port: number } | null = () => null;

  constructor(
    private orgRoot: string,
    private index: DocumentIndex,
    private peerRegistry: PeerRegistry,
  ) {}

  setLocalHostGetter(getter: () => { host: string; port: number } | null): void {
    this.getLocalHost = getter;
  }

  /**
   * Adopt a document from a peer: fetch it, write locally with federation frontmatter.
   */
  async adoptDocument(params: {
    peerId: string;
    peerHost: string;
    peerPort: number;
    peerProtocol: string;
    peerName: string;
    sourcePath: string;
    targetPath?: string;
  }): Promise<{ localPath: string; checksum: string }> {
    const {
      peerId, peerHost, peerPort, peerProtocol, peerName,
      sourcePath, targetPath,
    } = params;

    // Fetch the document from the peer
    const url = `${peerProtocol}://${peerHost}:${peerPort}/api/federation/files/${sourcePath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let peerDoc: {
      path: string;
      title: string;
      type: string;
      tags: string[];
      content: string;
      frontmatter: Record<string, unknown>;
      checksum: string;
    };

    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        throw new Error(`Peer returned ${resp.status}`);
      }

      peerDoc = await resp.json() as typeof peerDoc;
    } catch (e) {
      clearTimeout(timeout);
      throw new Error(`Failed to fetch document from peer: ${e}`);
    }

    // Determine local path
    const localPath = targetPath || sourcePath;
    const fullLocalPath = join(this.orgRoot, localPath);

    // Ensure directory exists
    const dir = dirname(fullLocalPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Build federation frontmatter
    const federation: FederationMeta = {
      'origin-peer': peerId,
      'origin-name': peerName,
      'origin-host': `${peerHost}:${peerPort}`,
      'origin-path': sourcePath,
      'adopted-at': new Date().toISOString(),
      'origin-checksum': peerDoc.checksum,
      'local-checksum': peerDoc.checksum,
      'sync-status': 'synced' as SyncStatus,
      'last-sync-check': new Date().toISOString(),
    };

    // Merge frontmatter: keep original type/tags, add federation block
    const mergedFrontmatter = {
      ...peerDoc.frontmatter,
      federation,
    };

    // Rebuild the document with federation frontmatter
    const yamlContent = buildYaml(mergedFrontmatter);
    const fullContent = `---\n${yamlContent}---\n${peerDoc.content}`;

    writeFileSync(fullLocalPath, fullContent, 'utf-8');
    console.log(`Adopted document: ${sourcePath} → ${localPath} (from ${peerName})`);

    return { localPath, checksum: peerDoc.checksum };
  }

  /**
   * Write an incoming document (sent by a peer) to the inbox.
   */
  writeIncomingDocument(params: {
    from: { instanceId: string; displayName: string; host: string };
    title: string;
    content: string;
    tags: string[];
    sourcePath: string;
    message?: string;
  }): string {
    const { from, title, content, tags, sourcePath, message } = params;

    // Generate inbox filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const filename = `${timestamp}-from-${from.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${slug}.md`;
    const inboxPath = join(this.orgRoot, 'inbox', filename);

    // Build inbox document
    const frontmatter = [
      '---',
      'type: inbox',
      `created: '${new Date().toISOString().slice(0, 10)}'`,
      'source: peer',
      `from-name: ${from.displayName}`,
      `from-instance: ${from.instanceId}`,
      `from-host: ${from.host}`,
      `original-path: ${sourcePath}`,
      `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
      '---',
    ].join('\n');

    let body = `# ${title}\n\n`;
    if (message) {
      body += `> **Message from ${from.displayName}**: ${message}\n\n`;
    }
    body += `*Shared from ${from.displayName} (${sourcePath})*\n\n---\n\n${content}`;

    writeFileSync(inboxPath, `${frontmatter}\n${body}`, 'utf-8');
    console.log(`Received document from ${from.displayName}: ${filename}`);

    return `inbox/${filename}`;
  }

  /**
   * Get all adopted (shared) documents by scanning index for federation frontmatter.
   */
  getSharedDocuments(): Array<{
    localPath: string;
    title: string;
    type: string;
    tags: string[];
    federation: FederationMeta;
  }> {
    const allDocs = this.index.getAll();
    const shared: Array<{
      localPath: string;
      title: string;
      type: string;
      tags: string[];
      federation: FederationMeta;
    }> = [];

    for (const doc of allDocs) {
      const fm = doc.frontmatter as Record<string, unknown>;
      if (fm?.federation && typeof fm.federation === 'object') {
        const fed = fm.federation as FederationMeta;
        if (fed['origin-peer']) {
          shared.push({
            localPath: doc.path,
            title: doc.title,
            type: doc.type,
            tags: doc.tags,
            federation: fed,
          });
        }
      }
    }

    return shared;
  }

  /**
   * Register callback for sync status changes.
   */
  onStatusChange(callback: SyncStatusCallback): void {
    this.onSyncStatusChange = callback;
  }

  /**
   * Start periodic origin-checksum polling for adopted documents.
   */
  startSyncPolling(): void {
    if (this.syncPollTimer) return;

    this.syncPollTimer = setInterval(() => {
      this.checkAllOrigins();
    }, SYNC_POLL_INTERVAL_MS);

    console.log(`Sync polling started (${SYNC_POLL_INTERVAL_MS / 1000}s interval)`);
  }

  /**
   * Stop sync polling.
   */
  stopSyncPolling(): void {
    if (this.syncPollTimer) {
      clearInterval(this.syncPollTimer);
      this.syncPollTimer = null;
    }
  }

  /**
   * Check a locally changed file — if it has federation frontmatter, update sync status.
   * Called by file watcher when a document changes.
   */
  handleLocalChange(path: string): void {
    const doc = this.index.get(path);
    if (!doc) return;

    const fm = doc.frontmatter as Record<string, unknown>;
    if (!fm?.federation || typeof fm.federation !== 'object') return;

    const fed = fm.federation as FederationMeta;
    if (!fed['origin-peer'] || fed['sync-status'] === 'rejected') return;

    // Compute current content checksum
    const currentChecksum = computeChecksum(doc.content);

    // If checksum differs from local-checksum, the user edited the file
    if (currentChecksum !== fed['local-checksum']) {
      const oldStatus = fed['sync-status'];
      const newStatus: SyncStatus =
        oldStatus === 'origin-modified' ? 'conflict' : 'local-modified';

      if (oldStatus !== newStatus) {
        // Update frontmatter in the file
        this.updateFederationField(path, {
          'local-checksum': currentChecksum,
          'sync-status': newStatus,
        });

        if (this.onSyncStatusChange) {
          this.onSyncStatusChange({
            type: 'sync-status-changed',
            path,
            oldStatus,
            newStatus,
            peer: fed['origin-name'],
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  /**
   * Poll all adopted documents' origins for changes.
   */
  private async checkAllOrigins(): Promise<void> {
    const shared = this.getSharedDocuments();
    if (shared.length === 0) return;

    for (const doc of shared) {
      if (doc.federation['sync-status'] === 'rejected') continue;

      await this.checkOriginChecksum(doc.localPath, doc.federation);
    }
  }

  /**
   * Check a single adopted document's origin for changes.
   */
  private async checkOriginChecksum(localPath: string, fed: FederationMeta): Promise<void> {
    const originHost = fed['origin-host'];
    const originPath = fed['origin-path'];

    // Find the peer
    const [host, portStr] = originHost.split(':');
    const peer = this.peerRegistry.getPeerStatus().find(
      p => p.host === host && p.port === parseInt(portStr || '3847')
    );

    if (!peer || peer.status !== 'online') return;

    const url = `${peer.protocol}://${peer.host}:${peer.port}/api/federation/files/${originPath}?checksumOnly=true`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!resp.ok) return;

      const data = await resp.json() as { checksum: string; updated: string };

      // If origin checksum changed since last known
      if (data.checksum !== fed['origin-checksum']) {
        const oldStatus = fed['sync-status'];
        const newStatus: SyncStatus =
          oldStatus === 'local-modified' ? 'conflict' : 'origin-modified';

        if (oldStatus !== newStatus) {
          this.updateFederationField(localPath, {
            'origin-checksum': data.checksum,
            'sync-status': newStatus,
            'last-sync-check': new Date().toISOString(),
          });

          if (this.onSyncStatusChange) {
            this.onSyncStatusChange({
              type: 'sync-status-changed',
              path: localPath,
              oldStatus,
              newStatus,
              peer: fed['origin-name'],
              timestamp: Date.now(),
            });
          }

          console.log(`Sync: ${localPath} ${oldStatus} → ${newStatus} (origin changed)`);
        }
      } else {
        // Just update last-sync-check
        this.updateFederationField(localPath, {
          'last-sync-check': new Date().toISOString(),
        });
      }
    } catch {
      // Origin unreachable — skip silently
    }
  }

  /**
   * Get a 3-way diff for conflict resolution.
   */
  async getConflictDiff(localPath: string): Promise<ConflictDiff | null> {
    const doc = this.index.get(localPath);
    if (!doc) return null;

    const fm = doc.frontmatter as Record<string, unknown>;
    if (!fm?.federation) return null;

    const fed = fm.federation as FederationMeta;
    const originHost = fed['origin-host'];
    const originPath = fed['origin-path'];

    // Fetch origin content
    const [host, portStr] = originHost.split(':');
    const peer = this.peerRegistry.getPeerStatus().find(
      p => p.host === host && p.port === parseInt(portStr || '3847')
    );

    if (!peer || peer.status !== 'online') return null;

    const url = `${peer.protocol}://${peer.host}:${peer.port}/api/federation/files/${originPath}`;

    try {
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) return null;

      const originDoc = await resp.json() as { content: string; checksum: string };

      return {
        localContent: doc.content,
        originContent: originDoc.content,
        baseContent: '', // In a full implementation, we'd store the base content at adoption time
        localChecksum: computeChecksum(doc.content),
        originChecksum: originDoc.checksum,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve a sync conflict.
   */
  async resolveConflict(localPath: string, action: 'accept-origin' | 'keep-local' | 'merge' | 'reject', mergedContent?: string, comment?: string): Promise<boolean> {
    const doc = this.index.get(localPath);
    if (!doc) return false;

    const fm = doc.frontmatter as Record<string, unknown>;
    if (!fm?.federation) return false;

    const fed = fm.federation as FederationMeta;
    const fullPath = join(this.orgRoot, localPath);

    switch (action) {
      case 'accept-origin': {
        // Fetch origin content and overwrite local
        const diff = await this.getConflictDiff(localPath);
        if (!diff) return false;

        // Read current file, replace content
        const raw = readFileSync(fullPath, 'utf-8');
        const fmEnd = raw.indexOf('---', raw.indexOf('---') + 3) + 3;
        const newFile = raw.slice(0, fmEnd) + '\n' + diff.originContent;
        writeFileSync(fullPath, newFile, 'utf-8');

        this.updateFederationField(localPath, {
          'local-checksum': diff.originChecksum,
          'origin-checksum': diff.originChecksum,
          'sync-status': 'synced' as SyncStatus,
          'last-sync-check': new Date().toISOString(),
        });
        break;
      }

      case 'keep-local': {
        // Acknowledge origin change but keep local content
        this.updateFederationField(localPath, {
          'sync-status': 'synced' as SyncStatus,
          'last-sync-check': new Date().toISOString(),
        });
        break;
      }

      case 'merge': {
        if (!mergedContent) return false;

        // Write merged content
        const raw = readFileSync(fullPath, 'utf-8');
        const fmEnd = raw.indexOf('---', raw.indexOf('---') + 3) + 3;
        const newFile = raw.slice(0, fmEnd) + '\n' + mergedContent;
        writeFileSync(fullPath, newFile, 'utf-8');

        const newChecksum = computeChecksum(mergedContent);
        this.updateFederationField(localPath, {
          'local-checksum': newChecksum,
          'sync-status': 'synced' as SyncStatus,
          'last-sync-check': new Date().toISOString(),
        });
        break;
      }

      case 'reject': {
        // Sever federation link
        this.updateFederationField(localPath, {
          'sync-status': 'rejected' as SyncStatus,
        });

        // Optionally send rejection comment back to origin
        if (comment) {
          const originHost = fed['origin-host'];
          const [host, portStr] = originHost.split(':');
          const peer = this.peerRegistry.getPeerStatus().find(
            p => p.host === host && p.port === parseInt(portStr || '3847')
          );

          if (peer && peer.status === 'online') {
            const self = this.peerRegistry.getSelf();
            const localHost = this.getLocalHost();
            try {
              await fetch(`${peer.protocol}://${peer.host}:${peer.port}/api/federation/shared/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: {
                    instanceId: self.instanceId,
                    displayName: self.displayName,
                    host: localHost ? `${localHost.host}:${localHost.port}` : 'unknown',
                  },
                  action: 'rejected',
                  originalPath: fed['origin-path'],
                  comment,
                }),
              });
            } catch {
              // Best effort
            }
          }
        }
        break;
      }
    }

    return true;
  }

  /**
   * Update specific federation fields in a document's frontmatter.
   * Reads the file, modifies the YAML, writes back.
   */
  private updateFederationField(localPath: string, updates: Partial<FederationMeta>): void {
    const fullPath = join(this.orgRoot, localPath);
    if (!existsSync(fullPath)) return;

    try {
      let content = readFileSync(fullPath, 'utf-8');

      for (const [key, value] of Object.entries(updates)) {
        // Simple regex replace in the federation YAML block
        const pattern = new RegExp(`(${key}:)\\s*'[^']*'`, 'g');
        const replacement = `$1 '${String(value).replace(/'/g, "''")}'`;

        if (content.match(pattern)) {
          content = content.replace(pattern, replacement);
        }
      }

      writeFileSync(fullPath, content, 'utf-8');
    } catch (e) {
      console.error(`Failed to update federation field in ${localPath}:`, e);
    }
  }
}

function computeChecksum(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return 'sha256:' + hasher.digest('hex');
}

/**
 * Simple YAML serializer for frontmatter.
 * Handles nested objects (federation block) and arrays.
 */
function buildYaml(obj: Record<string, unknown>, indent = 0): string {
  const prefix = '  '.repeat(indent);
  let result = '';

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result += `${prefix}${key}: null\n`;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        result += `${prefix}${key}: []\n`;
      } else {
        result += `${prefix}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            result += `${prefix}  - ${buildYaml(item as Record<string, unknown>, indent + 2).trimStart()}`;
          } else {
            result += `${prefix}  - ${yamlValue(item)}\n`;
          }
        }
      }
    } else if (typeof value === 'object') {
      result += `${prefix}${key}:\n`;
      result += buildYaml(value as Record<string, unknown>, indent + 1);
    } else {
      result += `${prefix}${key}: ${yamlValue(value)}\n`;
    }
  }

  return result;
}

function yamlValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quote strings that contain special chars
    if (value.includes(':') || value.includes('#') || value.includes("'") || value.includes('"') || value.includes('\n')) {
      return `'${value.replace(/'/g, "''")}'`;
    }
    return `'${value}'`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}
