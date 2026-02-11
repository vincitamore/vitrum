import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type Project, type TreeEntry, type ProjectFile } from '../lib/api';
import { liveReload } from '../lib/websocket';
import FileTree from './FileTree';
import CodeEditor from './CodeEditor';

const STORAGE_KEYS = {
  lastProject: 'vitrum-code-last-project',
  sidebarWidth: 'vitrum-code-sidebar-width',
  sidebarCollapsed: 'vitrum-code-sidebar-collapsed',
};

export default function CodeView() {
  // Project state
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);

  // File state
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileData, setFileData] = useState<ProjectFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  // Edit state
  const [isEditing, setIsEditing] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === 'true';
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.sidebarWidth);
    return stored ? parseInt(stored, 10) : 260;
  });
  const isResizing = useRef(false);

  // Load projects list
  useEffect(() => {
    api.listProjects().then((data) => {
      setProjects(data);
      // Restore last project
      const last = localStorage.getItem(STORAGE_KEYS.lastProject);
      if (last && data.some((p) => p.name === last)) {
        setSelectedProject(last);
      }
    }).catch(console.error);
  }, []);

  // Load tree when project changes
  useEffect(() => {
    if (!selectedProject) {
      setTree([]);
      return;
    }

    setTreeLoading(true);
    setSelectedFile(null);
    setFileData(null);
    setIsEditing(false);

    localStorage.setItem(STORAGE_KEYS.lastProject, selectedProject);

    api.getProjectTree(selectedProject).then((data) => {
      setTree(data);
    }).catch(console.error).finally(() => {
      setTreeLoading(false);
    });
  }, [selectedProject]);

  // Live reload: refresh tree and file data when files change
  useEffect(() => {
    const unsubReload = liveReload.onReload(() => {
      // Full reload — refresh project list and tree
      api.listProjects().then(setProjects).catch(console.error);
      if (selectedProject) {
        api.getProjectTree(selectedProject).then(setTree).catch(console.error);
      }
    });

    const unsubUpdate = liveReload.onUpdate(() => {
      // A file changed — refresh tree to pick up new/changed files
      if (selectedProject) {
        api.getProjectTree(selectedProject).then(setTree).catch(console.error);
      }
      // If the currently viewed file was modified externally, refresh it
      // (but not if user is actively editing — don't clobber their work)
      if (selectedProject && selectedFile && !isEditing) {
        api.getProjectFile(selectedProject, selectedFile)
          .then(setFileData)
          .catch(console.error);
      }
    });

    const unsubRemove = liveReload.onRemove(() => {
      if (selectedProject) {
        api.getProjectTree(selectedProject).then(setTree).catch(console.error);
      }
    });

    return () => {
      unsubReload();
      unsubUpdate();
      unsubRemove();
    };
  }, [selectedProject, selectedFile, isEditing]);

  // Load file when selected
  const loadFile = useCallback(async (path: string) => {
    if (!selectedProject) return;

    // Warn about unsaved changes
    if (isDirty) {
      const confirm = window.confirm('You have unsaved changes. Discard them?');
      if (!confirm) return;
    }

    setFileLoading(true);
    setIsEditing(false);
    setIsDirty(false);

    try {
      const data = await api.getProjectFile(selectedProject, path);
      setSelectedFile(path);
      setFileData(data);
    } catch (err) {
      console.error('Failed to load file:', err);
    } finally {
      setFileLoading(false);
    }
  }, [selectedProject, isDirty]);

  // Save handler
  const handleSave = useCallback(async (content: string) => {
    if (!selectedProject || !selectedFile) return;

    setSaving(true);
    try {
      await api.updateProjectFile(selectedProject, selectedFile, content);
      // Reload to get fresh data
      const data = await api.getProjectFile(selectedProject, selectedFile);
      setFileData(data);
      setIsDirty(false);
    } catch (err) {
      alert(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }, [selectedProject, selectedFile]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isTyping = document.activeElement?.tagName === 'INPUT' ||
                       document.activeElement?.tagName === 'TEXTAREA' ||
                       document.activeElement?.closest('.cm-editor');

      // Ctrl+B: toggle sidebar
      if (e.key === 'b' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSidebarCollapsed(prev => {
          const next = !prev;
          localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, String(next));
          return next;
        });
        return;
      }

      // Don't handle other shortcuts when in CodeMirror
      if (isTyping) return;

      // e: edit mode
      if (e.key === 'e' && fileData && !isEditing) {
        e.preventDefault();
        setIsEditing(true);
        return;
      }

      // Escape: cancel edit or deselect file
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isEditing) {
          if (isDirty) {
            const confirm = window.confirm('Discard unsaved changes?');
            if (!confirm) return;
          }
          setIsEditing(false);
          setIsDirty(false);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fileData, isEditing, isDirty]);

  // Sidebar resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(Math.max(e.clientX, 160), 500);
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      localStorage.setItem(STORAGE_KEYS.sidebarWidth, String(sidebarWidth));
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth]);

  // Breadcrumb
  const breadcrumb = selectedFile ? selectedFile.split('/') : [];

  // No project selected - show project list
  if (!selectedProject) {
    return (
      <div className="h-full overflow-auto p-4">
        <h2 className="text-lg font-bold mb-4" style={{ color: 'var(--term-primary)' }}>
          Projects
        </h2>
        {projects.length === 0 ? (
          <div style={{ color: 'var(--term-muted)' }}>No projects found in projects/ directory</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.map((project) => (
              <button
                key={project.name}
                onClick={() => setSelectedProject(project.name)}
                className="text-left p-3 border transition-colors hover:bg-white/5"
                style={{
                  borderColor: 'var(--term-border)',
                  color: 'var(--term-foreground)',
                }}
              >
                <div className="font-bold" style={{ color: 'var(--term-secondary)' }}>
                  {project.name}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--term-muted)' }}>
                  {project.hasClaude && <span className="mr-2">CLAUDE.md</span>}
                  {project.hasReadme && <span>README.md</span>}
                  {!project.hasClaude && !project.hasReadme && <span>No docs</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--term-border)' }}
      >
        {/* Project selector */}
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          className="text-sm px-2 py-1 border bg-transparent"
          style={{
            borderColor: 'var(--term-border)',
            color: 'var(--term-secondary)',
            fontFamily: 'inherit',
          }}
        >
          {projects.map((p) => (
            <option key={p.name} value={p.name} style={{ backgroundColor: 'var(--term-background)' }}>
              {p.name}
            </option>
          ))}
        </select>

        {/* Breadcrumb */}
        {breadcrumb.length > 0 && (
          <div className="flex items-center gap-1 text-sm min-w-0 overflow-hidden">
            <span style={{ color: 'var(--term-muted)' }}>/</span>
            {breadcrumb.map((part, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span style={{ color: 'var(--term-muted)' }}>/</span>}
                <span
                  className="truncate"
                  style={{
                    color: i === breadcrumb.length - 1 ? 'var(--term-foreground)' : 'var(--term-muted)',
                  }}
                >
                  {part}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Right side: sidebar toggle, edit toggle, dirty indicator, hints */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {/* Sidebar toggle button — always visible */}
          <button
            onClick={() => {
              setSidebarCollapsed(prev => {
                const next = !prev;
                localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, String(next));
                return next;
              });
            }}
            className="text-xs px-2 py-1 border hover:bg-white/5 transition-colors"
            style={{ borderColor: 'var(--term-border)', color: 'var(--term-muted)' }}
            title="Toggle sidebar (Ctrl+B)"
          >
            {sidebarCollapsed ? '>' : '<'}
          </button>
          {saving && (
            <span className="text-xs" style={{ color: 'var(--term-warning)' }}>Saving...</span>
          )}
          {isDirty && !saving && (
            <span className="text-xs" style={{ color: 'var(--term-warning)' }}>* modified</span>
          )}
          {fileData && !isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="text-xs px-2 py-1 border hover:bg-white/5 transition-colors"
              style={{ borderColor: 'var(--term-border)', color: 'var(--term-info)' }}
              title="Press 'e' to edit"
            >
              [e] Edit
            </button>
          )}
          {isEditing && (
            <button
              onClick={() => {
                if (isDirty) {
                  const confirm = window.confirm('Discard unsaved changes?');
                  if (!confirm) return;
                }
                setIsEditing(false);
                setIsDirty(false);
              }}
              className="text-xs px-2 py-1 border hover:bg-white/5 transition-colors"
              style={{ borderColor: 'var(--term-border)', color: 'var(--term-error)' }}
            >
              Cancel
            </button>
          )}
          {fileData && (
            <span className="text-xs hidden sm:inline" style={{ color: 'var(--term-muted)' }}>
              {fileData.language || 'text'}
              {fileData.size > 0 && ` \u00B7 ${(fileData.size / 1024).toFixed(1)}KB`}
            </span>
          )}
        </div>
      </div>

      {/* Main area: sidebar + editor */}
      <div className="flex-1 min-h-0 flex">
        {/* Sidebar */}
        {!sidebarCollapsed && (
          <>
            <div
              className="shrink-0 border-r overflow-hidden flex flex-col"
              style={{
                width: `${sidebarWidth}px`,
                borderColor: 'var(--term-border)',
              }}
            >
              {treeLoading ? (
                <div className="p-4 text-sm" style={{ color: 'var(--term-muted)' }}>
                  Loading tree...
                </div>
              ) : (
                <FileTree
                  entries={tree}
                  selectedPath={selectedFile}
                  onSelectFile={loadFile}
                />
              )}
            </div>

            {/* Resize handle */}
            <div
              className="w-1 cursor-col-resize hover:bg-white/10 transition-colors shrink-0"
              onMouseDown={handleResizeStart}
              style={{ backgroundColor: 'transparent' }}
            />
          </>
        )}

        {/* Editor area */}
        <div className="flex-1 min-w-0">
          {fileLoading ? (
            <div className="h-full flex items-center justify-center" style={{ color: 'var(--term-muted)' }}>
              Loading file...
            </div>
          ) : fileData ? (
            <CodeEditor
              key={`${selectedFile}-${isEditing}`}
              content={fileData.content}
              language={fileData.language}
              readOnly={!isEditing}
              onSave={handleSave}
              onDirtyChange={setIsDirty}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2">
              <div style={{ color: 'var(--term-muted)' }}>
                Select a file from the tree
              </div>
              <div className="text-xs" style={{ color: 'var(--term-muted)', opacity: 0.5 }}>
                [e] edit &middot; Ctrl+B toggle sidebar &middot; Ctrl+F find
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
