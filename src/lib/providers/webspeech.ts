import { appendWithoutOverlap, collapseRepeatedSegments } from '../dedupe.ts'
import { ApiError } from '../types.ts'

/**
 * ブラウザ内蔵の音声認識（Web Speech API）。
 * 完全無料でリアルタイムに文字が出るのが強みだが、実装の癖が端末ごとに大きい。
 *
 * とくに Android Chrome は continuous=true でも短い無音で終了することがある。
 * スマホでは1回ずつ区切る設定にしつつ、ユーザーが停止するまでは自動で次の認識を始める。
 * 区切りをまたいで同じ内容が返る端末もあるため、結果は重なりを除いて連結する。
 */

interface SpeechRecognitionAlternativeLike {
  transcript: string
}
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: SpeechRecognitionAlternativeLike
  length: number
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string
  message?: string
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

const FATAL_RECOGNITION_ERRORS = new Set([
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'language-not-supported',
  'bad-grammar',
])
const NETWORK_RETRY_DELAYS_MS = [500, 1000, 2000] as const
const START_RETRY_DELAYS_MS = [400, 800, 1600] as const

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function hintForRecognitionError(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'マイクの使用が許可されていません。ブラウザの設定を確認してください。'
    case 'network':
      return 'ブラウザ内蔵の音声認識はネット接続が必要です。'
    case 'backgrounded':
      return 'アプリを前面に戻して、もう一度マイクを押してください。'
    case 'audio-capture':
      return 'マイクを使用できません。ほかのアプリの録音を止め、権限を確認してください。'
    case 'restart-failed':
      return '音声認識を再開できませんでした。もう一度マイクを押してください。'
    default:
      return '文字起こしエンジンを Gemini か OpenAI に切り替えると安定します。'
  }
}

export function isWebSpeechSupported(): boolean {
  return getCtor() !== null
}

/**
 * スマホかどうか。1回ずつ区切る認識へ切り替える判断に使う。
 * タッチ主体の端末は Android / iOS とみなす。
 */
export function prefersSegmentedRecognition(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent ?? '')
  return coarse || mobileUa
}

/** 実機で何が返ってきているかを後から確認するための記録 */
export interface SpeechDiagnostic {
  at: number
  kind: 'start' | 'result' | 'end' | 'restart' | 'error' | 'stop'
  detail: string
}

export interface WebSpeechEvents {
  /** 確定分 + 未確定分をつないだ、今のところの全文 */
  onPartial?: (text: string) => void
  /** 権限拒否や再接続失敗など、待っても戻らないときに1回だけ呼ぶ */
  onUnavailable?: () => void
}

export class WebSpeechTranscriber {
  private readonly events: WebSpeechEvents
  private recognition: SpeechRecognitionLike | null = null
  private recognitionActive = false
  /** セッションをまたいで確定した分 */
  private committedText = ''
  /** 現在のセッションの確定分（毎回 results から組み立て直す） */
  private sessionFinal = ''
  private interimText = ''
  private stopped = false
  private shouldRestart = false
  private lastError: string | null = null
  private terminalError: string | null = null
  private sessionError: string | null = null
  private lastRestartAt = 0
  private segmented = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartStartFailures = 0
  private networkFailures = 0
  private unavailableNotified = false
  private readonly log: SpeechDiagnostic[] = []

  private readonly handleVisibilityChange = () => {
    if (isPageHidden()) this.stopForBackground()
  }

  private readonly handlePageHide = () => {
    this.stopForBackground()
  }

  constructor(events: WebSpeechEvents = {}) {
    this.events = events
  }

  /** 直近の実行で何が起きたかの記録。設定画面からコピーできる。 */
  getDiagnostics(): SpeechDiagnostic[] {
    return this.log
  }

  /** 録音途中で回復不能になった理由。文字が一部取れていても利用者へ知らせる。 */
  getTerminalError(): string | null {
    return this.terminalError
  }

  private record(kind: SpeechDiagnostic['kind'], detail: string) {
    // 際限なく溜めない
    if (this.log.length < 200) this.log.push({ at: Date.now(), kind, detail })
  }

