import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConfigBanner } from './components/ConfigBanner'
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
import { compactDesktopMessage, decideDesktopCommand, type DesktopCommand } from './lib/desktopFlow'
import { processRecording } from './lib/pipeline'
import { allModes, findMode } from './lib/prompts'
import { WebSpeechTranscriber, type SpeechDiagnostic } from './lib/providers/webspeech'
import { Recorder } from './lib/recorder'
import { createSerialTaskQueue, enqueueSerialTask, waitForSerialTasks } from './lib/serialQueue'
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
  const desktop = window.koekakiDesktop
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
  /** 直近の音声認識で何が返ってきたか。実機の不具合を追うための記録 */
  const [diagnostics, setDiagnostics] = useState<SpeechDiagnostic[]>([])
  const [sheet, setSheet] = useState<'none' | 'settings' | 'history' | 'onboarding'>(
    () => (loadSettings().onboarded ? 'none' : 'onboarding'),
  )
  const [editingMode, setEditingMode] = useState<Mode | null | undefined>(undefined)
  const [desktopKeysLoaded, setDesktopKeysLoaded] = useState(() => !desktop)
  const [apiKeySaveState, setApiKeySaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(() =>
    desktop ? 'idle' : 'saved',
  )

  const recorderRef = useRef<Recorder | null>(null)
  const speechRef = useRef<WebSpeechTranscriber | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const startedAtRef = useRef(0)
  const spaceHeldRef = useRef(false)
  const phaseRef = useRef<Phase>('idle')
  const desktopRequestIdRef = useRef<string | null>(null)
  const desktopReadyReportedRef = useRef(false)
  const apiKeySaveQueueRef = useRef(createSerialTaskQueue())
  const apiKeySaveVersionRef = useRef(0)
  const lastPersistedApiKeysRef = useRef<Settings['apiKeys']>({ ...settings.apiKeys })
  /** 追記モードで直前の結果につなぐために、最新の結果を参照できるようにしておく */
  const resultRef = useRef<Result | null>(null)
  resultRef.current = result
  /** ブラウザ内蔵の認識では音量が取れないので、認識結果の更新時刻で無音を判定する */
  const lastPartialAtRef = useRef(0)
  /** 無音検出からの停止要求を、最新の stop 関数に渡すための箱 */
  const stopRef = useRef<() => void>(() => {})

  const { toasts, push: pushToast } = useToasts()
  const push = useCallback(
    (kind: 'ok' | 'err' | 'info', message: string, hint?: string) => {
      pushToast(kind, message, hint)
      if (kind !== 'err' || !desktop) return
      const compactMessage = compactDesktopMessage(message)
      if (!compactMessage) return
      desktop.reportError({
        message: compactMessage,
        hint: compactDesktopMessage(hint),
        requestId: desktopRequestIdRef.current ?? undefined,
      })
    },
    [desktop, pushToast],
  )

  const setAppPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const modes = useMemo(() => allModes(settings.customModes), [settings.customModes])
  const activeMode = useMemo(
    () => findMode(settings.activeModeId, settings.customModes),
    [settings.activeModeId, settings.customModes],
  )

  const patch = useCallback(
    (p: Partial<Settings>): Promise<void> => {
      let persistence = Promise.resolve()
      if (desktop && p.apiKeys) {
        const apiKeys = p.apiKeys
        const saveVersion = apiKeySaveVersionRef.current + 1
        apiKeySaveVersionRef.current = saveVersion
        setApiKeySaveState('saving')
        persistence = enqueueSerialTask(apiKeySaveQueueRef.current, () => desktop.saveApiKeys(apiKeys))
        void persistence.then(
          () => {
            lastPersistedApiKeysRef.current = { ...apiKeys }
            if (apiKeySaveVersionRef.current === saveVersion) setApiKeySaveState('saved')
          },
          () => {
            if (apiKeySaveVersionRef.current === saveVersion) {
              setApiKeySaveState('error')
              setSettings((prev) => {
                const restored: Settings = { ...prev, apiKeys: { ...lastPersistedApiKeysRef.current } }
                settingsRef.current = restored
                saveSettings(restored)
                return restored
              })
              push('err', 'API キーを保存できませんでした', '前の保存内容に戻しました。もう一度貼り付けてください。')
            }
          },
        )
      } else if (p.apiKeys) {
        setApiKeySaveState('saved')
      }
      setSettings((prev) => {
        const next = { ...prev, ...p }
        settingsRef.current = next
        saveSettings(next)
        return next
      })
      return persistence
    },
    [desktop, push],
  )

  const getSettingsForConnectionTest = useCallback(async (): Promise<Settings | null> => {
    try {
      await waitForSerialTasks(apiKeySaveQueueRef.current)
      if (!desktop) return settingsRef.current
      const apiKeys = await desktop.loadApiKeys()
      return { ...settingsRef.current, apiKeys }
    } catch {
      return null
    }
  }, [desktop])

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

  // ---- Electron の API キー（localStorage ではなく main 側の安全な保存領域） ----
  useEffect(() => {
    if (!desktop) return
    let active = true
    const loadVersion = apiKeySaveVersionRef.current
    void desktop
      .loadApiKeys()
      .then((apiKeys) => {
        if (active && apiKeySaveVersionRef.current === loadVersion) {
          lastPersistedApiKeysRef.current = { ...apiKeys }
          setSettings((prev) => {
            const next = { ...prev, apiKeys }
            settingsRef.current = next
            return next
          })
          setApiKeySaveState('saved')
        }
      })
      .catch(() => {
        if (active && apiKeySaveVersionRef.current === loadVersion) {
          setApiKeySaveState('error')
          push('err', 'API キーを読み込めませんでした', '設定画面で保存し直してください。')
        }
      })
      .finally(() => {
        if (active) setDesktopKeysLoaded(true)
      })
    return () => {
      active = false
    }
  }, [desktop, push])

  // ---- 録音中の経過時間 ----
  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => setElapsedMs(performance.now() - startedAtRef.current), 200)
    return () => clearInterval(id)
  }, [phase])

  // ---- ブラウザ内蔵の認識での自動停止（音量ではなく認識の途切れで判定） ----
  useEffect(() => {
    if (phase !== 'recording' || settings.silenceStopSec <= 0) return
    if (settings.transcribeEngine !== 'webspeech') return
    const limit = settings.silenceStopSec * 1000
    const id = setInterval(() => {
      // 一度も認識できていないうちは止めない（話し始めるまでの待ち時間を潰さないため）
      if (!liveText) return
      if (performance.now() - lastPartialAtRef.current > limit) stopRef.current()
    }, 300)
    return () => clearInterval(id)
  }, [phase, settings.silenceStopSec, settings.transcribeEngine, liveText])

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

  useEffect(() => {
    if (!desktop || !desktopReadyReportedRef.current || phase === 'idle') return
    desktop.reportState({
      phase,
      requestId: desktopRequestIdRef.current ?? undefined,
    })
  }, [desktop, phase])

  useEffect(() => {
    if (!desktop) return
    return desktop.onOpenSettings(() => setSheet('settings'))
  }, [desktop])

  const copyText = useCallback(
    async (text: string, silent = false) => {
      if (!text) return
      try {
        if (desktop) await desktop.writeClipboard(text)
        else await navigator.clipboard.writeText(text)
        if (!silent) push('ok', 'コピーしました')
      } catch {
        if (!silent) push('err', 'コピーできませんでした', 'テキストを選択して手動でコピーしてください。')
      }
    },
    [desktop, push],
  )

  const settleIdle = useCallback(
    (requestId: string | null = desktopRequestIdRef.current) => {
      if (desktop && desktopReadyReportedRef.current) {
        desktop.reportState({ phase: 'idle', requestId: requestId ?? undefined })
      }
      if (requestId === null || desktopRequestIdRef.current === requestId) {
        desktopRequestIdRef.current = null
      }
      setAppPhase('idle')
    },
    [desktop, setAppPhase],
  )

  // ---- 変換の実行 ----
  const runProcess = useCallback(
    async (
      audio: Blob | null,
      webSpeechText: string | null,
      durationMs: number,
      mode: Mode,
      desktopRequestId: string | null,
    ) => {
      if (!audio && !webSpeechText) {
        settleIdle(desktopRequestId)
        return
      }
      try {
        const out = await processRecording({
          audio,
          webSpeechText,
          durationMs,
          settings,
          mode,
          onStage: setAppPhase,
        })

        if (!out.polished.trim()) {
          push('err', '声が聞き取れませんでした', 'マイクに近づくか、もう少し長めに話してみてください。')
          settleIdle(desktopRequestId)
          return
        }

        // 追記モードなら、今ある文章の続きとしてつなぐ
        const previous = settings.appendMode ? resultRef.current : null
        const joinedPolished = previous?.polished
          ? `${previous.polished.replace(/\s+$/, '')}\n\n${out.polished}`
          : out.polished
        const joinedRaw = previous?.raw ? `${previous.raw.replace(/\s+$/, '')}\n${out.raw}` : out.raw

        setResult({
          raw: joinedRaw,
          polished: joinedPolished,
          modeName: mode.name,
          engine: out.engine,
          costUsd: (previous?.costUsd ?? 0) + out.costUsd,
        })
        setLiveText('')

        if (desktop && desktopRequestId) {
          // 追記後の全文ではなく、今回の録音で得た分だけを渡す。
          await desktop.completeDictation({ requestId: desktopRequestId, text: out.polished })
        } else if (settings.autoCopy) {
          void copyText(joinedPolished, true)
        }

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
        settleIdle(desktopRequestId)
      } catch (err) {
        if (err instanceof ApiError) push('err', err.message, err.hint)
        else push('err', err instanceof Error ? err.message : '変換に失敗しました')
        settleIdle(desktopRequestId)
      }
    },
    [settings, setAppPhase, settleIdle, push, desktop, copyText],
  )

  // ---- 録音の開始・停止 ----
  const startRecording = useCallback(async (desktopRequestId: string | null = null) => {
    if (phaseRef.current !== 'idle') return
    desktopRequestIdRef.current = desktopRequestId
    if (missingKey.length > 0) {
      // 画面上部のバナーに一発で直せるボタンを出しているので、そちらへ誘導する。
      // ここで設定画面を開いてしまうと、何を直せばいいのか分からなくなる。
      push(
        'err',
        `${missingKey.join(' と ')} の API キーが未設定です`,
        '画面上の黄色い案内から「キーなしで無料で使う」または使えるキーを選んでください。',
      )
      if (desktopRequestId) setSheet('settings')
      settleIdle(desktopRequestId)
      if (desktopRequestId) desktop?.requestOpenSettings()
      return
    }

    setAppPhase('starting')
    setLiveText('')
    setElapsedMs(0)
    setPending(null)

    // ブラウザ内蔵の音声認識を使うときは MediaRecorder を起動しない。
    // 同じマイクを2つの仕組みで掴むと、Chrome では認識結果が空になることがある。
    // 録音データも使わないので、そもそも録る必要がない。
    if (settings.transcribeEngine === 'webspeech') {
      const speech = new WebSpeechTranscriber({
        onPartial: (text) => {
          setLiveText(text)
          lastPartialAtRef.current = performance.now()
        },
        onUnavailable: () => {
          if (speechRef.current !== speech) return
          stopRef.current()
        },
      })
      speechRef.current = speech
      try {
        speech.start(settings.spokenLang === 'ja' ? 'ja-JP' : settings.spokenLang)
      } catch (err) {
        speechRef.current = null
        if (err instanceof ApiError) push('err', err.message, err.hint)
        else push('err', 'ブラウザの音声認識を開始できませんでした')
        settleIdle(desktopRequestId)
        return
      }
      startedAtRef.current = performance.now()
      lastPartialAtRef.current = performance.now()
      setAppPhase('recording')
      return
    }

    const recorder = new Recorder({
      onLevel: setLevel,
      onSilence: () => stopRef.current(),
      onError: (e) => {
        // stop 済みの古い Recorder から遅れて届いたエラーで、現セッションを壊さない。
        if (recorderRef.current !== recorder) return
        recorder.cancel()
        recorderRef.current = null
        setLevel(0)
        setLiveText('')
        setPending(null)
        push('err', e.message)
        settleIdle(desktopRequestId)
      },
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
      settleIdle(desktopRequestId)
      return
    }

    startedAtRef.current = performance.now()
    setAppPhase('recording')
  }, [missingKey, settings, push, setAppPhase, settleIdle, desktop])

  const stopRecording = useCallback(async () => {
    if (phaseRef.current !== 'recording') return
    const desktopRequestId = desktopRequestIdRef.current
    setAppPhase('transcribing')
    const durationMsRaw = performance.now() - startedAtRef.current

    // ---- ブラウザ内蔵の音声認識 ----
    const speech = speechRef.current
    if (speech) {
      speechRef.current = null
      let webSpeechText = ''
      try {
        webSpeechText = await speech.stop()
      } catch (err) {
        setDiagnostics(speech.getDiagnostics())
        if (err instanceof ApiError) push('err', err.message, err.hint)
        else push('err', '音声認識に失敗しました')
        settleIdle(desktopRequestId)
        return
      }
      // 実機で何が返ってきたのかを、あとから設定画面で確認できるようにしておく
      setDiagnostics(speech.getDiagnostics())

      if (!webSpeechText.trim()) {
        // ここで黙って終わると「押しても無反応」に見えるので、必ず理由を出す
        push(
          'err',
          '声を認識できませんでした',
          durationMsRaw < 1200
            ? 'もう少し長め（2秒以上）に話してみてください。'
            : 'マイクの許可を確認し、はっきり話してみてください。改善しない場合は設定で文字起こしを Gemini か OpenAI に切り替えると安定します。',
        )
        settleIdle(desktopRequestId)
        return
      }

      if (speech.getTerminalError()) {
        push(
          'info',
          '音声認識が途中で中断されました',
          'ここまで聞き取れた内容だけを処理します。続きは、もう一度マイクを押して話してください。',
        )
      }

      if (!settings.autoProcess && !desktopRequestId) {
        setPending({ audio: null, webSpeechText, durationMs: durationMsRaw })
        settleIdle(desktopRequestId)
        return
      }
      await runProcess(null, webSpeechText, durationMsRaw, activeMode, desktopRequestId)
      return
    }

    // ---- 録音して API に送る経路 ----
    const recorder = recorderRef.current
    if (!recorder) {
      push('err', '録音状態を確認できませんでした', 'もう一度お試しください。')
      settleIdle(desktopRequestId)
      return
    }
    recorderRef.current = null

    let audio: Blob | null = null
    let durationMs = durationMsRaw
    try {
      const res = await recorder.stop()
      audio = res.blob
      durationMs = res.durationMs
    } catch {
      setLevel(0)
      push('err', '録音データを取り出せませんでした', 'もう一度お試しください。')
      settleIdle(desktopRequestId)
      return
    }
    setLevel(0)

    if (durationMs < 400) {
      push('err', '短すぎます', '1秒以上話してください。')
      settleIdle(desktopRequestId)
      return
    }

    if (!audio || audio.size < 1024) {
      push('err', '音声が空でした', 'マイクがミュートになっていないか確認してください。')
      settleIdle(desktopRequestId)
      return
    }

    if (!settings.autoProcess && !desktopRequestId) {
      // 録音を手元に置いたまま待つ。モードを選び直してから変換できる。
      setPending({ audio, webSpeechText: null, durationMs })
      settleIdle(desktopRequestId)
      return
    }

    await runProcess(audio, null, durationMs, activeMode, desktopRequestId)
  }, [settings.autoProcess, activeMode, runProcess, push, setAppPhase, settleIdle])

  stopRef.current = () => void stopRecording()

  const cancelRecording = useCallback(() => {
    const desktopRequestId = desktopRequestIdRef.current
    recorderRef.current?.cancel()
    recorderRef.current = null
    speechRef.current?.cancel()
    speechRef.current = null
    setLevel(0)
    setLiveText('')
    setPending(null)
    settleIdle(desktopRequestId)
  }, [settleIdle])

  const toggleRecording = useCallback(() => {
    if (phaseRef.current === 'recording') void stopRecording()
    else if (phaseRef.current === 'idle') void startRecording(null)
  }, [startRecording, stopRecording])

  useEffect(() => {
    if (!desktop || !desktopKeysLoaded) return

    // 先に購読を確立し、その後で main に準備完了を伝える。
    const unsubscribe = desktop.onCommand((command: DesktopCommand) => {
      const decision = decideDesktopCommand(phaseRef.current, desktopRequestIdRef.current, command)
      if (decision === 'start') void startRecording(command.requestId)
      else if (decision === 'stop') void stopRecording()
    })

    if (!desktopReadyReportedRef.current) {
      desktopReadyReportedRef.current = true
      desktop.reportReady({ onboarded: settings.onboarded })
      desktop.reportState({ phase: 'idle' })
    }
    return unsubscribe
  }, [desktop, desktopKeysLoaded, settings.onboarded, startRecording, stopRecording])

  // ---- スペースキーで録音 ----
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (sheet !== 'none' || editingMode !== undefined) return

      // 右 Alt は押すたびに開始／停止を切り替える。文字を打つキーではないので、
      // テキスト編集中でも受け付けてよい。
      if (e.code === 'AltRight') {
        if (e.repeat) return
        e.preventDefault()
        // Electron では PowerShell フックから届く requestId 付き指示だけを使う。
        if (desktop) return
        if (phase === 'recording') void stopRecording()
        else if (phase === 'idle') void startRecording()
        return
      }

      if (e.code !== 'Space' || e.repeat || isTyping()) return
      e.preventDefault()
      spaceHeldRef.current = true
      if (phase === 'idle') void startRecording()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      // 右 Alt はトグルなので、離したときは何もしない（メニューへのフォーカス移動だけ止める）
      if (e.code === 'AltRight') {
        e.preventDefault()
        return
      }
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
  }, [desktop, phase, sheet, editingMode, startRecording, stopRecording])

  // ---- 各種ハンドラ ----
  const handleConvertPending = useCallback(() => {
    if (!pending) return
    const { audio, webSpeechText, durationMs } = pending
    setPending(null)
    void runProcess(audio, webSpeechText, durationMs, activeMode, null)
  }, [pending, activeMode, runProcess])

  const handleAddToDictionary = useCallback(
    (term: string) => {
      const trimmed = term.trim()
      if (!trimmed) {
        push('err', '語が選択されていません', '結果のテキストで直したい語をなぞって選んでから押してください。')
        return
      }
      if (settings.dictionary.some((d) => d.term === trimmed)) {
        push('ok', `「${trimmed}」はすでに辞書にあります`)
        return
      }
      patch({ dictionary: [...settings.dictionary, { term: trimmed }] })
      push('ok', `「${trimmed}」を辞書に追加しました`, '次からはこの表記に直されます')
    },
    [settings.dictionary, patch, push],
  )

  const handleRepolish = useCallback(() => {
    if (!result?.raw) return
    void runProcess(null, result.raw, 0, activeMode, null)
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

  const busy = phase === 'starting' || phase === 'transcribing' || phase === 'polishing'

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

      {missingKey.length > 0 && (
        <ConfigBanner
          missing={missingKey}
          settings={settings}
          onApply={(p) => {
            patch(p)
            push('ok', '設定を切り替えました', 'マイクを押せば使えます')
          }}
          onOpenSettings={() => setSheet('settings')}
        />
      )}

      <RecordStage
        phase={phase}
        level={level}
        elapsedMs={elapsedMs}
        liveText={settings.showLiveText ? liveText : ''}
        speechDetected={liveText.trim().length > 0}
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
          appendMode={settings.appendMode}
          onChange={(text) => setResult((r) => (r ? { ...r, polished: text } : r))}
          onCopy={() => void copyText(result.polished)}
          onShare={handleShare}
          onRepolish={handleRepolish}
          onClear={() => setResult(null)}
          onToggleAppend={() => patch({ appendMode: !settings.appendMode })}
          onAddToDictionary={handleAddToDictionary}
        />
      )}

      {sheet === 'settings' && (
        <SettingsSheet
          settings={settings}
          onChange={patch}
          apiKeySaveState={apiKeySaveState}
          apiKeysLoaded={desktopKeysLoaded}
          getSettingsForConnectionTest={getSettingsForConnectionTest}
          onClose={() => setSheet('none')}
          onClearHistory={handleClearHistory}
          onNotify={push}
          diagnostics={diagnostics}
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
