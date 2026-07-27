import { ApiError } from '../types'

const BASE = 'https://api.openai.com/v1'

export interface OpenAiUsage {
  promptTokens: number
  outputTokens: number
  audioSeconds?: number
}

function hint(status: number): string | undefined {
  if (status === 401) return 'API キーが無効です。設定画面で確認してください。'
  if (status === 403) return 'このキーではこのモデルを使えません。組織の設定を確認してください。'
  if (status === 404) return 'モデル名が存在しません。設定画面でモデルを確認してください。'
  if (status === 429) return 'レート制限、または残高不足です。OpenAI のダッシュボードで請求設定を確認してください。'
  if (status >= 500) return 'OpenAI 側の一時的な障害です。少し待って再試行してください。'
  return undefined
}

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  return data?.error?.message ?? `OpenAI エラー (HTTP ${res.status})`
}

/** 音声 → 書き起こし。webm / mp4 をそのまま送れる。 */
export async function openaiTranscribe(
  apiKey: string,
  model: string,
  audio: Blob,
  opts: { language?: string; prompt?: string } = {},
): Promise<{ raw: string; usage: OpenAiUsage }> {
  if (!apiKey) {
    throw new ApiError('OpenAI の API キーが設定されていません', 'openai', undefined, '設定画面から API キーを登録してください。')
  }

  const ext = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : audio.type.includes('wav') ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', audio, `audio.${ext}`)
  form.append('model', model)
  form.append('response_format', 'json')
  if (opts.language && opts.language !== 'auto') form.append('language', opts.language)
  if (opts.prompt) form.append('prompt', opts.prompt)

  let res: Response
  try {
    res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
  } catch {
    throw new ApiError('OpenAI に接続できませんでした', 'openai', undefined, 'ネットワーク接続を確認してください。')
  }

  if (!res.ok) throw new ApiError(await readError(res), 'openai', res.status, hint(res.status))

  const data = (await res.json()) as { text?: string; usage?: { seconds?: number } }
  return {
    raw: (data.text ?? '').trim(),
    usage: { promptTokens: 0, outputTokens: 0, audioSeconds: data.usage?.seconds },
  }
}

/**
 * このキーで使えるモデルを取得する。
 * kind で「音声書き起こし向け」「テキスト整形向け」に絞る。
 */
export async function openaiListModels(apiKey: string, kind: 'audio' | 'text'): Promise<string[]> {
  if (!apiKey) throw new ApiError('OpenAI の API キーが設定されていません', 'openai')

  let res: Response
  try {
    res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
  } catch {
    throw new ApiError('OpenAI に接続できませんでした', 'openai', undefined, 'ネットワーク接続を確認してください。')
  }
  if (!res.ok) throw new ApiError(await readError(res), 'openai', res.status, hint(res.status))

  const data = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean)

  if (kind === 'audio') {
    return ids.filter((id) => /whisper|transcribe/.test(id)).sort()
  }
  return ids
    .filter((id) => /^(gpt|o[0-9]|chatgpt)/.test(id))
    .filter((id) => !/audio|realtime|transcribe|tts|search|image|moderation|embedding|instruct|dall/.test(id))
    .sort()
}

/** テキスト整形 */
export async function openaiPolish(
  apiKey: string,
  model: string,
  systemPrompt: string,
  rawText: string,
): Promise<{ polished: string; usage: OpenAiUsage }> {
  if (!apiKey) {
    throw new ApiError('OpenAI の API キーが設定されていません', 'openai', undefined, '設定画面から API キーを登録してください。')
  }

  let res: Response
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `# 書き起こし\n${rawText}` },
        ],
      }),
    })
  } catch {
    throw new ApiError('OpenAI に接続できませんでした', 'openai', undefined, 'ネットワーク接続を確認してください。')
  }

  if (!res.ok) throw new ApiError(await readError(res), 'openai', res.status, hint(res.status))

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  return {
    polished: (data.choices?.[0]?.message?.content ?? '').trim(),
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  }
}
