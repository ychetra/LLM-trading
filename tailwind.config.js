/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './lib/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      colors: {
        surface: { 1: '#080a16', 2: '#0c0f1e', 3: '#111428' },
        indigo:  { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' },
        cyan:    { 400: '#22d3ee', 500: '#06b6d4' },
        emerald: { 400: '#4ade80', 500: '#22c55e' },
        rose:    { 400: '#f87171', 500: '#ef4444' },
        amber:   { 400: '#fbbf24', 500: '#f59e0b' },
        violet:  { 400: '#a78bfa', 500: '#8b5cf6' },
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
