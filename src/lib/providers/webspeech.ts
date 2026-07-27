import { collapseRepeatedSegments } from '../dedupe.ts'
import { ApiError } from '../types.ts'

/**
 * ブラウザ内蔵の音声認識（Web Speech API）。
 * 完全無料でリアルタイムに文字が出るのが強みだが、対応ブラウザが限られる。
 * Chrome / Edge / Android Chrome は良好。iOS Safari は不安定な報告が多い。
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

export interface WebSpeechEvents {
  /** 確定分 + 未確定分をつないだ、今のところの全文 */
  onPartial?: (text: string) => void
}

export class WebSpeechTranscriber {
  private recognition: SpeechRecognitionLike | null = null
  /**
   * 認識が一度終了して再開するまでに確定した分。
   * onresult の results は「そのセッションの全結果」なので、
   * セッションをまたぐ分だけをここに積む。
   */
  private committedText = ''
  /** 現在のセッションで確定している分（毎回 results から組み立て直す） */
  private sessionFinal = ''
  private interimText = ''
  private stopped = false
  /** ユーザーが止めていないのに onend が来たら再起動する（Chrome は数十秒で勝手に切れる） */
  private shouldRestart = false
  private lastError: string | null = null

  private readonly events: WebSpeechEvents

  constructor(events: WebSpeechEvents = {}) {
    this.events = events
  }

  start(lang: string): void {
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
    this.shouldRestart = true
    this.lastError = null

    const rec = new Ctor()
    rec.lang = lang === 'auto' ? navigator.language || 'ja-JP' : lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (e) => {
      // results は「このセッションの全結果」を持つ累積リスト。
      // resultIndex から先だけを足していくと、Android Chrome のように
      // resultIndex が 0 に戻る環境で同じ文を何度も足してしまう（羅列バグ）。
      // 毎回ゼロから組み立て直せば、何度呼ばれても結果は同じになる。
      let final = ''
      let interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) final += text
        else interim += text
      }
      this.sessionFinal = final
      this.interimText = interim
      this.events.onPartial?.(this.committedText + this.sessionFinal + this.interimText)
    }

    rec.onerror = (e) => {
      // no-speech / aborted は正常系として扱う
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.lastError = e.error
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.shouldRestart = false
    }

    rec.onend = () => {
      // セッションが切れたら、そこまでの分を確定済みへ移す。
      // 再開後の results は空から始まるので、ここで移さないと消えてしまう。
      //
      // 未確定分もここで拾う。確定に変わっていれば直前の onresult で
      // sessionFinal 側に入り interimText は空になっているはずなので、
      // 残っているということはブラウザが確定させずに切ったということ。
      // 捨てると最後のひと言が消えてしまう。
      this.committedText += this.sessionFinal + this.interimText
      this.sessionFinal = ''
      this.interimText = ''

      if (this.shouldRestart && !this.stopped) {
        try {
          rec.start()
        } catch {
          // 再起動できなければ諦める（stop() 側で結果は返せる）
        }
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
      rec.stop()
      // 最後の onresult が届くのを少しだけ待つ
      await new Promise((r) => setTimeout(r, 350))
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
    }
    this.recognition = null

    const text = collapseRepeatedSegments(
      (this.committedText + this.sessionFinal + this.interimText).trim(),
    )
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
