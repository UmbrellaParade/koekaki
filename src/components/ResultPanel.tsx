import { useEffect, useRef, useState } from 'react'
import { formatCost } from '../lib/cost'
import { CheckIcon, CopyIcon, RefreshIcon, ShareIcon, TrashIcon } from './Icons'

interface ResultPanelProps {
  text: string
  rawText: string
  modeName: string
  engine: string
  costUsd: number
  busy: boolean
  onChange: (text: string) => void
  onCopy: () => void
  onShare: () => void
  onRepolish: () => void
  onClear: () => void
}

export function ResultPanel({
  text,
  rawText,
  modeName,
  engine,
  costUsd,
  busy,
  onChange,
  onCopy,
  onShare,
  onRepolish,
  onClear,
}: ResultPanelProps) {
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
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

  const rawDiffers = rawText.trim() !== '' && rawText.trim() !== text.trim()
  const charCount = text.length

  return (
    <section className="result" aria-label="変換結果">
      <div className="result-head">
        <span className="tag">{modeName}</span>
        <span>{engine}</span>
        <span className="grow">{charCount} 文字</span>
        {costUsd > 0 && <span title="このリクエストのおおよそのAPI利用料">概算 {formatCost(costUsd)}</span>}
      </div>

      <div className="result-body">
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          aria-label="変換されたテキスト（編集できます）"
          placeholder="ここに整形された文章が出ます"
        />
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
          このモードで整形し直す
        </button>
        {rawDiffers && (
          <button className="btn ghost sm" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? '元の書き起こしを隠す' : '元の書き起こしを見る'}
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
