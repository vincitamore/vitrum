import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface TerminalTheme {
  name: string;
  label: string;
  colors: {
    background: string;
    foreground: string;
    primary: string;
    secondary: string;
    accent: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    border: string;
    borderActive: string;
    muted: string;
    selection: string;
  };
}

// Subset of themes from amore.build
export const themes: Record<string, TerminalTheme> = {
  horizon: {
    name: 'horizon',
    label: 'Horizon',
    colors: {
      background: '#1c1e26',
      foreground: '#d5d8da',
      primary: '#e95678',
      secondary: '#fab795',
      accent: '#29d398',
      success: '#29d398',
      warning: '#fab795',
      error: '#e95678',
      info: '#26bbd9',
      border: '#2e303e',
      borderActive: '#e95678',
      muted: '#6c6f93',
      selection: '#2e303e',
    },
  },
  dracula: {
    name: 'dracula',
    label: 'Dracula',
    colors: {
      background: '#282a36',
      foreground: '#f8f8f2',
      primary: '#bd93f9',
      secondary: '#ff79c6',
      accent: '#50fa7b',
      success: '#50fa7b',
      warning: '#f1fa8c',
      error: '#ff5555',
      info: '#8be9fd',
      border: '#44475a',
      borderActive: '#bd93f9',
      muted: '#6272a4',
      selection: '#44475a',
    },
  },
  nord: {
    name: 'nord',
    label: 'Nord',
    colors: {
      background: '#2e3440',
      foreground: '#eceff4',
      primary: '#88c0d0',
      secondary: '#81a1c1',
      accent: '#a3be8c',
      success: '#a3be8c',
      warning: '#ebcb8b',
      error: '#bf616a',
      info: '#5e81ac',
      border: '#3b4252',
      borderActive: '#88c0d0',
      muted: '#4c566a',
      selection: '#434c5e',
    },
  },
  tokyonight: {
    name: 'tokyonight',
    label: 'Tokyo Night',
    colors: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      primary: '#7aa2f7',
      secondary: '#bb9af7',
      accent: '#9ece6a',
      success: '#9ece6a',
      warning: '#e0af68',
      error: '#f7768e',
      info: '#7dcfff',
      border: '#292e42',
      borderActive: '#7aa2f7',
      muted: '#565f89',
      selection: '#33467c',
    },
  },
  catppuccin: {
    name: 'catppuccin',
    label: 'Catppuccin',
    colors: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      primary: '#cba6f7',
      secondary: '#f5c2e7',
      accent: '#a6e3a1',
      success: '#a6e3a1',
      warning: '#f9e2af',
      error: '#f38ba8',
      info: '#89dceb',
      border: '#313244',
      borderActive: '#cba6f7',
      muted: '#6c7086',
      selection: '#45475a',
    },
  },
  gruvbox: {
    name: 'gruvbox',
    label: 'Gruvbox',
    colors: {
      background: '#282828',
      foreground: '#ebdbb2',
      primary: '#fabd2f',
      secondary: '#83a598',
      accent: '#b8bb26',
      success: '#b8bb26',
      warning: '#fabd2f',
      error: '#fb4934',
      info: '#83a598',
      border: '#3c3836',
      borderActive: '#fabd2f',
      muted: '#665c54',
      selection: '#504945',
    },
  },
};

const THEME_STORAGE_KEY = 'vitrum-theme';
const DEFAULT_THEME = 'horizon';

interface ThemeContextValue {
  theme: TerminalTheme;
  themeName: string;
  setTheme: (name: string) => void;
  availableThemes: string[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName, setThemeName] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_THEME;
    return localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
  });

  const theme = themes[themeName] || themes[DEFAULT_THEME];

  const applyTheme = useCallback((t: TerminalTheme) => {
    const root = document.documentElement;
    Object.entries(t.colors).forEach(([key, value]) => {
      root.style.setProperty(`--term-${key}`, value);
    });
  }, []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY, themeName);
  }, [theme, themeName, applyTheme]);

  const setTheme = useCallback((name: string) => {
    if (themes[name]) {
      setThemeName(name);
    }
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        themeName,
        setTheme,
        availableThemes: Object.keys(themes),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
