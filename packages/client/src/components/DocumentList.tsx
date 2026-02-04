import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type FileListItem } from '../lib/api';
import { liveReload } from '../lib/websocket';

interface DocumentListProps {
  type: 'task' | 'knowledge' | 'inbox';
  title: string;
  onSelect: (path: string) => void;
}

export default function DocumentList({ type, title, onSelect }: DocumentListProps) {
  const [documents, setDocuments] = useState<FileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const fetchDocuments = useCallback(async () => {
    try {
      setLoading(true);

      if (searchQuery) {
        const result = await api.search(searchQuery, { type });
        setDocuments(result.items.map(r => ({
          path: r.path,
          title: r.title,
          type: r.type,
          status: r.status,
          tags: r.tags,
          linkCount: 0,
          backlinkCount: 0,
        })));
      } else {
        const result = await api.listFiles({ type });
        let items = result.items;

        if (statusFilter) {
          items = items.filter(d => d.status === statusFilter);
        }

        setDocuments(items);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [type, searchQuery, statusFilter]);

  useEffect(() => {
    fetchDocuments();

    const unsubUpdate = liveReload.onUpdate(() => fetchDocuments());
    const unsubRemove = liveReload.onRemove(() => fetchDocuments());

    return () => {
      unsubUpdate();
      unsubRemove();
    };
  }, [fetchDocuments]);

  // Reset selection when documents change
  useEffect(() => {
    setSelectedIndex(0);
  }, [documents]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (documents.length === 0) return;
      if (document.activeElement?.tagName === 'INPUT') return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, documents.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (documents[selectedIndex]) {
          onSelect(documents[selectedIndex].path);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [documents, selectedIndex, onSelect]);

  // Scroll selected item into view
  useEffect(() => {
    const item = itemRefs.current[selectedIndex];
    if (item) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  const statusOptions = type === 'task' ? ['active', 'blocked', 'paused', 'complete'] : [];

  if (loading && documents.length === 0) {
    return (
      <div className="text-center py-8" style={{ color: 'var(--term-muted)' }}>
        Loading {title.toLowerCase()}...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8" style={{ color: 'var(--term-error)' }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 style={{ color: 'var(--term-primary)' }} className="text-lg font-bold">
          {title}
          <span className="ml-2 text-sm font-normal" style={{ color: 'var(--term-muted)' }}>
            ({documents.length})
          </span>
        </h1>
        <span className="text-xs hidden sm:block" style={{ color: 'var(--term-muted)' }}>
          [j/k] navigate • [Enter] open
        </span>
      </div>

      {/* Filters */}
      <div className="flex gap-4 flex-wrap">
        <input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-2 border bg-transparent outline-none focus:border-[var(--term-primary)]"
          style={{ borderColor: 'var(--term-border)', color: 'var(--term-foreground)' }}
        />

        {statusOptions.length > 0 && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border bg-transparent outline-none cursor-pointer"
            style={{
              borderColor: 'var(--term-border)',
              color: 'var(--term-foreground)',
              backgroundColor: 'var(--term-background)',
            }}
          >
            <option value="">All statuses</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Document list */}
      <div className="space-y-2">
        {documents.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--term-muted)' }}>
            No {title.toLowerCase()} found
          </div>
        ) : (
          documents.map((doc, index) => (
            <button
              key={doc.path}
              ref={(el) => { itemRefs.current[index] = el; }}
              onClick={() => onSelect(doc.path)}
              className="w-full text-left px-4 py-3 border transition-colors"
              style={{
                borderColor: index === selectedIndex ? 'var(--term-primary)' : 'var(--term-border)',
                backgroundColor: index === selectedIndex ? 'var(--term-selection)' : 'transparent',
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div style={{ color: 'var(--term-foreground)' }}>{doc.title}</div>
                  <div className="text-sm mt-1" style={{ color: 'var(--term-muted)' }}>
                    {doc.path}
                  </div>
                  {doc.tags.length > 0 && (
                    <div className="flex gap-2 mt-2 flex-wrap">
                      {doc.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2 py-0.5"
                          style={{
                            backgroundColor: 'var(--term-selection)',
                            color: 'var(--term-info)',
                          }}
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {doc.status && (
                  <span
                    className="text-xs px-2 py-1 shrink-0"
                    style={{
                      backgroundColor: 'var(--term-selection)',
                      color: doc.status === 'active' ? 'var(--term-success)' :
                             doc.status === 'blocked' ? 'var(--term-error)' :
                             doc.status === 'paused' ? 'var(--term-warning)' :
                             'var(--term-muted)',
                    }}
                  >
                    {doc.status}
                  </span>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
