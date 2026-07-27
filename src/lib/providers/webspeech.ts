import { appendWithoutOverlap, collapseRepeatedSegments } from '../dedupe.ts'
import { ApiError } from '../types.ts'

/**
 * ブラウザ内蔵の音声認識（Web Speech API）。
 * 完全無料でリアルタイムに文字が出るのが強みだが、実装の癖が端末ごとに大きい。
 *
 * とくに Android Chrome は連続認識（continuous）が実質まともに動かず、
 * 「勝手に終了 → 再開」を繰り返すうちに同じ内容を何度も返してくる。
 * 実機で「同じ文が7回並ぶ」不具合が出たのはこれが原因。
 *
 * そのため、スマホでは連続認識と自動再開そのものを使わない（単発モード）。
 * 1回話すたびに1つの結果が返るだけなので、重複が起きる余地が構造的に無い。
 * PC では連続認識が安定して動くので従来どおり。
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

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function isWebSpeechSupported(): boolean {
  return getCtor() !== null
}

/**
 * スマホかどうか。連続認識を避ける判断に使う。
 * タッチ主体の端末は Android / iOS とみなす。
 */
export function prefersSingleShot(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent ?? '')
  return coarse || mobileUa
}

/** 実機で何が返ってきているかを後から確認するための記録 */
export interface SpeechDiagnostic {
  at: number
  kind: 'start' | 'result' | 'end' | 'error' | 'stop'
  detail: string
}

export interface WebSpeechEvents {
  /** 確定分 + 未確定分をつないだ、今のところの全文 */
  onPartial?: (text: string) => void
  /** 単発モードで、ブラウザ側が認識を終えた */
  onAutoEnd?: () => void
}

export class WebSpeechTranscriber {
  private readonly events: WebSpeechEvents
  private recognition: SpeechRecognitionLike | null = null
  /** セッションをまたいで確定した分 */
  private committedText = ''
  /** 現在のセッションの確定分（毎回 results から組み立て直す） */
  private sessionFinal = ''
  private interimText = ''
  private stopped = false
  private shouldRestart = false
  private lastError: string | null = null
  private lastRestartAt = 0
  private singleShot = false
  private readonly log: SpeechDiagnostic[] = []

  constructor(events: WebSpeechEvents = {}) {
    this.events = events
  }

  /** 直近の実行で何が起きたかの記録。設定画面からコピーできる。 */
  getDiagnostics(): SpeechDiagnostic[] {
    return this.log
  }

  private record(kind: SpeechDiagnostic['kind'], detail: string) {
    // 際限なく溜めない
    if (this.log.length < 200) this.log.push({ at: Date.now(), kind, detail })
  }

  start(lang: string, forceSingleShot?: boolean): void {
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
    this.log.length = 0
    this.singleShot = forceSingleShot ?? prefersSingleShot()
    // 単発モードでは再開しない。これが重複を根本から断つ。
    this.shouldRestart = !this.singleShot

    const rec = new Ctor()
    rec.lang = lang === 'auto' ? navigator.language || 'ja-JP' : lang
    rec.continuous = !this.singleShot
    rec.interimResults = true
    rec.maxAlternatives = 1

    this.record('start', `singleShot=${this.singleShot} lang=${rec.lang} ua=${navigator.userAgent.slice(0, 80)}`)

    rec.onresult = (e) => {
      // results は「このセッションの全結果」を持つ累積リスト。
      // resultIndex から先だけを足すと、resultIndex が 0 に戻る端末で
      // 全文を何度も足してしまう。毎回ゼロから組み立て直す。
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
      this.record('result', `idx=${e.resultIndex} n=${e.results.length} ${shape.join(' | ')}`)
      this.events.onPartial?.(this.committedText + this.sessionFinal + this.interimText)
    }

    rec.onerror = (e) => {
      this.record('error', e.error)
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.lastError = e.error
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.shouldRestart = false
    }

    rec.onend = () => {
      // 直前に確定した内容をもう一度返してくる端末があるので、
      // 単純な連結ではなく重なりを取り除いてからつなぐ。
      // 未確定分もここで拾う（捨てると最後のひと言が消える）。
      this.committedText = appendWithoutOverlap(this.committedText, this.sessionFinal + this.interimText)
      this.sessionFinal = ''
      this.interimText = ''
      this.record('end', `committed=${this.committedText}`)

      if (this.singleShot) {
        // 再開しない。話し終わりをそのまま録音終了として扱う。
        if (!this.stopped) this.events.onAutoEnd?.()
        return
      }

      if (this.shouldRestart && !this.stopped) {
        // 終了と再開を高速で繰り返すと同じ音声を二重に拾いやすい。少し間を置く。
        const sinceLast = performance.now() - this.lastRestartAt
        const delay = sinceLast < 400 ? 400 - sinceLast : 0
        this.lastRestartAt = performance.now() + delay
        setTimeout(() => {
          if (this.stopped || !this.shouldRestart) return
          try {
            rec.start()
          } catch {
            // 再起動できなければ諦める（stop() 側で結果は返せる）
          }
        }, delay)
      }
    }

    this.recognition = rec
    rec.start()
  }

  /** 認識を止めて全文を返す */
  async stop(): Promise<string> {
    this.stopped = true
    this.shouldRestart = false
    const rec = this.recognition
    if (rec) {
      try {
        rec.stop()
      } catch {
        // すでに終わっていることがある
      }
      // 最後の onresult / onend が届くのを少しだけ待つ
      await new Promise((r) => setTimeout(r, 350))
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
    }
    this.recognition = null

    const joined = appendWithoutOverlap(this.committedText, this.sessionFinal + this.interimText)
    const text = collapseRepeatedSegments(joined.trim())
    this.record('stop', `result=${text}`)

    if (!text && this.lastError) {
      throw new ApiError(
        `ブラウザの音声認識でエラーが発生しました (${this.lastError})`,
        'webspeech',
        undefined,
        this.lastError === 'not-allowed'
          ? 'マイクの使用が許可されていません。ブラウザの設定を確認してください。'
          : this.lastError === 'network'
            ? 'ブラウザ内蔵の音声認識はネット接続が必要です。'
            : '文字起こしエンジンを Gemini か OpenAI に切り替えると安定します。',
      )
    }
    return text
  }

  cancel(): void {
    this.stopped = true
    this.shouldRestart = false
    try {
      this.recognition?.abort()
    } catch {
      // 破棄時のエラーは無視してよい
    }
    this.recognition = null
  }
}
