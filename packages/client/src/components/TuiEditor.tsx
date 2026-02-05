import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';

export interface EditorField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'tags' | 'checkbox';
  placeholder?: string;
  required?: boolean;
}

export interface EditorData {
  [key: string]: string;
}

interface TuiEditorProps {
  title: string;
  fields: EditorField[];
  onSave: (data: EditorData) => void;
  onCancel: () => void;
  initialData?: EditorData;
}

/**
 * TUI-style editor component (nano-like interface)
 * Mobile-optimized with touch controls
 */
const TuiEditor: React.FC<TuiEditorProps> = ({
  title,
  fields,
  onSave,
  onCancel,
  initialData = {},
}) => {
  const [data, setData] = useState<EditorData>(() => {
    const initial: EditorData = {};
    fields.forEach(f => {
      initial[f.name] = initialData[f.name] || '';
    });
    return initial;
  });
  const [activeField, setActiveField] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const textareaRefs = useRef<(HTMLTextAreaElement | HTMLInputElement | null)[]>([]);

  // Focus active field
  useEffect(() => {
    textareaRefs.current[activeField]?.focus();
  }, [activeField]);

  const handleChange = useCallback((name: string, value: string) => {
    setData(prev => ({ ...prev, [name]: value }));
    setHasChanges(true);
  }, []);

  const handleSave = useCallback(() => {
    // Validate required fields
    const missingRequired = fields.filter(f => f.required && !data[f.name]?.trim());
    if (missingRequired.length > 0) {
      alert(`Please fill in: ${missingRequired.map(f => f.label).join(', ')}`);
      return;
    }
    onSave(data);
  }, [data, fields, onSave]);

  const handleExit = useCallback(() => {
    if (hasChanges) {
      setShowExitConfirm(true);
    } else {
      onCancel();
    }
  }, [hasChanges, onCancel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Ctrl+S to save
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    // Ctrl+X or Escape to cancel/exit
    if ((e.ctrlKey && e.key === 'x') || e.key === 'Escape') {
      e.preventDefault();
      handleExit();
    }
    // Ctrl+Down or Tab to next field
    if ((e.ctrlKey && e.key === 'ArrowDown') || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      setActiveField(prev => Math.min(fields.length - 1, prev + 1));
    }
    // Ctrl+Up or Shift+Tab to prev field
    if ((e.ctrlKey && e.key === 'ArrowUp') || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      setActiveField(prev => Math.max(0, prev - 1));
    }
  }, [fields.length, handleExit, handleSave]);

  // Stop propagation for regular typing in inputs to prevent global shortcuts from capturing
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Let control keys propagate up for handling
    if (e.ctrlKey || e.metaKey || e.key === 'Escape' || e.key === 'Tab') {
      return;
    }
    // Stop all other keys from propagating (prevents global shortcuts like 't', 'q', '1-5')
    e.stopPropagation();
  }, []);

  return (
    <div
      className="h-full flex flex-col"
      style={{ backgroundColor: 'var(--term-background)', color: 'var(--term-foreground)' }}
      onKeyDown={handleKeyDown}
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-3 sm:px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--term-border)', backgroundColor: 'var(--term-selection)' }}
      >
        <span className="text-sm sm:text-base truncate" style={{ color: 'var(--term-primary)' }}>
          {title}
        </span>
        <span className="text-xs sm:text-sm" style={{ color: 'var(--term-muted)' }}>
          {hasChanges ? '[Modified]' : '[Saved]'}
        </span>
      </div>

      {/* Exit confirmation modal */}
      {showExitConfirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: 'rgba(0,0,0,0.8)' }}
        >
          <div
            className="p-4 sm:p-6 max-w-sm w-full mx-4"
            style={{
              backgroundColor: 'var(--term-background)',
              border: '1px solid var(--term-border)',
            }}
          >
            <p className="mb-4" style={{ color: 'var(--term-foreground)' }}>
              Discard unsaved changes?
            </p>
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                className="flex-1 px-4 py-3 text-sm font-medium min-h-[44px] touch-manipulation"
                style={{
                  backgroundColor: 'var(--term-error)',
                  color: 'var(--term-background)',
                }}
              >
                Yes, Discard
              </button>
              <button
                onClick={() => setShowExitConfirm(false)}
                className="flex-1 px-4 py-3 text-sm font-medium min-h-[44px] touch-manipulation"
                style={{
                  backgroundColor: 'var(--term-selection)',
                  color: 'var(--term-foreground)',
                  border: '1px solid var(--term-border)',
                }}
              >
                Keep Editing
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Editor content */}
      <div className="flex-1 overflow-hidden p-3 sm:p-4 flex flex-col gap-3 min-h-0">
        {fields.map((field, index) => (
          <motion.div
            key={field.name}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className={`space-y-1 ${field.type === 'textarea' ? 'flex-1 flex flex-col min-h-0' : 'shrink-0'}`}
          >
            <label
              className="block text-sm font-medium shrink-0"
              style={{ color: index === activeField ? 'var(--term-primary)' : 'var(--term-muted)' }}
            >
              {field.label}
              {field.required && <span style={{ color: 'var(--term-error)' }}> *</span>}
            </label>
            {field.type === 'textarea' && (
              <textarea
                ref={el => textareaRefs.current[index] = el}
                value={data[field.name]}
                onChange={e => handleChange(field.name, e.target.value)}
                onFocus={() => setActiveField(index)}
                onKeyDown={handleInputKeyDown}
                placeholder={field.placeholder}
                className="w-full flex-1 p-3 font-mono text-sm resize-none outline-none touch-manipulation min-h-0"
                style={{
                  backgroundColor: 'var(--term-background)',
                  color: 'var(--term-foreground)',
                  border: `1px solid ${index === activeField ? 'var(--term-primary)' : 'var(--term-border)'}`,
                  fontSize: '16px', // Prevents iOS zoom on focus
                }}
                spellCheck={false}
              />
            )}
            {(field.type === 'text' || field.type === 'tags') && (
              <input
                ref={el => textareaRefs.current[index] = el}
                type="text"
                value={data[field.name]}
                onChange={e => handleChange(field.name, e.target.value)}
                onFocus={() => setActiveField(index)}
                onKeyDown={handleInputKeyDown}
                placeholder={field.placeholder}
                className="w-full p-3 font-mono text-sm outline-none touch-manipulation"
                style={{
                  backgroundColor: 'var(--term-background)',
                  color: 'var(--term-foreground)',
                  border: `1px solid ${index === activeField ? 'var(--term-primary)' : 'var(--term-border)'}`,
                  fontSize: '16px', // Prevents iOS zoom on focus
                }}
                spellCheck={false}
              />
            )}
            {field.type === 'tags' && (
              <p className="text-xs shrink-0" style={{ color: 'var(--term-muted)' }}>
                Separate tags with commas
              </p>
            )}
            {field.type === 'checkbox' && (
              <label
                className="flex items-center gap-3 cursor-pointer touch-manipulation py-2"
                onClick={() => handleChange(field.name, data[field.name] === 'true' ? 'false' : 'true')}
              >
                <span
                  className="w-5 h-5 flex items-center justify-center font-mono text-sm border"
                  style={{
                    borderColor: index === activeField ? 'var(--term-primary)' : 'var(--term-border)',
                    backgroundColor: data[field.name] === 'true' ? 'var(--term-primary)' : 'transparent',
                    color: data[field.name] === 'true' ? 'var(--term-background)' : 'var(--term-muted)',
                  }}
                >
                  {data[field.name] === 'true' ? '✓' : ' '}
                </span>
                <span style={{ color: 'var(--term-foreground)' }}>
                  {field.placeholder || 'Enabled'}
                </span>
              </label>
            )}
          </motion.div>
        ))}
      </div>

      {/* Touch-friendly action bar */}
      <div
        className="border-t p-2 shrink-0"
        style={{ borderColor: 'var(--term-border)', backgroundColor: 'var(--term-selection)' }}
      >
        {/* Touch buttons */}
        <div className="flex gap-2 mb-2">
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-3 text-sm font-medium min-h-[44px] touch-manipulation flex items-center justify-center gap-2"
            style={{
              backgroundColor: 'var(--term-primary)',
              color: 'var(--term-background)',
            }}
          >
            <span>[^S]</span>
            <span>Save</span>
          </button>
          <button
            onClick={handleExit}
            className="flex-1 px-4 py-3 text-sm font-medium min-h-[44px] touch-manipulation flex items-center justify-center gap-2"
            style={{
              backgroundColor: 'var(--term-selection)',
              color: 'var(--term-foreground)',
              border: '1px solid var(--term-border)',
            }}
          >
            <span>[^X]</span>
            <span>Exit</span>
          </button>
        </div>

        {/* Field navigation for mobile */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveField(prev => Math.max(0, prev - 1))}
            disabled={activeField === 0}
            className="flex-1 px-3 py-2 text-sm font-medium min-h-[44px] touch-manipulation disabled:opacity-50"
            style={{
              backgroundColor: 'var(--term-background)',
              color: 'var(--term-muted)',
              border: '1px solid var(--term-border)',
            }}
          >
            [↑] Prev Field
          </button>
          <button
            onClick={() => setActiveField(prev => Math.min(fields.length - 1, prev + 1))}
            disabled={activeField === fields.length - 1}
            className="flex-1 px-3 py-2 text-sm font-medium min-h-[44px] touch-manipulation disabled:opacity-50"
            style={{
              backgroundColor: 'var(--term-background)',
              color: 'var(--term-muted)',
              border: '1px solid var(--term-border)',
            }}
          >
            [↓] Next Field
          </button>
        </div>
      </div>
    </div>
  );
};

export default TuiEditor;