  private notifyUnavailable(error: string) {
    if (this.unavailableNotified || this.stopped) return
    this.unavailableNotified = true
    this.lastError = error
    this.terminalError = error
    this.shouldRestart = false
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    // error / end のコールバックを抜けてから App の停止処理へ渡す。
    setTimeout(() => {
      if (!this.stopped) this.events.onUnavailable?.()
    }, 0)
  }

  private attachPageGuards() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', this.handlePageHide)
    }
  }

  private detachPageGuards() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this.handlePageHide)
    }
  }

  private stopForBackground() {
    if (this.stopped || this.unavailableNotified) return
    this.notifyUnavailable('backgrounded')
    const rec = this.recognition
    this.recognitionActive = false
    try {
      // 背面でマイクを取り続けたり、復帰時に勝手に再取得したりしない。
      rec?.abort()
    } catch {
      // App側の停止処理でも後始末するため、ここでは通知を優先する。
    }
  }

  private scheduleRestart(rec: SpeechRecognitionLike, requestedDelay = 0) {
    if (this.stopped || !this.shouldRestart || this.restartTimer !== null) return
    if (isPageHidden()) {
      this.notifyUnavailable('backgrounded')
      return
    }

    // 終了と再開を高速で繰り返すと、同じ音声を二重に拾いやすい。
    const sinceLast = performance.now() - this.lastRestartAt
    const rateLimitDelay = sinceLast < 400 ? 400 - sinceLast : 0
    const delay = Math.max(rateLimitDelay, requestedDelay)
    this.lastRestartAt = performance.now() + delay

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopped || !this.shouldRestart) return
      if (isPageHidden()) {
        this.notifyUnavailable('backgrounded')
        return
      }
      try {
        this.sessionError = null
        rec.start()
        this.recognitionActive = true
        this.restartStartFailures = 0
        this.record('restart', `segmented=${this.segmented}`)
      } catch (error) {
        const detail = error instanceof Error ? error.name : 'unknown'
        this.record('error', `restart:${detail}`)
        this.restartStartFailures += 1
        const retryDelay = START_RETRY_DELAYS_MS[this.restartStartFailures - 1]
        if (retryDelay === undefined) {
          this.notifyUnavailable('restart-failed')
          return
        }
        this.scheduleRestart(rec, retryDelay)
      }
    }, delay)
  }

  start(lang: string, forceSegmented?: boolean): void {
    const Ctor = getCtor()
    if (!Ctor) {
      throw new ApiError(
        'このブラウザはブラウザ内蔵の音声認識に対応していません',
        'webspeech',
        undefined,
        '設定画面で文字起こしエンジンを Gemini か OpenAI に変更してください。',
      )
    }

    this.committedText = ''
    this.sessionFinal = ''
    this.interimText = ''
    this.stopped = false
    this.lastError = null
    this.terminalError = null
    this.sessionError = null
    this.log.length = 0
    this.segmented = forceSegmented ?? prefersSegmentedRecognition()
    // ブラウザが短い無音で認識を終えても、停止操作までは録音状態を保つ。
    this.shouldRestart = true
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.restartStartFailures = 0
    this.networkFailures = 0
    this.unavailableNotified = false
    this.lastRestartAt = performance.now()
    this.recognitionActive = false

    const rec = new Ctor()
    rec.lang = lang === 'auto' ? navigator.language || 'ja-JP' : lang
    // Android Chrome は continuous=true の結果が不安定なため、スマホだけ
    // 短いセッションを安全につなぐ。PC はブラウザ本来の連続認識を使う。
    rec.continuous = !this.segmented
    rec.interimResults = true
    rec.maxAlternatives = 1

    this.record('start', `segmented=${this.segmented} lang=${rec.lang} ua=${navigator.userAgent.slice(0, 80)}`)

    rec.onresult = (e) => {
      // results は「このセッションの全結果」を持つ累積リスト。
      // resultIndex から先だけを足すと、resultIndex が 0 に戻る端末で
      // 全文を何度も足してしまう。毎回ゼロから組み立て直す。
      const previousVisible = appendWithoutOverlap(this.committedText, this.sessionFinal + this.interimText)
      let final = ''
      let interim = ''
      const shape: string[] = []
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) final += text
        else interim += text
        shape.push(`${i}${result.isFinal ? 'F' : 'i'}:${text}`)
      }
      this.sessionFinal = final
      this.interimText = interim
      const nextVisible = appendWithoutOverlap(this.committedText, this.sessionFinal + this.interimText)
      // 再接続後に同じ結果を返す端末がある。内容が実際に増減したときだけ
      // network retryを回復扱いにし、重複結果で上限が無効化されないようにする。
      if (nextVisible !== previousVisible) {
        this.lastError = null
        this.networkFailures = 0
      }
      this.record('result', `idx=${e.resultIndex} n=${e.results.length} ${shape.join(' | ')}`)
      this.events.onPartial?.(nextVisible)
    }

    rec.onerror = (e) => {
      this.record('error', e.error)
      this.sessionError = e.error
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.lastError = e.error
      if (FATAL_RECOGNITION_ERRORS.has(e.error)) this.notifyUnavailable(e.error)
    }

    rec.onend = () => {
      this.recognitionActive = false
      // 直前に確定した内容をもう一度返してくる端末があるので、
      // 単純な連結ではなく重なりを取り除いてからつなぐ。
      // 未確定分もここで拾う（捨てると最後のひと言が消える）。
      this.committedText = appendWithoutOverlap(this.committedText, this.sessionFinal + this.interimText)
      this.sessionFinal = ''
      this.interimText = ''
      this.record('end', `committed=${this.committedText}`)

      const endedWith = this.sessionError
      this.sessionError = null
      if (FATAL_RECOGNITION_ERRORS.has(endedWith ?? '')) {
        this.notifyUnavailable(endedWith!)
        return
      }
      if (endedWith === 'network') {
        const retryDelay = NETWORK_RETRY_DELAYS_MS[this.networkFailures]
        this.networkFailures += 1
        if (retryDelay === undefined) {
          this.notifyUnavailable('network')
          return
        }
        this.scheduleRestart(rec, retryDelay)
        return
      }

      this.scheduleRestart(rec)
    }

    this.recognition = rec
    try {
      rec.start()
      this.recognitionActive = true
      this.attachPageGuards()
    } catch (error) {
      this.recognition = null
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      throw error
    }
  }

  /** 認識を止めて全文を返す */
  async stop(): Promise<string> {
    this.stopped = true
    this.shouldRestart = false
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.detachPageGuards()
    const rec = this.recognition
    if (rec && this.recognitionActive) {
      // 通常は onend まで待ち、最後の確定結果を拾う。ブラウザが応答しない場合だけ
      // 上限で抜ける。固定の短い待ち時間で末尾を切らないための形。
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(() => {
          this.recognitionActive = false
          try {
            rec.abort()
          } catch {
            // 応答しない認識器なので、上限到達後はそのまま切り離す。
          }
          finish()
        }, 1500)
        const originalOnEnd = rec.onend
        rec.onend = () => {
          try {
            originalOnEnd?.()
          } finally {
            finish()
          }
        }
        try {
          rec.stop()
        } catch {
          // すでに終了している場合は待たない。
          this.recognitionActive = false
          finish()
        }
      })
    }
    if (rec) {
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
    }
    this.recognitionActive = false
    this.recognition = null

    const joined = appendWithoutOverlap(this.committedText, this.sessionFinal + this.interimText)
    const text = collapseRepeatedSegments(joined.trim())
    this.record('stop', `result=${text}`)

    if (!text && this.lastError) {
      throw new ApiError(
        `ブラウザの音声認識でエラーが発生しました (${this.lastError})`,
        'webspeech',
        undefined,
        hintForRecognitionError(this.lastError),
      )
    }
    return text
  }

  cancel(): void {
    this.stopped = true
    this.shouldRestart = false
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.detachPageGuards()
    const rec = this.recognition
    this.recognition = null
    this.recognitionActive = false
    if (rec) {
      // abortに伴う遅延イベントが、取消後の画面や結果を更新しないよう先に切り離す。
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
    }
    try {
      rec?.abort()
    } catch {
      // 破棄時のエラーは無視してよい
    }
  }
}
