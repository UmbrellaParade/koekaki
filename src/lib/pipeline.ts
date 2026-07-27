import { audioCost, textCost } from './cost'
import {
  buildCombinedSystemPrompt,
  buildPolishSystemPrompt,
  buildTranscribeOnlyPrompt,
  buildTranscriptionHint,
} from './prompts'
import { anthropicPolish } from './providers/anthropic'
import { geminiCombined, geminiPolish, geminiTranscribe } from './providers/gemini'
import { openaiPolish, openaiTranscribe } from './providers/openai'
import { rulePolish, ruleModeSupported } from './rulePolish'
import type { Mode, ProviderId, Settings } from './types'
import { ApiError } from './types'

export interface ProcessInput {
  /** 録音データ。Web Speech API 経路では未使用 */
  audio: Blob | null
  /** Web Speech API で得た書き起こし */
  webSpeechText: string | null
  durationMs: number
  settings: Settings
  mode: Mode
  /** 進捗表示用 */
  onStage?: (stage: 'transcribing' | 'polishing') => void
}

export interface ProcessOutput {
  raw: string
  polished: string
  engine: string
  costUsd: number
}

const ENGINE_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude',
  webspeech: 'ブラウザ内蔵',
  rules: '簡易整形',
  none: '整形なし',
}

/** 録音（または Web Speech の結果）から、書き起こしと整形結果を作る */
export async function processRecording(input: ProcessInput): Promise<ProcessOutput> {
  const { settings, mode } = input
  const skipPolish = mode.id === 'raw' || settings.polishEngine === 'none'
  const dict = settings.dictionary
  let cost = 0

  // ---- Gemini 単独経路: 音声 → {raw, polished} を1リクエストで済ませる ----
  if (
    !skipPolish &&
    settings.transcribeEngine === 'gemini' &&
    settings.polishEngine === 'gemini' &&
    settings.models.geminiTranscribe === settings.models.geminiPolish &&
    input.audio
  ) {
    input.onStage?.('transcribing')
    const system = buildCombinedSystemPrompt(mode, dict, settings.styleSample, settings.spokenLang)
    const { raw, polished, usage } = await geminiCombined(
      settings.apiKeys.gemini,
      settings.models.geminiTranscribe,
      system,
      input.audio,
    )
    cost = textCost(settings.models.geminiTranscribe, usage.promptTokens, usage.outputTokens)
    return { raw, polished: polished || raw, engine: 'Gemini（音声→整形 一括）', costUsd: cost }
  }

  // ---- 1. 書き起こし ----
  input.onStage?.('transcribing')
  let raw = ''
  let transcribeLabel = ''

  if (settings.transcribeEngine === 'webspeech') {
    raw = (input.webSpeechText ?? '').trim()
    transcribeLabel = ENGINE_LABEL.webspeech
  } else if (settings.transcribeEngine === 'gemini') {
    if (!input.audio) throw new ApiError('録音データがありません', 'gemini')
    const prompt = buildTranscribeOnlyPrompt(dict, settings.spokenLang)
    const res = await geminiTranscribe(settings.apiKeys.gemini, settings.models.geminiTranscribe, prompt, input.audio)
    raw = res.raw
    cost += textCost(settings.models.geminiTranscribe, res.usage.promptTokens, res.usage.outputTokens)
    transcribeLabel = ENGINE_LABEL.gemini
  } else {
    if (!input.audio) throw new ApiError('録音データがありません', 'openai')
    const res = await openaiTranscribe(settings.apiKeys.openai, settings.models.openaiTranscribe, input.audio, {
      language: settings.spokenLang,
      prompt: buildTranscriptionHint(dict),
    })
    raw = res.raw
    cost += audioCost(settings.models.openaiTranscribe, res.usage.audioSeconds ?? input.durationMs / 1000)
    transcribeLabel = ENGINE_LABEL.openai
  }

  if (!raw) {
    return { raw: '', polished: '', engine: transcribeLabel, costUsd: cost }
  }

  if (skipPolish) {
    return { raw, polished: raw, engine: transcribeLabel, costUsd: cost }
  }

  // ---- 2. 整形 ----
  input.onStage?.('polishing')
  const system = buildPolishSystemPrompt(mode, dict, settings.styleSample)
  let polished = ''
  let polishLabel = ''

  if (settings.polishEngine === 'rules') {
    // キーも通信も使わない経路。ここだけは必ずローカルで完結する。
    polished = rulePolish(raw, mode)
    polishLabel = ruleModeSupported(mode.id) ? ENGINE_LABEL.rules : `${ENGINE_LABEL.rules}（モード未対応）`
  } else if (settings.polishEngine === 'gemini') {
    const res = await geminiPolish(settings.apiKeys.gemini, settings.models.geminiPolish, system, raw)
    polished = res.polished
    cost += textCost(settings.models.geminiPolish, res.usage.promptTokens, res.usage.outputTokens)
    polishLabel = ENGINE_LABEL.gemini
  } else if (settings.polishEngine === 'openai') {
    const res = await openaiPolish(settings.apiKeys.openai, settings.models.openaiPolish, system, raw)
    polished = res.polished
    cost += textCost(settings.models.openaiPolish, res.usage.promptTokens, res.usage.outputTokens)
    polishLabel = ENGINE_LABEL.openai
  } else {
    const res = await anthropicPolish(settings.apiKeys.anthropic, settings.models.anthropicPolish, system, raw)
    polished = res.polished
    cost += textCost(settings.models.anthropicPolish, res.usage.promptTokens, res.usage.outputTokens)
    polishLabel = ENGINE_LABEL.anthropic
  }

  return {
    raw,
    polished: polished || raw,
    engine: `${transcribeLabel} → ${polishLabel}`,
    costUsd: cost,
  }
}

/**
 * API キーが実際に通るかを、最小のリクエストで確かめる。
 * 録音してから初めて失敗に気づく、という体験を避けるためのもの。
 */
export async function testProviderKey(provider: ProviderId, settings: Settings): Promise<void> {
  const system = '次の入力をそのまま繰り返してください。他には何も言わないこと。'
  const probe = 'ok'

  if (provider === 'gemini') {
    await geminiPolish(settings.apiKeys.gemini, settings.models.geminiPolish, system, probe)
  } else if (provider === 'openai') {
    await openaiPolish(settings.apiKeys.openai, settings.models.openaiPolish, system, probe)
  } else {
    await anthropicPolish(settings.apiKeys.anthropic, settings.models.anthropicPolish, system, probe)
  }
}
