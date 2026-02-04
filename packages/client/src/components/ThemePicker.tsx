import { motion } from 'framer-motion';
import { useTheme, themes } from '../lib/theme';

interface ThemePickerProps {
  onClose: () => void;
}

export default function ThemePicker({ onClose }: ThemePickerProps) {
  const { themeName, setTheme } = useTheme();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="border p-4 max-w-md w-full mx-4 max-h-[80vh] overflow-auto"
        style={{ backgroundColor: 'var(--term-background)', borderColor: 'var(--term-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ color: 'var(--term-primary)' }} className="font-bold">
            Theme
          </h2>
          <button
            onClick={onClose}
            className="text-sm px-2 py-1"
            style={{ color: 'var(--term-muted)' }}
          >
            [ESC]
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {Object.values(themes).map((theme) => (
            <button
              key={theme.name}
              onClick={() => {
                setTheme(theme.name);
                onClose();
              }}
              className="text-left px-3 py-2 border transition-colors"
              style={{
                borderColor: themeName === theme.name ? theme.colors.primary : theme.colors.border,
                backgroundColor: theme.colors.background,
              }}
            >
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded-full"
                  style={{ backgroundColor: theme.colors.primary }}
                />
                <span style={{ color: theme.colors.foreground }}>
                  {theme.label}
                </span>
              </div>
              <div className="flex gap-1 mt-2">
                {[theme.colors.primary, theme.colors.secondary, theme.colors.accent, theme.colors.info].map((color, i) => (
                  <div
                    key={i}
                    className="w-3 h-3 rounded-sm"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
