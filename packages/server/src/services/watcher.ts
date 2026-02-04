import { watch, type FSWatcher } from 'fs';
import { join, relative } from 'path';
import { readdirSync, statSync } from 'fs';
import type { DocumentIndex } from './index';

export type WatchCallback = (event: 'change' | 'add' | 'remove', path: string) => void;

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private orgRoot: string;
  private index: DocumentIndex;
  private onChangeCallbacks: WatchCallback[] = [];
  private debounceTimers: Map<string, Timer> = new Map();
  private debounceMs = 100;

  constructor(orgRoot: string, index: DocumentIndex) {
    this.orgRoot = orgRoot;
    this.index = index;
  }

  start(): void {
    this.watchDirectory(this.orgRoot);
    console.log(`Watching for changes in ${this.orgRoot}`);
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    console.log('File watcher stopped');
  }

  onChange(callback: WatchCallback): void {
    this.onChangeCallbacks.push(callback);
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Skip non-markdown files and hidden/node_modules
        if (!filename.endsWith('.md')) return;
        if (filename.includes('node_modules') || filename.startsWith('.')) return;

        const fullPath = join(dir, filename);
        const relativePath = relative(this.orgRoot, fullPath);

        // Debounce rapid changes
        const existing = this.debounceTimers.get(fullPath);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          fullPath,
          setTimeout(() => {
            this.handleChange(fullPath, relativePath);
            this.debounceTimers.delete(fullPath);
          }, this.debounceMs)
        );
      });

      this.watchers.push(watcher);
    } catch (e) {
      console.error(`Failed to watch ${dir}:`, e);
    }
  }

  private handleChange(fullPath: string, relativePath: string): void {
    try {
      // Check if file exists
      statSync(fullPath);

      // File exists - update or add
      const existing = this.index.get(relativePath);
      if (existing) {
        this.index.updateDocument(fullPath);
        this.notifyCallbacks('change', relativePath);
      } else {
        this.index.updateDocument(fullPath);
        this.notifyCallbacks('add', relativePath);
      }
    } catch (e) {
      // File doesn't exist - was removed
      this.index.removeDocument(relativePath);
      this.notifyCallbacks('remove', relativePath);
    }
  }

  private notifyCallbacks(event: 'change' | 'add' | 'remove', path: string): void {
    for (const callback of this.onChangeCallbacks) {
      try {
        callback(event, path);
      } catch (e) {
        console.error('Error in watch callback:', e);
      }
    }
  }
}
