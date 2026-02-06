import type { ServerWebSocket } from 'bun';

export interface ReloadMessage {
  type: 'reload' | 'update' | 'remove' | 'peer-online' | 'peer-offline' | 'peer-document-received' | 'sync-status-changed';
  path?: string;
  peer?: string;
  host?: string;
  timestamp: number;
}

export class LiveReloadServer {
  private clients: Set<ServerWebSocket<unknown>> = new Set();

  addClient(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws);
    console.log(`Client connected. Total: ${this.clients.size}`);
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
    console.log(`Client disconnected. Total: ${this.clients.size}`);
  }

  broadcast(message: ReloadMessage): void {
    const json = JSON.stringify(message);
    for (const client of this.clients) {
      try {
        client.send(json);
      } catch (e) {
        console.error('Failed to send to client:', e);
        this.clients.delete(client);
      }
    }
  }

  notifyChange(path: string): void {
    this.broadcast({
      type: 'update',
      path,
      timestamp: Date.now(),
    });
  }

  notifyRemove(path: string): void {
    this.broadcast({
      type: 'remove',
      path,
      timestamp: Date.now(),
    });
  }

  notifyReload(): void {
    this.broadcast({
      type: 'reload',
      timestamp: Date.now(),
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
