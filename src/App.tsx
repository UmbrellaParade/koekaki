import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HistorySheet } from './components/HistorySheet'
import { HistoryIcon, SettingsIcon, MicIcon } from './components/Icons'
import { ModeBar } from './components/ModeBar'
import { ModeEditor } from './components/ModeEditor'
import { Onboarding } from './components/Onboarding'
import { RecordStage, type Phase } from './components/RecordStage'
import { ResultPanel } from './components/ResultPanel'
import { SettingsSheet } from './components/SettingsSheet'
import { ToastArea, useToasts } from './components/Toast'
import { formatDuration } from './lib/audio'
import { addHistory, clearHistory, deleteHistory, listHistory } from './lib/db'
import { processRecording } from './lib/pipeline'
import { allModes, findMode } from './lib/prompts'
import { WebSpeechTranscriber } from './lib/providers/webspeech'
import { Recorder } from './lib/recorder'
import { loadSettings, saveSettings } from './lib/storage'
import type { HistoryItem, Mode, Settings } from './lib/types'
import { ApiError } from './lib/types'

interface Result {
  raw: string
  polished: string
  modeName: string
  engine: string
  costUsd: number
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [liveText, setLiveText] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  /** 「自動で変換」オフのとき、変換ボタンが押されるまで録音を保持しておく */
  const [pending, setPending] = useState<{ audio: Blob | null; webSpeechText: string | null; durationMs: number } | null>(
    null,
  )
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [sheet, setSheet] = useState<'none' | 'settings' | 'history' | 'onboarding'>(
    () => (loadSettings().onboarded ? 'none' : 'onboarding'),
  )
  const [editingMode, setEditingMode] = useState<Mode | null | undefined>(undefined)
  const { toasts, push } = useToasts()

  const recorderRef = useRef<Recorder | null>(null)
  const speechRef = useRef<WebSpeechTranscriber | null>(null)
  const startedAtRef = useRef(0)
  const spaceHeldRef = useRef(false)
  /** 無音検出からの停止要求を、最新の stop 関数に渡すための箱 */
  const stopRef = useRef<() => void>(() => {})

