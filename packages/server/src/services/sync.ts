import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import type { DocumentIndex } from './index';
import type { PeerRegistry } from './peers';
import type { FederationMeta, SyncStatus } from '../types/federation';

/**
 * SyncService manages document adoption, shared document tracking,
 * and conflict detection for federation.
 */
export class SyncService {
  constructor(
    private orgRoot: string,
    private index: DocumentIndex,
    private peerRegistry: PeerRegistry,
  ) {}

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
