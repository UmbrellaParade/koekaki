/** 音声を文字にするエンジン */
export type TranscribeEngine = 'gemini' | 'openai' | 'webspeech'

/**
 * 書き起こしを整えるエンジン。
 * rules = APIキー不要のルールベース簡易整形、none = 整形せず書き起こしのまま。
 */
export type PolishEngine = 'gemini' | 'openai' | 'anthropic' | 'rules' | 'none'

export type ProviderId = 'gemini' | 'openai' | 'anthropic'

export interface ApiKeys {
  gemini: string
  openai: string
  anthropic: string
}

/** 整形モード。built-in は id が固定、ユーザー定義は uuid。 */
export interface Mode {
  id: string
  name: string
  /** UI 上のアイコン代わりの絵文字 */
  emoji: string
  /** システムプロンプトに追記される、このモード固有の指示 */
  instruction: string
  /** ユーザーが作ったモードか */
  custom?: boolean
}

export interface DictionaryEntry {
  /** 正しい表記（必須） */
  term: string
  /** 誤変換されやすい表記。カンマ区切りで複数可（任意） */
  wrong?: string
  /** 読み・補足（任意） */
  note?: string
}

export interface Settings {
  apiKeys: ApiKeys
  transcribeEngine: TranscribeEngine
  polishEngine: PolishEngine
  models: {
    geminiTranscribe: string
    geminiPolish: string
    openaiTranscribe: string
    openaiPolish: string
    anthropicPolish: string
  }
  /** 話す言語。'auto' は自動判定 */
  spokenLang: string
  /** 現在選択中の整形モード id */
  activeModeId: string
  /** ユーザー定義モード */
  customModes: Mode[]
  dictionary: DictionaryEntry[]
  /** 「ジェミニ→Gemini」のような、よくある製品名の組み込み辞書を使う */
  useBuiltinTerms: boolean
  /** 自分の文体サンプル。整形時に文体の参考として渡す */
  styleSample: string
  /** 録音を止めたら自動で整形まで走らせる */
  autoProcess: boolean
  /** 既に結果があるとき、次の録音を置き換えずに末尾へ足す */
  appendMode: boolean
  /** 結果が出たら自動でクリップボードにコピー */
  autoCopy: boolean
  /** 無音が続いたら自動で録音停止（秒。0 で無効） */
  silenceStopSec: number
  /** 履歴を保存する */
  saveHistory: boolean
  theme: 'dark' | 'light' | 'system'
  /** オンボーディングを完了したか */
  onboarded: boolean
}

export interface HistoryItem {
  id: string
  createdAt: number
  /** 書き起こし（生） */
  raw: string
  /** 整形後 */
  polished: string
  modeId: string
  modeName: string
  durationMs: number
  engine: string
  /** 概算コスト（USD）。不明なら undefined */
  costUsd?: number
}

export interface TranscribeResult {
  raw: string
  /** gemini の一発モードでは整形結果も同時に返る */
  polished?: string
  engine: string
  costUsd?: number
}

export class ApiError extends Error {
  readonly provider: ProviderId | 'webspeech'
  readonly status?: number
  readonly hint?: string

  // パラメータプロパティ構文は使わない。テストを Node の型ストリップで
  // 直接動かしているが、あの構文は対応していないため。
  constructor(message: string, provider: ProviderId | 'webspeech', status?: number, hint?: string) {
    super(message)
    this.name = 'ApiError'
    this.provider = provider
    this.status = status
    this.hint = hint
  }
}
