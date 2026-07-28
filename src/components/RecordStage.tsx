import { formatDuration } from '../lib/audio'
import { LoaderIcon, MicIcon, StopIcon } from './Icons'

export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'polishing'

interface RecordStageProps {
  phase: Phase
  level: number
  elapsedMs: number
  /** 認識途中の文字。設定で表示をオフにしているときは空で渡ってくる */
  liveText: string
  /** 声が拾えているか。文字を出さないときの安心材料として使う */
  speechDetected: boolean
  compact: boolean
  disabled: boolean
  disabledReason?: string
  onToggle: () => void
  onCancel: () => void
  showKeyboardHint: boolean
}

const STATUS: Record<Phase, { primary: string; secondary: string }> = {
  idle: { primary: 'タップして話す', secondary: '詰まっても、言い直しても大丈夫です' },
  starting: { primary: 'マイクを準備しています…', secondary: '少しだけお待ちください' },
  recording: { primary: '聞いています…', secondary: 'もう一度タップで停止' },
  transcribing: { primary: '文字にしています…', secondary: '音声を送信中' },
  polishing: { primary: '文章を整えています…', secondary: 'もう少しです' },
}

export function RecordStage({
  phase,
  level,
  elapsedMs,
  liveText,
  speechDetected,
  compact,
  disabled,
  disabledReason,
  onToggle,
  onCancel,
  showKeyboardHint,
}: RecordStageProps) {
  const recording = phase === 'recording'
  const busy = phase === 'starting' || phase === 'transcribing' || phase === 'polishing'
  const status = STATUS[phase]

  // 音量に合わせてリングを膨らませる。1.0〜1.45 の範囲に収めると煩くならない。
  const ringScale = recording ? 1 + Math.min(level, 1) * 0.45 : 1
  // ブラウザ内蔵の認識では音量が取れないため、代わりに一定周期で脈打たせる
  const usePulse = recording && level === 0

  return (
    <section className={`stage${compact ? ' compact' : ''}`}>
      <div className="mic-wrap">
        <span
          className={`mic-ring${usePulse ? ' pulse' : ''}`}
          style={{
            transform: usePulse ? undefined : `scale(${ringScale})`,
            opacity: recording ? (usePulse ? undefined : 0.35 + level * 0.65) : 0,
            borderColor: 'var(--rec)',
            borderWidth: 3,
          }}
        />
        <span
          className="mic-ring"
          style={{
            transform: `scale(${1 + (ringScale - 1) * 0.55})`,
            opacity: recording ? 0.5 : 0.9,
            borderColor: recording ? 'var(--rec-soft)' : 'var(--accent-soft)',
          }}
        />
        <button
          type="button"
          className={`mic-btn${recording ? ' recording' : ''}${busy ? ' busy' : ''}`}
          onClick={onToggle}
          disabled={disabled || busy}
          aria-label={recording ? '録音を停止' : '録音を開始'}
          title={disabled ? disabledReason : undefined}
        >
          {busy ? <LoaderIcon className="spin" /> : recording ? <StopIcon /> : <MicIcon />}
        </button>
      </div>

      <div className="stage-status">
        <div className="primary">{disabled && disabledReason ? disabledReason : status.primary}</div>
        {recording ? (
          <div className="timer">{formatDuration(elapsedMs)}</div>
        ) : (
          <div className="secondary">{status.secondary}</div>
        )}
      </div>

      {/*
        認識途中の文字は必ず乱れる（同じ語が並ぶ、途中で書き換わる）ので、既定では出さない。
        代わりに「拾えている」ことだけ伝える。仕上がりは停止後にまとめて見せる。
      */}
      {liveText ? (
        <div className="live-text">{liveText}</div>
      ) : (
        recording && <div className="live-text subtle">{speechDetected ? '声を拾っています' : '話しかけてください'}</div>
      )}

      {recording && (
        <div className="stage-actions">
          <button className="btn ghost sm" onClick={onCancel}>
            取り消す
          </button>
        </div>
      )}

      {showKeyboardHint && phase === 'idle' && !disabled && (
        <p className="hint">
          <kbd>右Alt</kbd> で開始／停止　・　<kbd>Space</kbd> 長押しでも録音できます
        </p>
      )}
    </section>
  )
}
