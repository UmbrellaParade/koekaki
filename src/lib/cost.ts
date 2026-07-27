/**
 * 概算コスト計算。
 *
 * 各社の料金は変わるので、ここの数値だけ直せば全画面の表示が追従する。
 * 単位: USD / 100万トークン（音声モデルのみ USD / 分）。
 * あくまで「だいたいこのくらい」を示すためのもので、請求額そのものではない。
 */

export interface TokenPrice {
  input: number
  output: number
  /** 音声入力の 100万トークンあたり単価（Gemini など） */
  audioInput?: number
}

export const TEXT_PRICES: Record<string, TokenPrice> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5, audioInput: 1.0 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, audioInput: 0.3 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0, audioInput: 1.25 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, audioInput: 0.7 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-opus-5': { input: 15.0, output: 75.0 },
}

/** USD / 分 */
export const AUDIO_PRICES: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'whisper-1': 0.006,
}

export function textCost(model: string, promptTokens: number, outputTokens: number): number {
  const p = TEXT_PRICES[model]
  if (!p) return 0
  return (promptTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
}

export function audioCost(model: string, seconds: number): number {
  const perMin = AUDIO_PRICES[model]
  if (!perMin) return 0
  return (seconds / 60) * perMin
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '—'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}
