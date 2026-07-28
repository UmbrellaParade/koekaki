import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// 画面に出す版数。古いキャッシュを見ていないか、目視で確認できるようにする。
const buildId = new Date()
  .toISOString()
  .slice(0, 16)
  .replace('T', ' ')

export default defineConfig(({ mode }) => {
  const desktop = mode === 'desktop'
  // GitHub Pages では /koekaki/、Electron では専用プロトコル配下の相対URLを使う。
  const base = desktop ? './' : (process.env.BASE_PATH ?? '/koekaki/')

  return {
    base,
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __DESKTOP__: JSON.stringify(desktop),
    },
    plugins: [
      react(),
      ...(!desktop
        ? [
            VitePWA({
              registerType: 'autoUpdate',
              includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
              manifest: {
                name: 'こえかき — AI音声入力',
                short_name: 'こえかき',
                description: '話すだけで、整った文章に。詰まっても言い直しても、AIがきれいな文章に整えます。',
                lang: 'ja',
                start_url: base,
                scope: base,
                display: 'standalone',
                orientation: 'portrait',
                background_color: '#0f1115',
                theme_color: '#0f1115',
                categories: ['productivity', 'utilities'],
                icons: [
                  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                  { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
              },
              workbox: {
                globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
                // API 呼び出しは絶対にキャッシュしない（音声・本文が残ると事故になる）
                navigateFallbackDenylist: [/^\/api/],
                runtimeCaching: [],
              },
            }),
          ]
        : []),
    ],
    build: {
      target: 'es2022',
      sourcemap: false,
      outDir: desktop ? 'dist-desktop' : 'dist',
    },
  }
})
