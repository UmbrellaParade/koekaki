import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root が見つかりません')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * ホーム画面に追加した PWA は、アプリを完全に終了しない限り更新を取りに行かない。
 * 「直したはずの不具合が消えない」の原因になるので、
 * 画面に戻ってくるたびに新しい版が無いか確認し、あれば読み込み直す。
 */
if (!__DESKTOP__ && 'serviceWorker' in navigator) {
  const checkForUpdate = () => {
    if (document.visibilityState !== 'visible') return
    void navigator.serviceWorker.getRegistration().then((reg) => reg?.update())
  }

  document.addEventListener('visibilitychange', checkForUpdate)
  window.addEventListener('focus', checkForUpdate)

  // 新しい Service Worker が主導権を握ったら、その場で最新のコードに切り替える
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
}
