/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        henry: {
          bg: '#0a0a0f',
          surface: '#12121a',
          border: '#1e1e2e',
          hover: '#252538',
          accent: '#6366f1',
          'accent-hover': '#818cf8',
          'accent-dim': '#4f46e5',
          text: '#e2e8f0',
          'text-dim': '#94a3b8',
          'text-muted': '#64748b',
          success: '#22c55e',
          warning: '#f59e0b',
          error: '#ef4444',
          companion: '#6366f1',
          worker: '#f59e0b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'henry-panel-in': 'henry-panel-in 0.18s cubic-bezier(0.22,1,0.36,1) both',
        'henry-msg-in': 'henry-msg-in 0.2s cubic-bezier(0.22,1,0.36,1) both',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'henry-panel-in': {
          'from': { opacity: '0', transform: 'translateX(6px)' },
          'to':   { opacity: '1', transform: 'translateX(0)' },
        },
        'henry-msg-in': {
          'from': { opacity: '0', transform: 'translateY(8px) scale(0.99)' },
          'to':   { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'henry': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
