import { useState, useEffect, useCallback } from 'react';
import {
  federationApi,
  type SharedDocumentItem,
  type SharedDocumentsResponse,
  type ConflictDiffResponse,
  type ResolutionAction,
} from '../lib/api';
import { liveReload } from '../lib/websocket';

interface SharedDocsViewProps {
  onSelectDocument: (path: string) => void;
}

type SyncStatus = SharedDocumentItem['federation']['sync-status'];

const STATUS_CONFIG: Record<SyncStatus, { label: string; color: string; icon: string }> = {
  'synced': { label: 'Synced', color: 'var(--term-success)', icon: '=' },
  'local-modified': { label: 'Local edit', color: 'var(--term-accent)', icon: '~' },
  'origin-modified': { label: 'Origin updated', color: 'var(--term-warning)', icon: '<' },
  'conflict': { label: 'Conflict', color: 'var(--term-error)', icon: '!' },
  'rejected': { label: 'Rejected', color: 'var(--term-muted)', icon: 'x' },
};

export default function SharedDocsView({ onSelectDocument }: SharedDocsViewProps) {
  const [data, setData] = useState<SharedDocumentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<ConflictDiffResponse | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [rejectComment, setRejectComment] = useState('');

  const fetchShared = useCallback(async () => {
    try {
      const result = await federationApi.getSharedDocuments();
      setData(result);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchShared();

    // Refresh on sync status changes
    const unsub = liveReload.onMessage((msg) => {
      if (msg.type === 'sync-status-changed') {
        fetchShared();
      }
    });

    const interval = setInterval(fetchShared, 30_000);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [fetchShared]);

  const handleViewDiff = useCallback(async (path: string) => {
    setDiffPath(path);
    setDiffData(null);
    setResolving(null);
    try {
      const diff = await federationApi.getConflictDiff(path);
      setDiffData(diff);
    } catch {
      setDiffData(null);
    }
  }, []);

  const handleResolve = useCallback(async (path: string, action: ResolutionAction, mergedContent?: string) => {
    setResolving(path);
    try {
      await federationApi.resolveConflict({
        path,
        action,
        mergedContent,
        comment: action === 'reject' ? rejectComment : undefined,
      });
      setDiffPath(null);
      setDiffData(null);
      setRejectComment('');
      await fetchShared();
    } catch {
      // ignore
    } finally {
      setResolving(null);
    }
  }, [rejectComment, fetchShared]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" style={{ color: 'var(--term-muted)' }}>
        Loading shared documents...
      </div>
    );
  }

  if (!data || data.count === 0) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <h2 style={{ color: 'var(--term-primary)' }} className="text-lg font-bold">
          Shared Documents
        </h2>
        <div
          className="border p-4 text-sm"
          style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}
        >
          No adopted documents. Browse a peer's shared folders and use the Adopt button to track documents.
        </div>
      </div>
    );
  }

  // Group by status
  const conflicts = data.items.filter(d => d.federation['sync-status'] === 'conflict');
  const originModified = data.items.filter(d => d.federation['sync-status'] === 'origin-modified');
  const localModified = data.items.filter(d => d.federation['sync-status'] === 'local-modified');
  const synced = data.items.filter(d => d.federation['sync-status'] === 'synced');
  const rejected = data.items.filter(d => d.federation['sync-status'] === 'rejected');

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 style={{ color: 'var(--term-primary)' }} className="text-lg font-bold">
          Shared Documents
        </h2>
        <div className="text-sm" style={{ color: 'var(--term-muted)' }}>
          {data.count} total
          {conflicts.length > 0 && (
            <span style={{ color: 'var(--term-error)' }}> &bull; {conflicts.length} conflict(s)</span>
          )}
          {originModified.length > 0 && (
            <span style={{ color: 'var(--term-warning)' }}> &bull; {originModified.length} updated</span>
          )}
        </div>
      </div>

      {/* Diff viewer overlay */}
      {diffPath && (
        <DiffViewer
          path={diffPath}
          diff={diffData}
          resolving={resolving}
          rejectComment={rejectComment}
          onRejectCommentChange={setRejectComment}
          onResolve={(action, mergedContent) => handleResolve(diffPath, action, mergedContent)}
          onClose={() => { setDiffPath(null); setDiffData(null); }}
        />
      )}

      {/* Conflicts (most urgent) */}
      {conflicts.length > 0 && (
        <StatusSection
          title="Conflicts"
          items={conflicts}
          onSelect={onSelectDocument}
          onViewDiff={handleViewDiff}
          onResolve={handleResolve}
          resolving={resolving}
        />
      )}

      {/* Origin updated */}
      {originModified.length > 0 && (
        <StatusSection
          title="Origin Updated"
          items={originModified}
          onSelect={onSelectDocument}
          onViewDiff={handleViewDiff}
          onResolve={handleResolve}
          resolving={resolving}
        />
      )}

      {/* Local modified */}
      {localModified.length > 0 && (
        <StatusSection
          title="Locally Modified"
          items={localModified}
          onSelect={onSelectDocument}
        />
      )}

      {/* Synced */}
      {synced.length > 0 && (
        <StatusSection
          title="Synced"
          items={synced}
          onSelect={onSelectDocument}
        />
      )}

      {/* Rejected */}
      {rejected.length > 0 && (
        <StatusSection
          title="Rejected (unlinked)"
          items={rejected}
          onSelect={onSelectDocument}
        />
      )}
    </div>
  );
}

