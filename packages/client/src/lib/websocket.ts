/**
 * WebSocket client for live reload
 */

type ReloadCallback = () => void;
type UpdateCallback = (path: string) => void;

class LiveReloadClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private onReloadCallbacks: ReloadCallback[] = [];
  private onUpdateCallbacks: UpdateCallback[] = [];
  private onRemoveCallbacks: UpdateCallback[] = [];

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('Live reload connected');
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch {
          // Ignore parse errors
        }
      };

      this.ws.onclose = () => {
        console.log('Live reload disconnected, reconnecting...');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  private handleMessage(message: { type: string; path?: string }) {
    switch (message.type) {
      case 'reload':
        this.onReloadCallbacks.forEach(cb => cb());
        break;
      case 'update':
        if (message.path) {
          this.onUpdateCallbacks.forEach(cb => cb(message.path!));
        }
        break;
      case 'remove':
        if (message.path) {
          this.onRemoveCallbacks.forEach(cb => cb(message.path!));
        }
        break;
    }
  }

  onReload(callback: ReloadCallback) {
    this.onReloadCallbacks.push(callback);
    return () => {
      this.onReloadCallbacks = this.onReloadCallbacks.filter(cb => cb !== callback);
    };
  }

  onUpdate(callback: UpdateCallback) {
    this.onUpdateCallbacks.push(callback);
    return () => {
      this.onUpdateCallbacks = this.onUpdateCallbacks.filter(cb => cb !== callback);
    };
  }

  onRemove(callback: UpdateCallback) {
    this.onRemoveCallbacks.push(callback);
    return () => {
      this.onRemoveCallbacks = this.onRemoveCallbacks.filter(cb => cb !== callback);
    };
  }
}

export const liveReload = new LiveReloadClient();
