import { useMemo, useState } from 'react'
import { historyToMarkdown } from '../lib/db'
import type { HistoryItem } from '../lib/types'
import { CopyIcon, TrashIcon } from './Icons'
import { Sheet } from './Sheet'

interface HistorySheetProps {
  items: HistoryItem[]
  onClose: () => void
  onCopy: (text: string) => void
  onReuse: (item: HistoryItem) => void
  onDelete: (id: string) => void
  onNotify: (kind: 'ok' | 'err', message: string, hint?: string) => void
}

export function HistorySheet({ items, onClose, onCopy, onReuse, onDelete, onNotify }: HistorySheetProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.polished.toLowerCase().includes(q) || i.raw.toLowerCase().includes(q))
  }, [items, query])

  const exportAll = async () => {
    if (items.length === 0) return
    try {
      await navigator.clipboard.writeText(historyToMarkdown(items))
      onNotify('ok', '履歴を Markdown でコピーしました')
    } catch {
      onNotify('err', 'コピーできませんでした')
    }
  }

  return (
    <Sheet
      title="履歴"
      onClose={onClose}
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>{items.length} 件</span>
          <button className="btn sm" onClick={exportAll} disabled={items.length === 0}>
            まとめてコピー
          </button>
        </>
      }
    >
      <div className="field">
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="履歴を検索"
          type="search"
        />
      </div>

      {filtered.length === 0 && (
        <div className="empty">{items.length === 0 ? 'まだ履歴がありません。' : '見つかりませんでした。'}</div>
      )}

      {filtered.map((item) => (
        <article className="history-item" key={item.id}>
          <div className="history-meta">
            <span className="tag">{item.modeName}</span>
            <span>{new Date(item.createdAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}</span>
            <span>{Math.round(item.durationMs / 1000)}秒</span>
          </div>
          <div
            className={`history-text${expanded[item.id] ? ' expanded' : ''}`}
            onClick={() => setExpanded((e) => ({ ...e, [item.id]: !e[item.id] }))}
          >
            {item.polished || '（空）'}
          </div>
          <div className="history-actions">
            <button className="btn sm" onClick={() => onCopy(item.polished)}>
              <CopyIcon />
              コピー
            </button>
            <button className="btn ghost sm" onClick={() => onReuse(item)}>
              編集画面に呼び出す
            </button>
            <button className="btn danger sm" onClick={() => onDelete(item.id)} aria-label="削除">
              <TrashIcon />
            </button>
          </div>
        </article>
      ))}
    </Sheet>
  )
}
