import { useState, useEffect, useCallback } from 'react';

/**
 * Custom title bar for the Tauri native app.
 * Replaces the native Windows title bar with a themed one.
 * Only rendered when running in Tauri (not in browser/PWA).
 */
export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  // Check maximized state on mount and window resize
  useEffect(() => {
    let cancelled = false;

    const checkMaximized = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const maximized = await getCurrentWindow().isMaximized();
        if (!cancelled) setIsMaximized(maximized);
      } catch {
        // Not in Tauri
      }
    };

    checkMaximized();

    // Listen for resize to update maximize state
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().onResized(() => {
          checkMaximized();
        });
      } catch {
        // Not in Tauri
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleMinimize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch { /* not in Tauri */ }
  }, []);

  const handleMaximize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
    } catch { /* not in Tauri */ }
  }, []);

  const handleClose = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch { /* not in Tauri */ }
  }, []);

  const btnBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 46,
    height: 32,
    border: 'none',
    background: 'transparent',
    color: 'var(--term-muted)',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'inherit',
    transition: 'background-color 0.1s, color 0.1s',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties;

  return (
    <div
      data-tauri-drag-region
      className="shrink-0 flex items-center justify-between select-none"
      style={{
        height: 32,
        backgroundColor: 'var(--term-background)',
        borderBottom: '1px solid var(--term-border)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
      onDoubleClick={handleMaximize}
    >
      {/* Left: App title */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 pl-3"
        style={{ pointerEvents: 'none' }}
      >
        <span
          style={{
            color: 'var(--term-primary)',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.05em',
          }}
        >
          ORG
        </span>
        <span
          style={{
            color: 'var(--term-muted)',
            fontSize: '11px',
            opacity: 0.6,
          }}
        >
          Viewer
        </span>
      </div>

      {/* Right: Window controls */}
      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Minimize */}
        <button
          onClick={handleMinimize}
          onMouseEnter={() => setHoveredBtn('min')}
          onMouseLeave={() => setHoveredBtn(null)}
          style={{
            ...btnBase,
            backgroundColor: hoveredBtn === 'min' ? 'var(--term-selection)' : 'transparent',
          }}
          aria-label="Minimize"
        >
          ─
        </button>

        {/* Maximize/Restore */}
        <button
          onClick={handleMaximize}
          onMouseEnter={() => setHoveredBtn('max')}
          onMouseLeave={() => setHoveredBtn(null)}
          style={{
            ...btnBase,
            backgroundColor: hoveredBtn === 'max' ? 'var(--term-selection)' : 'transparent',
          }}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? '❐' : '□'}
        </button>

        {/* Close */}
        <button
          onClick={handleClose}
          onMouseEnter={() => setHoveredBtn('close')}
          onMouseLeave={() => setHoveredBtn(null)}
          style={{
            ...btnBase,
            backgroundColor: hoveredBtn === 'close' ? 'var(--term-error)' : 'transparent',
            color: hoveredBtn === 'close' ? '#fff' : 'var(--term-muted)',
          }}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
