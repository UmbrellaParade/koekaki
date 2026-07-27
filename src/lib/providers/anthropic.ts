import { ApiError } from '../types'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export interface AnthropicUsage {
  promptTokens: number
  outputTokens: number
}

function hint(status: number): string | undefined {
  if (status === 401) return 'API キーが無効です。設定画面で確認してください。'
  if (status === 400) return 'モデル名が正しいか確認してください。'
  if (status === 429) return 'レート制限に達しています。少し待って再試行してください。'
  if (status >= 500) return 'Anthropic 側の一時的な障害です。少し待って再試行してください。'
  return undefined
}

/**
 * Claude は音声入力を受け付けないため、整形フェーズ専用。
 * ブラウザから直接叩くには anthropic-dangerous-direct-browser-access が必要。
 */
export async function anthropicPolish(
  apiKey: string,
  model: string,
  systemPrompt: string,
  rawText: string,
): Promise<{ polished: string; usage: AnthropicUsage }> {
  if (!apiKey) {
    throw new ApiError(
      'Anthropic の API キーが設定されていません',
      'anthropic',
      undefined,
      '設定画面から API キーを登録してください。',
    )
  }

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: `# 書き起こし\n${rawText}` }],
      }),
    })
  } catch {
    throw new ApiError('Anthropic に接続できませんでした', 'anthropic', undefined, 'ネットワーク接続を確認してください。')
  }

  const data = (await res.json().catch(() => ({}))) as {
    content?: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
    error?: { message?: string }
  }

  if (!res.ok) {
    throw new ApiError(data.error?.message ?? `Anthropic エラー (HTTP ${res.status})`, 'anthropic', res.status, hint(res.status))
  }

  const polished = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()

  return {
    polished,
    usage: {
      promptTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  }
}
