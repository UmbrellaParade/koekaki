import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastItem {
  id: number
  kind: 'ok' | 'err' | 'info'
  message: string
  hint?: string
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const push = useCallback((kind: ToastItem['kind'], message: string, hint?: string) => {
    const id = nextId.current++
    setToasts((prev) => [...prev, { id, kind, message, hint }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 2600)
  }, [])

  return { toasts, push }
}

export function ToastArea({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="toast-area" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.message}
          {t.hint && <span className="toast-hint">{t.hint}</span>}
        </div>
      ))}
    </div>
  )
}

/** 画面外クリックや ESC を扱わない、単純な確認ダイアログ */
export function useConfirm() {
  const [pending, setPending] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null)

  const confirm = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => setPending({ message, resolve }))
  }, [])

  useEffect(() => {
    if (!pending) return
    // ネイティブの confirm はモバイルでも確実に動くので、ここは素直に使う
    const ok = window.confirm(pending.message)
    pending.resolve(ok)
    setPending(null)
  }, [pending])

  return confirm
}
