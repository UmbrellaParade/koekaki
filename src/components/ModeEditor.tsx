import { useState } from 'react'
import type { Mode } from '../lib/types'
import { TrashIcon } from './Icons'
import { Sheet } from './Sheet'

interface ModeEditorProps {
  /** 編集対象。null なら新規作成 */
  mode: Mode | null
  onSave: (mode: Mode) => void
  onDelete: (id: string) => void
  onClose: () => void
}

const EMOJI_CHOICES = ['✨', '📝', '✉️', '💬', '📋', '📰', '🎯', '🧠', '🔧', '🎬', '📣', '🗂️']

export function ModeEditor({ mode, onSave, onDelete, onClose }: ModeEditorProps) {
  const [name, setName] = useState(mode?.name ?? '')
  const [emoji, setEmoji] = useState(mode?.emoji ?? '✨')
  const [instruction, setInstruction] = useState(mode?.instruction ?? '')

  const canSave = name.trim().length > 0 && instruction.trim().length > 0

  const save = () => {
    if (!canSave) return
    onSave({
      id: mode?.id ?? `custom-${Date.now().toString(36)}`,
      name: name.trim(),
      emoji: emoji || '✨',
      instruction: instruction.trim(),
      custom: true,
    })
  }

  return (
    <Sheet
      title={mode ? 'モードを編集' : 'モードを作る'}
      onClose={onClose}
      footer={
        <>
          {mode && (
            <button className="btn danger sm" style={{ marginRight: 'auto' }} onClick={() => onDelete(mode.id)}>
              <TrashIcon />
              削除
            </button>
          )}
          <button className="btn sm" onClick={onClose}>
            やめる
          </button>
          <button className="btn primary sm" onClick={save} disabled={!canSave}>
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="mode-name">モード名</label>
        <input
          id="mode-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: note の下書き"
          maxLength={20}
        />
      </div>

      <div className="field">
        <span className="field-label">アイコン</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {EMOJI_CHOICES.map((e) => (
            <button
              key={e}
              type="button"
              className={`mode-chip${emoji === e ? ' active' : ''}`}
              onClick={() => setEmoji(e)}
              style={{ fontSize: 18, padding: '6px 12px' }}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="mode-inst">整形の指示</label>
        <textarea
          id="mode-inst"
          className="textarea"
          style={{ minHeight: 160 }}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={'例:\n- 敬体（です・ます）で書く\n- 冒頭に一行の要約を置く\n- 箇条書きは使わず、段落で書く'}
        />
        <div className="desc">
          「フィラーを消す」「言い直しを整理する」「要約しない」といった基本ルールは、すべてのモードに最初から入っています。
          ここには、このモードならではの書き方だけを書いてください。
        </div>
      </div>
    </Sheet>
  )
}
