import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { PeerConfig, PeerEntry, PeerLiveStatus, PeerHelloResponse } from '../types/federation';

const PEER_CONFIG_FILE = '.vitrum-peers.json';
const POLL_INTERVAL_MS = 30_000;
const BACKOFF_INTERVAL_MS = 120_000;
const FAILURE_THRESHOLD = 3;
const HELLO_TIMEOUT_MS = 3_000;

export class PeerRegistry {
  private config: PeerConfig;
  private configPath: string;
  private peerStatus: Map<string, PeerLiveStatus> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onStatusChange?: (peer: PeerLiveStatus) => void;

  constructor(orgRoot: string) {
    this.configPath = join(orgRoot, PEER_CONFIG_FILE);
    this.config = this.loadOrCreate();
    this.initPeerStatus();
  }

  private loadOrCreate(): PeerConfig {
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        return JSON.parse(raw);
      } catch (e) {
        console.error(`Failed to parse ${PEER_CONFIG_FILE}:`, e);
      }
    }

    // Create default config
    const config: PeerConfig = {
      self: {
        instanceId: randomUUID(),
        displayName: 'My Org',
        sharedFolders: ['knowledge/'],
        sharedTags: [],
      },
      peers: [],
    };

    this.save(config);
    console.log(`Created ${PEER_CONFIG_FILE} with instanceId: ${config.self.instanceId}`);
    return config;
  }

  private save(config: PeerConfig): void {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  private initPeerStatus(): void {
    for (const peer of this.config.peers) {
      const key = `${peer.host}:${peer.port}`;
      this.peerStatus.set(key, {
        name: peer.name,
        host: peer.host,
        port: peer.port,
        protocol: peer.protocol,
        status: 'unknown',
        consecutiveFailures: 0,
      });
    }
  }

  getSelf() {
    return this.config.self;
  }

  getPeers(): PeerEntry[] {
    return this.config.peers;
  }

  getPeerStatus(): PeerLiveStatus[] {
    return Array.from(this.peerStatus.values());
  }

  getOnlinePeers(): PeerLiveStatus[] {
    return this.getPeerStatus().filter(p => p.status === 'online');
  }

  isPeerRegistered(host: string): boolean {
    return this.config.peers.some(
      p => p.host === host || p.host.split('.')[0] === host.split('.')[0]
    );
  }

  getPeerByHost(host: string): PeerEntry | undefined {
    return this.config.peers.find(
      p => p.host === host || p.host.split('.')[0] === host.split('.')[0]
    );
  }

  onPeerStatusChange(callback: (peer: PeerLiveStatus) => void) {
    this.onStatusChange = callback;
  }

  startPolling(): void {
    if (this.pollTimer) return;

    // Initial poll
    this.pollAllPeers();

    // Set up interval
    this.pollTimer = setInterval(() => {
      this.pollAllPeers();
    }, POLL_INTERVAL_MS);

    console.log(`Peer polling started (${POLL_INTERVAL_MS / 1000}s interval, ${this.config.peers.length} peers)`);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollAllPeers(): Promise<void> {
    // Hot-reload config if changed on disk
    this.checkConfigReload();

    const promises = this.config.peers.map(peer => this.pollPeer(peer));
    await Promise.allSettled(promises);
  }

  private lastConfigMtime = 0;

  private checkConfigReload(): void {
    try {
      const file = Bun.file(this.configPath);
      // Use sync file read to check mtime
      const stat = require('fs').statSync(this.configPath);
      const mtime = stat.mtimeMs;
      if (mtime > this.lastConfigMtime) {
        if (this.lastConfigMtime > 0) {
          // Config changed — reload
          const oldPeerCount = this.config.peers.length;
          this.config = this.loadOrCreate();

          // Reconcile peer status map: add new peers, keep existing status for known peers
          const currentKeys = new Set(this.peerStatus.keys());
          const newKeys = new Set(this.config.peers.map(p => `${p.host}:${p.port}`));

          // Add new peers
          for (const peer of this.config.peers) {
            const key = `${peer.host}:${peer.port}`;
            if (!this.peerStatus.has(key)) {
              this.peerStatus.set(key, {
                name: peer.name,
                host: peer.host,
                port: peer.port,
                protocol: peer.protocol,
                status: 'unknown',
                consecutiveFailures: 0,
              });
            }
          }

          // Remove peers no longer in config
          for (const key of currentKeys) {
            if (!newKeys.has(key)) {
              this.peerStatus.delete(key);
            }
          }

          if (this.config.peers.length !== oldPeerCount) {
            console.log(`Peer config hot-reloaded: ${oldPeerCount} → ${this.config.peers.length} peers`);
          }
        }
        this.lastConfigMtime = mtime;
      }
    } catch {
      // Config file might not exist yet, ignore
    }
  }

  private async pollPeer(peer: PeerEntry): Promise<void> {
    const key = `${peer.host}:${peer.port}`;
    const status = this.peerStatus.get(key);
    if (!status) return;

    // Skip if in backoff
    if (status.consecutiveFailures >= FAILURE_THRESHOLD) {
      // Only poll at backoff interval
      const lastSeen = status.lastSeen ? new Date(status.lastSeen).getTime() : 0;
      if (Date.now() - lastSeen < BACKOFF_INTERVAL_MS) {
        return;
      }
    }

    const url = `${peer.protocol}://${peer.host}:${peer.port}/api/federation/hello`;
    const startMs = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HELLO_TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as PeerHelloResponse;
      const latencyMs = Date.now() - startMs;
      const oldStatus = status.status;

      status.status = 'online';
      status.instanceId = data.instanceId;
      status.displayName = data.displayName;
      status.sharedFolders = data.sharedFolders;
      status.sharedTags = data.sharedTags;
      status.documentCount = data.stats.documentCount;
      status.lastSeen = new Date().toISOString();
      status.latencyMs = latencyMs;
      status.consecutiveFailures = 0;

      if (oldStatus !== 'online' && this.onStatusChange) {
        this.onStatusChange(status);
      }
    } catch (e) {
      const oldStatus = status.status;
      status.consecutiveFailures++;
      status.status = 'offline';

      if (oldStatus === 'online' && this.onStatusChange) {
        this.onStatusChange(status);
      }
    }
  }

  // Reload config from disk (for hot-reload when user edits config)
  reload(): void {
    this.config = this.loadOrCreate();
    this.initPeerStatus();
    console.log(`Peer config reloaded: ${this.config.peers.length} peers`);
  }
}
