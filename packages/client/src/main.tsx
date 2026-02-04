import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './lib/theme';
import './index.css';

// Log errors to Tauri IPC
async function logError(msg: string) {
  try {
    if ('__TAURI__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('frontend_log', { msg: `[ERROR] ${msg}` });
    }
  } catch {
    // ignore
  }
  console.error(msg);
}

// Error boundary for catching React errors
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logError(`React error: ${error.message}\nStack: ${error.stack}\nComponent: ${info.componentStack}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: '#ff6b6b', fontFamily: 'monospace', backgroundColor: '#1c1e26', minHeight: '100vh' }}>
          <h2>Error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10, opacity: 0.7 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Global error handler for uncaught errors
window.addEventListener('error', (e) => {
  logError(`Uncaught error: ${e.message} at ${e.filename}:${e.lineno}`);
});

window.addEventListener('unhandledrejection', (e) => {
  logError(`Unhandled promise rejection: ${e.reason}`);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Service worker registration failed - PWA features won't work offline
    });
  });
}
