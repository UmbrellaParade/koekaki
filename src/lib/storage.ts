import type { Settings } from './types'

const KEY = 'koekaki.settings.v1'

export const DEFAULT_SETTINGS: Settings = {
  apiKeys: { gemini: '', openai: '', anthropic: '' },
  transcribeEngine: 'gemini',
  polishEngine: 'gemini',
  models: {
    geminiTranscribe: 'gemini-2.5-flash',
    geminiPolish: 'gemini-2.5-flash',
    openaiTranscribe: 'gpt-4o-mini-transcribe',
    openaiPolish: 'gpt-4.1-mini',
    anthropicPolish: 'claude-haiku-4-5-20251001',
  },
  spokenLang: 'ja',
  activeModeId: 'standard',
  customModes: [],
  dictionary: [],
  styleSample: '',
  autoProcess: true,
  autoCopy: false,
  silenceStopSec: 0,
  saveHistory: true,
  theme: 'system',
  onboarded: false,
}

/** localStorage から読む。壊れていても既定値で復帰する。 */
export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(KEY)
    if (!stored) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(stored) as Partial<Settings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(parsed.apiKeys ?? {}) },
      models: { ...DEFAULT_SETTINGS.models, ...(parsed.models ?? {}) },
      customModes: Array.isArray(parsed.customModes) ? parsed.customModes : [],
      dictionary: Array.isArray(parsed.dictionary) ? parsed.dictionary : [],
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // 容量超過などは致命的ではないので握りつぶす
  }
}

/** API キーを含まない設定をエクスポートする（設定の持ち運び用） */
export function exportSettings(settings: Settings): string {
  const { apiKeys: _apiKeys, ...rest } = settings
  return JSON.stringify(rest, null, 2)
}

export function importSettings(json: string, current: Settings): Settings {
  const parsed = JSON.parse(json) as Partial<Settings>
  return {
    ...current,
    ...parsed,
    // キーはインポート対象外。既存のものを保持する。
    apiKeys: current.apiKeys,
    models: { ...current.models, ...(parsed.models ?? {}) },
    customModes: Array.isArray(parsed.customModes) ? parsed.customModes : current.customModes,
    dictionary: Array.isArray(parsed.dictionary) ? parsed.dictionary : current.dictionary,
  }
}
