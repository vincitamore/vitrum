import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, type ServerStatus } from './lib/api';
import { liveReload } from './lib/websocket';
import { useTheme } from './lib/theme';
import Dashboard from './components/Dashboard';
import DocumentList from './components/DocumentList';
import DocumentView from './components/DocumentView';
import Graph from './components/Graph';
import CodeView from './components/CodeView';
import ThemePicker from './components/ThemePicker';
import TitleBar from './components/TitleBar';
import PeersView from './components/PeersView';
import PeerDocumentView from './components/PeerDocumentView';

// Check if running in Tauri
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

type View = 'dashboard' | 'tasks' | 'knowledge' | 'inbox' | 'reminders' | 'graph' | 'code' | 'peers';
type ViewWithDocument = View | 'document' | 'peer-document';

function App() {
  const [view, setView] = useState<ViewWithDocument>('dashboard');
  const [previousView, setPreviousView] = useState<View>('dashboard');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [serverStarting, setServerStarting] = useState(isTauri);
  const [error, setError] = useState<string | null>(null);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [peerDocTarget, setPeerDocTarget] = useState<{ host: string; path: string } | null>(null);
  const { themeName } = useTheme();
  const retryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getStatus();
      setStatus(data);
      setError(null);
      setServerStarting(false);
      // Clear retry interval if server is now available
      if (retryIntervalRef.current) {
        clearInterval(retryIntervalRef.current);
        retryIntervalRef.current = null;
      }
    } catch (err) {
      // If server is starting (in Tauri), keep retrying silently
      if (serverStarting) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }, [serverStarting]);

  // Poll for server availability when running in Tauri
  useEffect(() => {
    if (isTauri && serverStarting) {
      // Poll every 500ms until server is ready
      retryIntervalRef.current = setInterval(() => {
        fetchStatus();
      }, 500);

      return () => {
        if (retryIntervalRef.current) {
          clearInterval(retryIntervalRef.current);
        }
      };
    }
  }, [serverStarting, fetchStatus]);

  useEffect(() => {
    fetchStatus();
    liveReload.connect();

    const unsubReload = liveReload.onReload(() => {
      fetchStatus();
    });

    return () => {
      unsubReload();
      liveReload.disconnect();
    };
  }, [fetchStatus]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip all global shortcuts when typing in form fields or CodeMirror editor
      const isTyping = document.activeElement?.tagName === 'INPUT' ||
                       document.activeElement?.tagName === 'TEXTAREA' ||
                       !!document.activeElement?.closest('.cm-editor');

      // Theme picker toggle — only when not typing
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !isTyping) {
        e.preventDefault();
        setShowThemePicker(p => !p);
        return;
      }

      if (showThemePicker) {
        if (e.key === 'Escape') {
          setShowThemePicker(false);
        }
        return;
      }

      // Only handle escape/q when not typing
      if ((e.key === 'Escape' || e.key === 'q') && !isTyping) {
        e.preventDefault();
        if (peerDocTarget) {
          setPeerDocTarget(null);
          setView(previousView);
        } else if (selectedPath) {
          setSelectedPath(null);
          setView(previousView);
        } else if (view !== 'dashboard') {
          setView('dashboard');
        }
      }

      if (!selectedPath && !peerDocTarget && !isTyping) {
        if (e.key === '1') { e.preventDefault(); setView('dashboard'); }
        if (e.key === '2') { e.preventDefault(); setView('tasks'); }
        if (e.key === '3') { e.preventDefault(); setView('knowledge'); }
        if (e.key === '4') { e.preventDefault(); setView('inbox'); }
        if (e.key === '5') { e.preventDefault(); setView('reminders'); }
        if (e.key === '6') { e.preventDefault(); setView('graph'); }
        if (e.key === '7') { e.preventDefault(); setView('code'); }
        if (e.key === '8') { e.preventDefault(); setView('peers'); }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [view, selectedPath, peerDocTarget, previousView, showThemePicker]);

  const handleSelectDocument = (path: string) => {
    if (view !== 'document' && view !== 'peer-document') {
      setPreviousView(view);
    }
    setSelectedPath(path);
    setView('document');
  };

  const handleSelectPeerDocument = (peerHost: string, path: string) => {
    if (view !== 'peer-document' && view !== 'document') {
      setPreviousView(view);
    }
    setPeerDocTarget({ host: peerHost, path });
    setView('peer-document');
  };

  if (loading || serverStarting) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2">
        <div className="animate-pulse" style={{ color: 'var(--term-muted)' }}>
          {serverStarting ? 'Starting server...' : 'Connecting to org server...'}
        </div>
        {serverStarting && (
          <div className="text-sm" style={{ color: 'var(--term-muted)', opacity: 0.5 }}>
            Indexing documents...
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <div style={{ color: 'var(--term-error)' }}>Error: {error}</div>
        <button
          onClick={fetchStatus}
          className="px-4 py-2 border"
          style={{ borderColor: 'var(--term-border)', color: 'var(--term-foreground)' }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Custom title bar (Tauri only — replaces native window chrome) */}
      {isTauri && <TitleBar />}

      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--term-border)' }}
      >
        <div className="flex items-center gap-4">
          <span style={{ color: 'var(--term-primary)' }} className="font-bold">
            ORG
          </span>
          {/* Desktop nav buttons */}
          <nav className="hidden sm:flex items-center gap-1">
            {[
              { key: '1', label: 'Home', view: 'dashboard' as View },
              { key: '2', label: 'Tasks', view: 'tasks' as View },
              { key: '3', label: 'KB', view: 'knowledge' as View },
              { key: '4', label: 'Inbox', view: 'inbox' as View },
              { key: '5', label: 'Reminders', view: 'reminders' as View },
              { key: '6', label: 'Graph', view: 'graph' as View },
              { key: '7', label: 'Code', view: 'code' as View },
              { key: '8', label: 'Peers', view: 'peers' as View },
            ].map((item) => (
              <button
                key={item.key}
                onClick={() => { setSelectedPath(null); setPeerDocTarget(null); setView(item.view); }}
                className="px-3 py-1 text-sm border"
                style={{
                  borderColor: (view === item.view || (view === 'document' && previousView === item.view))
                    ? 'var(--term-primary)'
                    : 'var(--term-border)',
                  color: (view === item.view || (view === 'document' && previousView === item.view))
                    ? 'var(--term-primary)'
                    : 'var(--term-muted)',
                  backgroundColor: (view === item.view || (view === 'document' && previousView === item.view))
                    ? 'var(--term-selection)'
                    : 'transparent',
                }}
              >
                <span className="opacity-50 mr-1">{item.key}</span>
                {item.label}
              </button>
            ))}
          </nav>
          {status && (
            <span className="text-sm hidden lg:block" style={{ color: 'var(--term-muted)' }}>
              {status.documents.byType.task || 0} tasks • {status.documents.byType.knowledge || 0} KB
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowThemePicker(p => !p)}
            className="text-sm px-2 py-1 border"
            style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}
          >
            {themeName}
          </button>
          <span className="text-sm hidden lg:block" style={{ color: 'var(--term-muted)' }}>
            [q] back • [t] theme
          </span>
        </div>
      </header>

      {/* Theme picker overlay */}
      <AnimatePresence>
        {showThemePicker && (
          <ThemePicker onClose={() => setShowThemePicker(false)} />
        )}
      </AnimatePresence>

      {/* Content */}
      <main className="flex-1 min-h-0 flex flex-col">
        <AnimatePresence mode="wait">
          {peerDocTarget ? (
            <motion.div
              key="peer-document"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.15 }}
              className="flex-1 min-h-0"
            >
              <PeerDocumentView
                peerHost={peerDocTarget.host}
                path={peerDocTarget.path}
                onBack={() => { setPeerDocTarget(null); setView(previousView); }}
              />
            </motion.div>
          ) : selectedPath ? (
            <motion.div
              key="document"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.15 }}
              className="flex-1 min-h-0"
            >
              <DocumentView
                path={selectedPath}
                onBack={() => { setSelectedPath(null); setView(previousView); }}
                onNavigate={handleSelectDocument}
              />
            </motion.div>
          ) : view === 'graph' ? (
            <motion.div
              key="graph"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex-1 min-h-0"
            >
              <Graph onSelectDocument={handleSelectDocument} />
            </motion.div>
          ) : view === 'code' ? (
            <motion.div
              key="code"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex-1 min-h-0"
            >
              <CodeView />
            </motion.div>
          ) : (
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex-1 overflow-auto p-4"
            >
              {view === 'dashboard' && status && (
                <Dashboard status={status} onSelectDocument={handleSelectDocument} onRefresh={fetchStatus} />
              )}
              {view === 'tasks' && (
                <DocumentList type="task" title="Tasks" onSelect={handleSelectDocument} />
              )}
              {view === 'knowledge' && (
                <DocumentList type="knowledge" title="Knowledge Base" onSelect={handleSelectDocument} />
              )}
              {view === 'inbox' && (
                <DocumentList type="inbox" title="Inbox" onSelect={handleSelectDocument} />
              )}
              {view === 'reminders' && (
                <DocumentList type="reminder" title="Reminders" onSelect={handleSelectDocument} />
              )}
              {view === 'peers' && (
                <PeersView onSelectPeerDocument={handleSelectPeerDocument} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer nav */}
      <nav
        className="flex items-center justify-around px-2 py-2 border-t shrink-0 sm:hidden"
        style={{ borderColor: 'var(--term-border)' }}
      >
        {[
          { key: '1', label: 'Home', view: 'dashboard' as View },
          { key: '2', label: 'Tasks', view: 'tasks' as View },
          { key: '3', label: 'KB', view: 'knowledge' as View },
          { key: '4', label: 'Inbox', view: 'inbox' as View },
          { key: '5', label: 'Rem', view: 'reminders' as View },
          { key: '6', label: 'Graph', view: 'graph' as View },
          { key: '7', label: '</>', view: 'code' as View },
          { key: '8', label: 'Peers', view: 'peers' as View },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => { setSelectedPath(null); setPeerDocTarget(null); setView(item.view); }}
            className="px-3 py-1 text-sm"
            style={{
              color: (view === item.view || (view === 'document' && previousView === item.view))
                ? 'var(--term-primary)'
                : 'var(--term-muted)',
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default App;
