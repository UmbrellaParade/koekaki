import { useEffect, useRef, useState } from 'react'
import { formatCost } from '../lib/cost'
import { BookIcon, CheckIcon, CopyIcon, RefreshIcon, ShareIcon, TrashIcon } from './Icons'

interface ResultPanelProps {
  text: string
  rawText: string
  modeName: string
  engine: string
  costUsd: number
  busy: boolean
  appendMode: boolean
  onChange: (text: string) => void
  onCopy: () => void
  onShare: () => void
  onRepolish: () => void
  onClear: () => void
  onToggleAppend: () => void
  onAddToDictionary: (term: string) => void
}

/** カーソル位置に差し込めると便利な記号。スマホでは記号キーに切り替える手間が省ける。 */
const INSERTS: Array<{ label: string; value: string; title: string }> = [
  { label: '改行', value: '\n', title: 'カーソル位置で改行する' },
  { label: '空行', value: '\n\n', title: '段落を分ける' },
  { label: '、', value: '、', title: '読点を入れる' },
  { label: '。', value: '。', title: '句点を入れる' },
]

export function ResultPanel({
  text,
  rawText,
  modeName,
  engine,
  costUsd,
  busy,
  appendMode,
  onChange,
  onCopy,
  onShare,
  onRepolish,
  onClear,
  onToggleAppend,
  onAddToDictionary,
}: ResultPanelProps) {
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [selection, setSelection] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])

  const handleCopy = () => {
    onCopy()
    setCopied(true)
  }

  /** カーソル位置（選択中なら選択範囲を置き換えて）に文字を差し込む */
  const insertAtCursor = (value: string) => {
    const el = areaRef.current
    if (!el) return
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? start
    const next = text.slice(0, start) + value + text.slice(end)
    onChange(next)
    // React が値を書き戻したあとにカーソルを移す
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + value.length
      el.setSelectionRange(pos, pos)
    })
  }

  /**
   * ボタン表示を更新するためだけの同期。
   * 実際の登録はクリック時に読み直す（選択イベントを取りこぼしても動くように）。
   */
  const syncSelection = () => {
    const el = areaRef.current
    if (!el) return
    const picked = text.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim()
    setSelection(picked.length > 0 && picked.length <= 40 ? picked : '')
  }

  const addSelectionToDictionary = () => {
    const el = areaRef.current
    // blur してもテキストエリアは選択範囲を保持しているので、押された瞬間に読めばよい
    const picked = el ? text.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim() : selection
    onAddToDictionary(picked || selection)
    setSelection('')
  }

  const rawDiffers = rawText.trim() !== '' && rawText.trim() !== text.trim()

  return (
    <section className="result" aria-label="変換結果">
      <div className="result-head">
        <span className="tag">{modeName}</span>
        <span>{engine}</span>
        <span className="grow">{text.length} 文字</span>
        {costUsd > 0 && <span title="このリクエストのおおよそのAPI利用料">概算 {formatCost(costUsd)}</span>}
      </div>

      <div className="result-body">
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onSelect={syncSelection}
          onKeyUp={syncSelection}
          onMouseUp={syncSelection}
          spellCheck={false}
          aria-label="変換されたテキスト（そのまま編集できます）"
          placeholder="ここに整形された文章が出ます"
        />
      </div>

      {/* 直しやすさのための行。スマホで特に効く */}
      <div className="insert-row">
        {INSERTS.map((ins) => (
          <button
            key={ins.label}
            className="btn ghost sm"
            title={ins.title}
            onClick={() => insertAtCursor(ins.value)}
            disabled={!text}
          >
            {ins.label}
          </button>
        ))}
        <button
          className="btn ghost sm"
          onClick={addSelectionToDictionary}
          disabled={!text}
          title="間違えられやすい語を選んでから押すと、次から正しい表記に直されます"
          style={{ marginLeft: 'auto' }}
        >
          <BookIcon />
          {selection ? `「${selection}」を辞書に追加` : '選んだ語を辞書に追加'}
        </button>
      </div>

      <div className="result-actions">
        <button className="btn primary sm" onClick={handleCopy} disabled={!text}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'コピーしました' : 'コピー'}
        </button>
        {canShare && (
          <button className="btn sm" onClick={onShare} disabled={!text}>
            <ShareIcon />
            共有
          </button>
        )}
        <button className="btn sm" onClick={onRepolish} disabled={busy || !rawText}>
          <RefreshIcon className={busy ? 'spin' : undefined} />
          整形し直す
        </button>
        <button
          className={`btn sm${appendMode ? ' primary' : ''}`}
          onClick={onToggleAppend}
          title="オンにすると、次に話した内容がこの文章の続きとして足されます"
        >
          {appendMode ? '追記モード オン' : '続けて話す'}
        </button>
        {rawDiffers && (
          <button className="btn ghost sm" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? '書き起こしを隠す' : '書き起こしを見る'}
          </button>
        )}
        <button className="btn danger sm" onClick={onClear} style={{ marginLeft: 'auto' }} aria-label="消す">
          <TrashIcon />
        </button>
      </div>

      {showRaw && rawDiffers && (
        <div className="raw-box">
          <div className="label">元の書き起こし（整形前）</div>
          <div className="text">{rawText}</div>
        </div>
      )}
    </section>
  )
}
