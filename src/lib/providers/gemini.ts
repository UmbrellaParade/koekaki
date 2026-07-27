import { blobToBase64, blobToWav16k } from '../audio'
import { ApiError } from '../types'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface GeminiUsage {
  promptTokens: number
  outputTokens: number
  /** 音声の秒数（課金は音声トークン換算だが、UI 表示では秒で持つ） */
  audioSeconds?: number
}

interface GeminiPart {
  text?: string
  inline_data?: { mime_type: string; data: string }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { message?: string; status?: string }
}

async function call(
  apiKey: string,
  model: string,
  systemPrompt: string,
  parts: GeminiPart[],
  opts: { json?: boolean; maxOutputTokens?: number } = {},
): Promise<{ text: string; usage: GeminiUsage }> {
  if (!apiKey) {
    throw new ApiError('Gemini の API キーが設定されていません', 'gemini', undefined, '設定画面から API キーを登録してください。')
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      // 整形タスクに長考は不要。切っておく方が速く安い。
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_NONE' })),
  }

  let res: Response
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Gemini に接続できませんでした', 'gemini', undefined, 'ネットワーク接続を確認してください。')
  }

  const data = (await res.json().catch(() => ({}))) as GeminiResponse

  if (!res.ok) {
    const message = data.error?.message ?? `Gemini エラー (HTTP ${res.status})`
    throw new ApiError(message, 'gemini', res.status, geminiHint(res.status, message))
  }

  if (data.promptFeedback?.blockReason) {
    throw new ApiError(
      `Gemini が応答をブロックしました (${data.promptFeedback.blockReason})`,
      'gemini',
      undefined,
      '別の言い回しで録り直すか、整形エンジンを切り替えてください。',
    )
  }

  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')

  return {
    text,
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  }
}

function geminiHint(status: number, message = ''): string | undefined {
  // 無効なキーでも 400 が返ってくるので、本文を見て案内を分ける
  if (/api key/i.test(message)) return 'API キーが正しくありません。設定画面で貼り直してください。'
  if (status === 400) return 'モデル名が正しいか、設定画面で確認してください。'
  if (status === 401 || status === 403)
    return 'API キーが無効か、Generative Language API が有効になっていません。Google AI Studio でキーを再発行してください。'
  if (status === 429) return '無料枠のレート制限に達しています。少し待つか、有料枠を有効にしてください。'
  if (status >= 500) return 'Google 側の一時的な障害です。少し待って再試行してください。'
  return undefined
}

/** 音声 → {raw, polished} を1回のリクエストで得る（このアプリの標準経路） */
export async function geminiCombined(
  apiKey: string,
  model: string,
  systemPrompt: string,
  audio: Blob,
): Promise<{ raw: string; polished: string; usage: GeminiUsage }> {
  const wav = await blobToWav16k(audio)
  const base64 = await blobToBase64(wav)
  const { text, usage } = await call(
    apiKey,
    model,
    systemPrompt,
    [{ inline_data: { mime_type: 'audio/wav', data: base64 } }],
    { json: true },
  )

  const parsed = parseJsonLoose(text)
  if (parsed && typeof parsed.raw === 'string' && typeof parsed.polished === 'string') {
    return { raw: parsed.raw.trim(), polished: parsed.polished.trim(), usage }
  }
  // JSON で返らなかった場合は、本文をそのまま整形結果として扱う
  const fallback = text.trim()
  return { raw: fallback, polished: fallback, usage }
}

/** 音声 → 書き起こしのみ */
export async function geminiTranscribe(
  apiKey: string,
  model: string,
  prompt: string,
  audio: Blob,
): Promise<{ raw: string; usage: GeminiUsage }> {
  const wav = await blobToWav16k(audio)
  const base64 = await blobToBase64(wav)
  const { text, usage } = await call(apiKey, model, prompt, [
    { inline_data: { mime_type: 'audio/wav', data: base64 } },
  ])
  return { raw: text.trim(), usage }
}

/** テキスト整形のみ */
export async function geminiPolish(
  apiKey: string,
  model: string,
  systemPrompt: string,
  rawText: string,
): Promise<{ polished: string; usage: GeminiUsage }> {
  const { text, usage } = await call(apiKey, model, systemPrompt, [
    { text: `# 書き起こし\n${rawText}` },
  ])
  return { polished: text.trim(), usage }
}

/** モデルが LLM の癖でコードブロックを付けてきても拾えるようにする */
export function parseJsonLoose(text: string): { raw?: unknown; polished?: unknown } | null {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) candidates.push(fence[1])
  const brace = trimmed.match(/\{[\s\S]*\}/)
  if (brace) candidates.push(brace[0])

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object') return parsed as { raw?: unknown; polished?: unknown }
    } catch {
      // 次の候補を試す
    }
  }
  return null
}
