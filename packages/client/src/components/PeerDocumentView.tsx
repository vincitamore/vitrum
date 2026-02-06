import { useState, useEffect } from 'react';
import { federationApi, type PeerDocument } from '../lib/api';

interface PeerDocumentViewProps {
  peerHost: string;
  path: string;
  onBack: () => void;
  onAdopted?: (localPath: string) => void;
}

export default function PeerDocumentView({ peerHost, path, onBack, onAdopted }: PeerDocumentViewProps) {
  const [doc, setDoc] = useState<PeerDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adopted, setAdopted] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setAdopted(false);
    federationApi.getPeerDocument(peerHost, path)
      .then(setDoc)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [peerHost, path]);

  const handleAdopt = async () => {
    if (!doc) return;
    setAdopting(true);

    try {
      // We need the peerId from the doc's metadata — get it from the peer's hello
      const peersData = await federationApi.getPeers();
      const peer = peersData.peers.find(p => `${p.host}:${p.port}` === peerHost);

      if (!peer?.instanceId) {
        throw new Error('Peer not found or missing instanceId');
      }

      const result = await federationApi.adoptDocument({
        peerId: peer.instanceId,
        peerHost,
        sourcePath: path,
      });

      setAdopted(true);
      if (onAdopted) {
        onAdopted(result.localPath);
      }
    } catch (e) {
      setError(`Adoption failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setAdopting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--term-muted)' }}>
        Loading document from peer...
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div style={{ color: 'var(--term-error)' }}>
          {error || 'Document not found'}
        </div>
        <button
          onClick={onBack}
          className="px-4 py-2 border text-sm"
          style={{ borderColor: 'var(--term-border)', color: 'var(--term-foreground)' }}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--term-border)' }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-sm px-2 py-1 border"
            style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}
          >
            [q] back
          </button>
          <span className="text-xs px-2 py-0.5 border" style={{
            borderColor: 'var(--term-accent)',
            color: 'var(--term-accent)',
          }}>
            PEER: {peerHost}
          </span>
          <span className="text-sm font-bold" style={{ color: 'var(--term-foreground)' }}>
            {doc.title}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--term-muted)' }}>
            {doc.type} &bull; {doc.checksum.slice(0, 16)}...
          </span>
          {adopted ? (
            <span className="px-3 py-1 text-sm border font-bold" style={{
              borderColor: 'var(--term-success)',
              color: 'var(--term-success)',
              opacity: 0.7,
            }}>
              Adopted
            </span>
          ) : (
            <button
              onClick={handleAdopt}
              disabled={adopting}
              className="px-3 py-1 text-sm border font-bold"
              style={{
                borderColor: 'var(--term-success)',
                color: adopting ? 'var(--term-muted)' : 'var(--term-success)',
              }}
            >
              {adopting ? 'Adopting...' : 'Adopt'}
            </button>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="px-4 py-2 border-b" style={{ borderColor: 'var(--term-border)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs" style={{ color: 'var(--term-muted)' }}>
            {doc.path}
          </span>
          {doc.tags.map(tag => (
            <span key={tag} className="text-xs px-1 border" style={{
              borderColor: 'var(--term-border)',
              color: 'var(--term-primary)',
            }}>
              #{tag}
            </span>
          ))}
        </div>
      </div>

      {/* Adopted banner */}
      {adopted && (
        <div className="px-4 py-2 border-b" style={{
          borderColor: 'var(--term-success)',
          backgroundColor: 'var(--term-selection)',
        }}>
          <span className="text-sm" style={{ color: 'var(--term-success)' }}>
            Document adopted to your local org. Federation tracking enabled.
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <pre
          className="whitespace-pre-wrap text-sm leading-relaxed"
          style={{ color: 'var(--term-foreground)' }}
        >
          {doc.content}
        </pre>
      </div>
    </div>
  );
}