// --- Sub-components ---

function StatusSection({
  title,
  items,
  onSelect,
  onViewDiff,
  onResolve,
  resolving,
}: {
  title: string;
  items: SharedDocumentItem[];
  onSelect: (path: string) => void;
  onViewDiff?: (path: string) => void;
  onResolve?: (path: string, action: ResolutionAction) => void;
  resolving?: string | null;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-bold" style={{ color: 'var(--term-muted)' }}>
        {title} ({items.length})
      </div>
      <div className="space-y-1">
        {items.map((item) => (
          <SharedDocCard
            key={item.localPath}
            item={item}
            onSelect={() => onSelect(item.localPath)}
            onViewDiff={onViewDiff ? () => onViewDiff(item.localPath) : undefined}
            onResolve={onResolve}
            resolving={resolving === item.localPath}
          />
        ))}
      </div>
    </div>
  );
}

function SharedDocCard({
  item,
  onSelect,
  onViewDiff,
  onResolve,
  resolving,
}: {
  item: SharedDocumentItem;
  onSelect: () => void;
  onViewDiff?: () => void;
  onResolve?: (path: string, action: ResolutionAction) => void;
  resolving?: boolean;
}) {
  const status = item.federation['sync-status'];
  const config = STATUS_CONFIG[status];
  const needsAction = status === 'conflict' || status === 'origin-modified';

  return (
    <div
      className="border p-3"
      style={{
        borderColor: needsAction ? config.color : 'var(--term-border)',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className="text-xs font-bold px-1 border shrink-0"
            style={{ borderColor: config.color, color: config.color }}
          >
            {config.icon}
          </span>
          <button
            onClick={onSelect}
            className="text-sm font-bold truncate hover:opacity-80 text-left"
            style={{ color: 'var(--term-foreground)' }}
          >
            {item.title}
          </button>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {needsAction && onViewDiff && (
            <button
              onClick={onViewDiff}
              className="px-2 py-1 text-xs border"
              style={{ borderColor: config.color, color: config.color }}
            >
              Diff
            </button>
          )}
          {status === 'origin-modified' && onResolve && (
            <button
              onClick={() => onResolve(item.localPath, 'accept-origin')}
              disabled={resolving}
              className="px-2 py-1 text-xs border"
              style={{
                borderColor: 'var(--term-success)',
                color: resolving ? 'var(--term-muted)' : 'var(--term-success)',
              }}
            >
              Accept
            </button>
          )}
        </div>
      </div>
      <div className="text-xs mt-1" style={{ color: 'var(--term-muted)' }}>
        {item.localPath}
        <span> &bull; from {item.federation['origin-name']}</span>
        {item.federation['adopted-at'] && (
          <span> &bull; adopted {formatRelativeTime(item.federation['adopted-at'])}</span>
        )}
      </div>
      {item.tags.length > 0 && (
        <div className="flex gap-1 mt-1">
          {item.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="text-xs px-1" style={{ color: 'var(--term-primary)', opacity: 0.6 }}>
              #{tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffViewer({
  path,
  diff,
  resolving,
  rejectComment,
  onRejectCommentChange,
  onResolve,
  onClose,
}: {
  path: string;
  diff: ConflictDiffResponse | null;
  resolving: string | null;
  rejectComment: string;
  onRejectCommentChange: (v: string) => void;
  onResolve: (action: ResolutionAction, mergedContent?: string) => void;
  onClose: () => void;
}) {
  const isResolving = resolving === path;

  return (
    <div
      className="border p-4 space-y-4"
      style={{ borderColor: 'var(--term-error)' }}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold" style={{ color: 'var(--term-error)' }}>
          Conflict: {path}
        </div>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 border"
          style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}
        >
          Close
        </button>
      </div>

      {!diff ? (
        <div className="text-sm" style={{ color: 'var(--term-muted)' }}>
          Loading diff...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            {/* Local version */}
            <div className="space-y-1">
              <div className="text-xs font-bold" style={{ color: 'var(--term-accent)' }}>
                YOUR VERSION
              </div>
              <pre
                className="text-xs p-2 border overflow-auto max-h-64"
                style={{
                  borderColor: 'var(--term-accent)',
                  color: 'var(--term-foreground)',
                  backgroundColor: 'var(--term-background)',
                }}
              >
                {diff.localContent.slice(0, 2000)}
                {diff.localContent.length > 2000 && '\n... (truncated)'}
              </pre>
            </div>

            {/* Origin version */}
            <div className="space-y-1">
              <div className="text-xs font-bold" style={{ color: 'var(--term-warning)' }}>
                ORIGIN VERSION
              </div>
              <pre
                className="text-xs p-2 border overflow-auto max-h-64"
                style={{
                  borderColor: 'var(--term-warning)',
                  color: 'var(--term-foreground)',
                  backgroundColor: 'var(--term-background)',
                }}
              >
                {diff.originContent.slice(0, 2000)}
                {diff.originContent.length > 2000 && '\n... (truncated)'}
              </pre>
            </div>
          </div>

          {/* Resolution buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => onResolve('accept-origin')}
              disabled={isResolving}
              className="px-3 py-1 text-sm border"
              style={{
                borderColor: 'var(--term-success)',
                color: isResolving ? 'var(--term-muted)' : 'var(--term-success)',
              }}
            >
              Accept Origin
            </button>
            <button
              onClick={() => onResolve('keep-local')}
              disabled={isResolving}
              className="px-3 py-1 text-sm border"
              style={{
                borderColor: 'var(--term-accent)',
                color: isResolving ? 'var(--term-muted)' : 'var(--term-accent)',
              }}
            >
              Keep Mine
            </button>
            <button
              onClick={() => onResolve('reject')}
              disabled={isResolving}
              className="px-3 py-1 text-sm border"
              style={{
                borderColor: 'var(--term-error)',
                color: isResolving ? 'var(--term-muted)' : 'var(--term-error)',
              }}
            >
              Reject
            </button>
          </div>

          {/* Reject comment input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={rejectComment}
              onChange={(e) => onRejectCommentChange(e.target.value)}
              placeholder="Optional comment (sent to origin on reject)..."
              className="flex-1 px-2 py-1 text-xs border bg-transparent"
              style={{
                borderColor: 'var(--term-border)',
                color: 'var(--term-foreground)',
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}w ago`;
}
