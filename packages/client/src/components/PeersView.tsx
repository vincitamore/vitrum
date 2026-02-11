import { useState, useEffect, useCallback, useRef } from 'react';
import {
  federationApi,
  type FederationPeersResponse,
  type PeerLiveStatus,
  type CrossOrgSearchResponse,
  type PeerFileListItem,
} from '../lib/api';
import { liveReload } from '../lib/websocket';

interface PeersViewProps {
  onSelectPeerDocument: (peerHost: string, path: string) => void;
}

type SubView = 'overview' | 'search' | 'browse';

export default function PeersView({ onSelectPeerDocument }: PeersViewProps) {
  const [peersData, setPeersData] = useState<FederationPeersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [subView, setSubView] = useState<SubView>('overview');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CrossOrgSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Browse state
  const [browsePeer, setBrowsePeer] = useState<PeerLiveStatus | null>(null);
  const [browseFiles, setBrowseFiles] = useState<PeerFileListItem[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  const fetchPeers = useCallback(async () => {
    try {
      const data = await federationApi.getPeers();
      setPeersData(data);
    } catch {
      // Silently handle — federation may not be configured
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPeers();
    const interval = setInterval(fetchPeers, 15_000); // Refresh every 15s

    // Also refresh on websocket peer events
    const unsub = liveReload.onMessage((msg) => {
      if (msg.type === 'peer-online' || msg.type === 'peer-offline') {
        fetchPeers();
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [fetchPeers]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const results = await federationApi.crossSearch(searchQuery.trim());
      setSearchResults(results);
      setSubView('search');
    } catch {
      // Handle error
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  const handleBrowsePeer = useCallback(async (peer: PeerLiveStatus) => {
    setBrowsePeer(peer);
    setBrowseLoading(true);
    setSubView('browse');
    try {
      const data = await federationApi.browsePeerFiles(`${peer.host}:${peer.port}`);
      setBrowseFiles(data.items);
    } catch {
      setBrowseFiles([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" style={{ color: 'var(--term-muted)' }}>
        Loading peers...
      </div>
    );
  }

  if (!peersData) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <h2 style={{ color: 'var(--term-primary)' }}>Federation</h2>
        <div className="border p-4" style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}>
          No federation configured. Add peers to <code>.vitrum-peers.json</code> to enable cross-org collaboration.
        </div>
      </div>
    );
  }

  const onlinePeers = peersData.peers.filter(p => p.status === 'online');
  const offlinePeers = peersData.peers.filter(p => p.status !== 'online');

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 style={{ color: 'var(--term-primary)' }} className="text-lg font-bold">
          Federation Network
        </h2>
        <div className="text-sm" style={{ color: 'var(--term-muted)' }}>
          {peersData.self.displayName} &bull; {onlinePeers.length} online
        </div>
      </div>

      {/* Cross-org search bar */}
      <div className="flex gap-2">
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
          placeholder="Search across all peers..."
          className="flex-1 px-3 py-2 border text-sm bg-transparent"
          style={{
            borderColor: 'var(--term-border)',
            color: 'var(--term-foreground)',
          }}
        />
        <button
          onClick={handleSearch}
          disabled={searching || !searchQuery.trim()}
          className="px-4 py-2 border text-sm"
          style={{
            borderColor: 'var(--term-primary)',
            color: searching ? 'var(--term-muted)' : 'var(--term-primary)',
          }}
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {/* Sub-view tabs — show when search results or browse peer exist */}
      {(searchResults || browsePeer) && (
        <div className="flex gap-2">
          <button
            onClick={() => setSubView('overview')}
            className="px-3 py-1 text-sm border"
            style={{
              borderColor: subView === 'overview' ? 'var(--term-primary)' : 'var(--term-border)',
              color: subView === 'overview' ? 'var(--term-primary)' : 'var(--term-muted)',
            }}
          >
            Overview
          </button>
          {searchResults && (
            <button
              onClick={() => setSubView('search')}
              className="px-3 py-1 text-sm border"
              style={{
                borderColor: subView === 'search' ? 'var(--term-primary)' : 'var(--term-border)',
                color: subView === 'search' ? 'var(--term-primary)' : 'var(--term-muted)',
              }}
            >
              Results ({searchResults.results.length})
            </button>
          )}
          {browsePeer && (
            <button
              onClick={() => setSubView('browse')}
              className="px-3 py-1 text-sm border"
              style={{
                borderColor: subView === 'browse' ? 'var(--term-primary)' : 'var(--term-border)',
                color: subView === 'browse' ? 'var(--term-primary)' : 'var(--term-muted)',
              }}
            >
              {browsePeer.displayName || browsePeer.name}
            </button>
          )}
        </div>
      )}

      {/* Sub-view content */}
      {subView === 'overview' && (
        <div className="space-y-4">
          {/* Online peers */}
          {onlinePeers.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-bold" style={{ color: 'var(--term-success)' }}>
                Online ({onlinePeers.length})
              </div>
              <div className="grid gap-3">
                {onlinePeers.map(peer => (
                  <PeerCard
                    key={`${peer.host}:${peer.port}`}
                    peer={peer}
                    onBrowse={() => handleBrowsePeer(peer)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Offline peers */}
          {offlinePeers.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-bold" style={{ color: 'var(--term-muted)' }}>
                Offline ({offlinePeers.length})
              </div>
              <div className="grid gap-3">
                {offlinePeers.map(peer => (
                  <PeerCard
                    key={`${peer.host}:${peer.port}`}
                    peer={peer}
                    onBrowse={() => {}}
                  />
                ))}
              </div>
            </div>
          )}

          {/* No peers */}
          {peersData.peers.length === 0 && (
            <div className="border p-4 text-sm" style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}>
              No peers configured. Edit <code>.vitrum-peers.json</code> to add team members.
            </div>
          )}
        </div>
      )}

      {subView === 'search' && searchResults && (
        <SearchResultsView
          results={searchResults}
          onSelect={onSelectPeerDocument}
        />
      )}

      {subView === 'browse' && browsePeer && (
        <PeerBrowserView
          peer={browsePeer}
          files={browseFiles}
          loading={browseLoading}
          onSelect={(path) => onSelectPeerDocument(`${browsePeer.host}:${browsePeer.port}`, path)}
        />
      )}
    </div>
  );
}

// --- Sub-components ---

function PeerCard({ peer, onBrowse }: { peer: PeerLiveStatus; onBrowse: () => void }) {
  const isOnline = peer.status === 'online';

  return (
    <div
      className="border p-3 flex items-center justify-between"
      style={{
        borderColor: isOnline ? 'var(--term-primary)' : 'var(--term-border)',
        opacity: isOnline ? 1 : 0.5,
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: isOnline ? 'var(--term-success)' : 'var(--term-error)' }}
        />
        <div>
          <div className="font-bold text-sm" style={{ color: 'var(--term-foreground)' }}>
            {peer.displayName || peer.name}
          </div>
          <div className="text-xs" style={{ color: 'var(--term-muted)' }}>
            {peer.host}:{peer.port}
            {isOnline && peer.latencyMs != null && (
              <span> &bull; {peer.latencyMs}ms</span>
            )}
            {isOnline && peer.documentCount != null && (
              <span> &bull; {peer.documentCount} docs</span>
            )}
          </div>
        </div>
      </div>
      {isOnline && (
        <button
          onClick={onBrowse}
          className="px-3 py-1 text-sm border"
          style={{ borderColor: 'var(--term-border)', color: 'var(--term-primary)' }}
        >
          Browse
        </button>
      )}
    </div>
  );
}

function SearchResultsView({
  results,
  onSelect,
}: {
  results: CrossOrgSearchResponse;
  onSelect: (peerHost: string, path: string) => void;
}) {
  if (results.results.length === 0) {
    return (
      <div className="border p-4 text-sm" style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}>
        No results found across {results.totalPeersQueried} peer(s).
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm" style={{ color: 'var(--term-muted)' }}>
        {results.results.length} result(s) from {results.totalPeersResponded} peer(s)
        {Object.entries(results.peerResults).map(([name, info]) => (
          <span key={name}> &bull; {name}: {info.count} ({info.took}ms)</span>
        ))}
      </div>
      {results.results.map((result, i) => (
        <button
          key={`${result.peerHost}-${result.path}-${i}`}
          onClick={() => onSelect(result.peerHost, result.path)}
          className="w-full text-left border p-3 hover:opacity-80 transition-opacity"
          style={{ borderColor: 'var(--term-border)' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs px-1 border" style={{
              borderColor: 'var(--term-accent)',
              color: 'var(--term-accent)',
            }}>
              {result.peer}
            </span>
            <span className="text-sm font-bold" style={{ color: 'var(--term-foreground)' }}>
              {result.title}
            </span>
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--term-muted)' }}>
            {result.path}
          </div>
          {result.snippet && (
            <div className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--term-muted)', opacity: 0.7 }}>
              {result.snippet}
            </div>
          )}
          {result.tags.length > 0 && (
            <div className="flex gap-1 mt-1">
              {result.tags.slice(0, 5).map(tag => (
                <span key={tag} className="text-xs px-1" style={{ color: 'var(--term-primary)', opacity: 0.6 }}>
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

function PeerBrowserView({
  peer,
  files,
  loading,
  onSelect,
}: {
  peer: PeerLiveStatus;
  files: PeerFileListItem[];
  loading: boolean;
  onSelect: (path: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" style={{ color: 'var(--term-muted)' }}>
        Loading files from {peer.displayName || peer.name}...
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="border p-4 text-sm" style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}>
        No shared documents available from {peer.displayName || peer.name}.
      </div>
    );
  }

  // Group by folder
  const grouped = new Map<string, PeerFileListItem[]>();
  for (const file of files) {
    const folder = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '(root)';
    const list = grouped.get(folder) || [];
    list.push(file);
    grouped.set(folder, list);
  }

  return (
    <div className="space-y-4">
      <div className="text-sm" style={{ color: 'var(--term-muted)' }}>
        {files.length} shared document(s) from {peer.displayName || peer.name}
      </div>
      {Array.from(grouped.entries()).map(([folder, items]) => (
        <div key={folder} className="space-y-1">
          <div className="text-xs font-bold" style={{ color: 'var(--term-primary)' }}>
            {folder}/
          </div>
          {items.map(file => (
            <button
              key={file.path}
              onClick={() => onSelect(file.path)}
              className="w-full text-left border p-2 hover:opacity-80 transition-opacity"
              style={{ borderColor: 'var(--term-border)' }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--term-foreground)' }}>
                  {file.title}
                </span>
                <span className="text-xs" style={{ color: 'var(--term-muted)' }}>
                  {file.type}
                </span>
              </div>
              {file.excerpt && (
                <div className="text-xs mt-1 line-clamp-1" style={{ color: 'var(--term-muted)', opacity: 0.6 }}>
                  {file.excerpt}
                </div>
              )}
              {file.tags.length > 0 && (
                <div className="flex gap-1 mt-1">
                  {file.tags.slice(0, 4).map(tag => (
                    <span key={tag} className="text-xs px-1" style={{ color: 'var(--term-primary)', opacity: 0.6 }}>
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