  const modes = useMemo(() => allModes(settings.customModes), [settings.customModes])
  const activeMode = useMemo(
    () => findMode(settings.activeModeId, settings.customModes),
    [settings.activeModeId, settings.customModes],
  )

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...p }
      saveSettings(next)
      return next
    })
  }, [])

  // ---- テーマ ----
  useEffect(() => {
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#0f1115' : '#f6f7fa')
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme])

  // ---- 履歴の読み込み ----
  useEffect(() => {
    listHistory()
      .then(setHistory)
      .catch(() => undefined)
  }, [])

  // ---- 録音中の経過時間 ----
  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => setElapsedMs(performance.now() - startedAtRef.current), 200)
    return () => clearInterval(id)
  }, [phase])

  const missingKey = useMemo(() => {
    const needs: string[] = []
    if (settings.transcribeEngine === 'gemini' && !settings.apiKeys.gemini) needs.push('Gemini')
    if (settings.transcribeEngine === 'openai' && !settings.apiKeys.openai) needs.push('OpenAI')
    if (activeMode.id !== 'raw') {
      if (settings.polishEngine === 'gemini' && !settings.apiKeys.gemini) needs.push('Gemini')
      if (settings.polishEngine === 'openai' && !settings.apiKeys.openai) needs.push('OpenAI')
      if (settings.polishEngine === 'anthropic' && !settings.apiKeys.anthropic) needs.push('Claude')
    }
    return [...new Set(needs)]
  }, [settings, activeMode])

  const copyText = useCallback(
    async (text: string, silent = false) => {
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        if (!silent) push('ok', 'コピーしました')
      } catch {
        if (!silent) push('err', 'コピーできませんでした', 'テキストを選択して手動でコピーしてください。')
      }
    },
    [push],
  )

  // ---- 変換の実行 ----
  const runProcess = useCallback(
    async (audio: Blob | null, webSpeechText: string | null, durationMs: number, mode: Mode) => {
      if (!audio && !webSpeechText) {
        setPhase('idle')
        return
      }
      try {
        const out = await processRecording({
          audio,
          webSpeechText,
          durationMs,
          settings,
          mode,
          onStage: (stage) => setPhase(stage),
        })

        if (!out.polished.trim()) {
          setPhase('idle')
          push('err', '声が聞き取れませんでした', 'マイクに近づくか、もう少し長めに話してみてください。')
          return
        }

        setResult({
          raw: out.raw,
          polished: out.polished,
          modeName: mode.name,
          engine: out.engine,
          costUsd: out.costUsd,
        })
        setPhase('idle')
        setLiveText('')

        if (settings.autoCopy) void copyText(out.polished, true)

        if (settings.saveHistory) {
          const item: HistoryItem = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: Date.now(),
            raw: out.raw,
            polished: out.polished,
            modeId: mode.id,
            modeName: mode.name,
            durationMs,
            engine: out.engine,
            costUsd: out.costUsd,
          }
          addHistory(item)
            .then(() => setHistory((prev) => [item, ...prev]))
            .catch(() => undefined)
        }
      } catch (err) {
        setPhase('idle')
        if (err instanceof ApiError) push('err', err.message, err.hint)
        else push('err', err instanceof Error ? err.message : '変換に失敗しました')
      }
    },
    [settings, push, copyText],
  )

  // ---- 録音の開始・停止 ----
  const startRecording = useCallback(async () => {
    if (phase !== 'idle') return
    if (missingKey.length > 0) {
      push('err', `${missingKey.join(' と ')} の API キーが未設定です`, '設定画面からキーを登録してください。')
      setSheet('settings')
      return
    }

    setLiveText('')
    setElapsedMs(0)
    setPending(null)

    const recorder = new Recorder({
      onLevel: setLevel,
      onSilence: () => stopRef.current(),
      onError: (e) => push('err', e.message),
    })
    recorderRef.current = recorder

    try {
      await recorder.start(settings.silenceStopSec)
    } catch (err) {
      recorderRef.current = null
      const name = err instanceof Error ? err.name : ''
      push(
        'err',
        'マイクを使えませんでした',
        name === 'NotAllowedError'
          ? 'ブラウザのアドレスバーの鍵アイコンから、マイクの使用を許可してください。'
          : name === 'NotFoundError'
            ? 'マイクが見つかりません。接続を確認してください。'
            : 'HTTPS でないページではマイクを使えません。',
      )
      return
    }

    if (settings.transcribeEngine === 'webspeech') {
      const speech = new WebSpeechTranscriber({ onPartial: setLiveText })
      speechRef.current = speech
      try {
        speech.start(settings.spokenLang === 'ja' ? 'ja-JP' : settings.spokenLang)
      } catch (err) {
        speechRef.current = null
        recorder.cancel()
        recorderRef.current = null
        if (err instanceof ApiError) push('err', err.message, err.hint)
        return
      }
    }

    startedAtRef.current = performance.now()
    setPhase('recording')
  }, [phase, missingKey, settings, push])

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder || phase !== 'recording') return
    recorderRef.current = null
    setPhase('transcribing')

    let audio: Blob | null = null
    let durationMs = performance.now() - startedAtRef.current
    try {
      const res = await recorder.stop()
      audio = res.blob
      durationMs = res.durationMs
    } catch {
      // Blob が取れなくても Web Speech 経路なら続行できる
    }
    setLevel(0)

    let webSpeechText: string | null = null
    const speech = speechRef.current
    if (speech) {
      speechRef.current = null
      try {
        webSpeechText = await speech.stop()
      } catch (err) {
        setPhase('idle')
        if (err instanceof ApiError) push('err', err.message, err.hint)
        return
      }
      audio = null
    }

    if (durationMs < 400) {
      setPhase('idle')
      push('err', '短すぎます', 'ボタンを押したまま、1秒以上話してください。')
      return
    }

    if (!settings.autoProcess) {
      // 録音を手元に置いたまま待つ。モードを選び直してから変換できる。
      setPhase('idle')
      setPending({ audio, webSpeechText, durationMs })
      return
    }

    await runProcess(audio, webSpeechText, durationMs, activeMode)
  }, [phase, settings.autoProcess, activeMode, runProcess, push])

  stopRef.current = () => void stopRecording()

  const cancelRecording = useCallback(() => {
    recorderRef.current?.cancel()
    recorderRef.current = null
    speechRef.current?.cancel()
    speechRef.current = null
    setLevel(0)
    setLiveText('')
    setPending(null)
    setPhase('idle')
  }, [])

  const toggleRecording = useCallback(() => {
    if (phase === 'recording') void stopRecording()
    else if (phase === 'idle') void startRecording()
  }, [phase, startRecording, stopRecording])

  // ---- スペースキーで録音 ----
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping() || sheet !== 'none' || editingMode !== undefined) return
      e.preventDefault()
      spaceHeldRef.current = true
      if (phase === 'idle') void startRecording()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceHeldRef.current) return
      spaceHeldRef.current = false
      e.preventDefault()
      if (phase === 'recording') void stopRecording()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [phase, sheet, editingMode, startRecording, stopRecording])

  // ---- 各種ハンドラ ----
  const handleConvertPending = useCallback(() => {
    if (!pending) return
    const { audio, webSpeechText, durationMs } = pending
    setPending(null)
    void runProcess(audio, webSpeechText, durationMs, activeMode)
  }, [pending, activeMode, runProcess])

  const handleRepolish = useCallback(() => {
    if (!result?.raw) return
    void runProcess(null, result.raw, 0, activeMode)
  }, [result, activeMode, runProcess])

  const handleShare = useCallback(async () => {
    if (!result?.polished) return
    try {
      await navigator.share({ text: result.polished })
    } catch {
      // ユーザーがキャンセルした場合も例外になるため、何も通知しない
    }
  }, [result])

  const handleSaveMode = useCallback(
    (mode: Mode) => {
      const exists = settings.customModes.some((m) => m.id === mode.id)
      patch({
        customModes: exists ? settings.customModes.map((m) => (m.id === mode.id ? mode : m)) : [...settings.customModes, mode],
        activeModeId: mode.id,
      })
      setEditingMode(undefined)
      push('ok', `「${mode.name}」を保存しました`)
    },
    [settings.customModes, patch, push],
  )

  const handleDeleteMode = useCallback(
    (id: string) => {
      patch({
        customModes: settings.customModes.filter((m) => m.id !== id),
        activeModeId: settings.activeModeId === id ? 'standard' : settings.activeModeId,
      })
      setEditingMode(undefined)
    },
    [settings.customModes, settings.activeModeId, patch],
  )

  const handleSelectMode = useCallback(
    (id: string) => {
      const mode = modes.find((m) => m.id === id)
      if (mode?.custom && settings.activeModeId === id) {
        setEditingMode(mode)
        return
      }
      patch({ activeModeId: id })
    },
    [modes, settings.activeModeId, patch],
  )

  const handleClearHistory = useCallback(async () => {
    if (!window.confirm('履歴をすべて削除します。よろしいですか？')) return
    await clearHistory().catch(() => undefined)
    setHistory([])
    push('ok', '履歴を削除しました')
  }, [push])

  const handleDeleteHistory = useCallback(async (id: string) => {
    await deleteHistory(id).catch(() => undefined)
    setHistory((prev) => prev.filter((h) => h.id !== id))
  }, [])

  const busy = phase === 'transcribing' || phase === 'polishing'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <MicIcon size={16} />
          </span>
          こえかき
        </div>
        <button className="icon-btn" onClick={() => setSheet('history')} aria-label="履歴">
          <HistoryIcon />
        </button>
        <button
          className={`icon-btn${missingKey.length > 0 ? ' badge-on' : ''}`}
          onClick={() => setSheet('settings')}
          aria-label="設定"
        >
          <SettingsIcon />
        </button>
      </header>

      <ModeBar
        modes={modes}
        activeId={settings.activeModeId}
        onSelect={handleSelectMode}
        onAdd={() => setEditingMode(null)}
        disabled={phase !== 'idle'}
      />

      <RecordStage
        phase={phase}
        level={level}
        elapsedMs={elapsedMs}
        liveText={liveText}
        compact={result !== null}
        disabled={false}
        onToggle={toggleRecording}
        onCancel={cancelRecording}
        showKeyboardHint={window.matchMedia('(hover: hover)').matches}
      />

      {pending && phase === 'idle' && (
        <div className="pending-bar">
          <span>
            録音 {formatDuration(pending.durationMs)} を保留中 — モードを選んでから変換できます
          </span>
          <button className="btn ghost sm" onClick={() => setPending(null)}>
            捨てる
          </button>
          <button className="btn primary sm" onClick={handleConvertPending}>
            変換する
          </button>
        </div>
      )}

      {result && (
        <ResultPanel
          text={result.polished}
          rawText={result.raw}
          modeName={result.modeName}
          engine={result.engine}
          costUsd={result.costUsd}
          busy={busy}
          onChange={(text) => setResult((r) => (r ? { ...r, polished: text } : r))}
          onCopy={() => void copyText(result.polished)}
          onShare={handleShare}
          onRepolish={handleRepolish}
          onClear={() => setResult(null)}
        />
      )}

      {sheet === 'settings' && (
        <SettingsSheet
          settings={settings}
          onChange={patch}
          onClose={() => setSheet('none')}
          onClearHistory={handleClearHistory}
          onNotify={push}
        />
      )}

      {sheet === 'history' && (
        <HistorySheet
          items={history}
          onClose={() => setSheet('none')}
          onCopy={(text) => void copyText(text)}
          onReuse={(item) => {
            setResult({
              raw: item.raw,
              polished: item.polished,
              modeName: item.modeName,
              engine: item.engine,
              costUsd: item.costUsd ?? 0,
            })
            setSheet('none')
          }}
          onDelete={(id) => void handleDeleteHistory(id)}
          onNotify={push}
        />
      )}

      {sheet === 'onboarding' && (
        <Onboarding
          settings={settings}
          onChange={patch}
          onFinish={() => {
            patch({ onboarded: true })
            setSheet('none')
          }}
        />
      )}

      {editingMode !== undefined && (
        <ModeEditor
          mode={editingMode}
          onSave={handleSaveMode}
          onDelete={handleDeleteMode}
          onClose={() => setEditingMode(undefined)}
        />
      )}

      <ToastArea toasts={toasts} />
    </div>
  )
}
