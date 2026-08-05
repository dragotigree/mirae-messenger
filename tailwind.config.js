/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './assets/compact/**/*.{html,js,css}'],
  // 기존 앱 CSS와 충돌 방지 — 미니모드 유틸만 mm- 접두사
  prefix: 'mm-',
  corePlugins: {
    preflight: false
  },
  theme: {
    extend: {
      spacing: {
        // 8px 그리드 (카카오톡류)
        '0.5': '4px',
        '1': '8px',
        '1.5': '12px',
        '2': '16px',
        '2.5': '20px',
        '3': '24px',
        '4': '32px'
      },
      fontSize: {
        'mm': ['12.5px', { lineHeight: '1.45' }],
        'mm-sm': ['11.5px', { lineHeight: '1.4' }],
        'mm-xs': ['10.5px', { lineHeight: '1.35' }],
        'mm-lg': ['13px', { lineHeight: '1.45' }]
      },
      borderRadius: {
        'bubble': '14px',
        'overlay': '12px',
        'overlay-lg': '16px'
      },
      colors: {
        overlay: {
          bg: 'rgba(30, 31, 34, 0.94)',
          surface: 'rgba(43, 45, 49, 0.88)',
          raised: 'rgba(49, 51, 56, 0.92)',
          hover: 'rgba(255, 255, 255, 0.06)',
          active: 'rgba(255, 255, 255, 0.10)',
          border: 'rgba(255, 255, 255, 0.08)',
          text: '#f2f3f5',
          muted: '#b5bac1',
          dim: '#80848e',
          blurple: '#5865f2',
          accent: '#ff6229',
          kakao: '#fee500',
          chat: '#b2c7d9'
        }
      },
      boxShadow: {
        overlay: '0 8px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255,255,255,0.06)',
        bubble: '0 1px 2px rgba(15, 23, 42, 0.08)'
      },
      backdropBlur: {
        overlay: '18px'
      }
    }
  },
  plugins: []
};
