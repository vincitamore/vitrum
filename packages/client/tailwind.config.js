/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        term: {
          background: 'var(--term-background)',
          foreground: 'var(--term-foreground)',
          primary: 'var(--term-primary)',
          secondary: 'var(--term-secondary)',
          accent: 'var(--term-accent)',
          success: 'var(--term-success)',
          warning: 'var(--term-warning)',
          error: 'var(--term-error)',
          info: 'var(--term-info)',
          border: 'var(--term-border)',
          borderActive: 'var(--term-borderActive)',
          muted: 'var(--term-muted)',
          selection: 'var(--term-selection)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
