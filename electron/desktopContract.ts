import path from 'node:path'

export const DESKTOP_SCHEME = 'koekaki'
export const DESKTOP_HOST = 'app'
export const DESKTOP_PARTITION = 'persist:koekaki'
export const DESKTOP_APP_URL = `${DESKTOP_SCHEME}://${DESKTOP_HOST}/index.html`
export const VOICE_BAR_PARTITION = 'koekaki:voicebar'
export const VOICE_BAR_APP_URL = `${DESKTOP_APP_URL}?surface=voicebar`
export const VOICE_BAR_PHASE_CHANNEL = 'koekaki:voicebar-phase'

export const DESKTOP_CHANNELS = {
  command: 'koekaki:desktop-command',
  openSettings: 'koekaki:open-settings',
  requestOpenSettings: 'koekaki:request-open-settings',
  ready: 'koekaki:renderer-ready',
  state: 'koekaki:renderer-state',
  error: 'koekaki:renderer-error',
  completeDictation: 'koekaki:complete-dictation',
  writeClipboard: 'koekaki:write-clipboard',
  loadApiKeys: 'koekaki:load-api-keys',
  saveApiKeys: 'koekaki:save-api-keys',
} as const

export type DesktopPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'polishing' | 'error'
export type VoiceBarPhase = Extract<DesktopPhase, 'starting' | 'recording' | 'transcribing' | 'polishing'>

export interface DesktopReadyPayload {
  onboarded: boolean
}

export interface DesktopStatePayload {
  phase: DesktopPhase
  requestId?: string
}

export interface DesktopErrorPayload {
  message: string
  hint?: string
  requestId?: string
}

export interface DesktopDictationPayload {
  requestId: string
  text: string
}

export interface DesktopApiKeys {
  gemini: string
  openai: string
  anthropic: string
}

const ALLOWED_EXTERNAL_ORIGINS = new Set([
  'https://aistudio.google.com',
  'https://platform.openai.com',
  'https://console.anthropic.com',
])

const PHASES = new Set<DesktopPhase>([
  'idle',
  'starting',
  'recording',
  'transcribing',
  'polishing',
  'error',
])
const VOICE_BAR_PHASES = new Set<VoiceBarPhase>(['starting', 'recording', 'transcribing', 'polishing'])

const MAX_CLIPBOARD_CHARS = 1_000_000
const MAX_KEY_CHARS = 4_096
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
}

export function parseReadyPayload(value: unknown): DesktopReadyPayload | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['onboarded'])) return null
  return typeof value.onboarded === 'boolean' ? { onboarded: value.onboarded } : null
}

export function parseStatePayload(value: unknown): DesktopStatePayload | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['phase', 'requestId'])) return null
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase as DesktopPhase)) return null
  if (value.requestId !== undefined && !isRequestId(value.requestId)) return null
  return {
    phase: value.phase as DesktopPhase,
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  }
}

export function isVoiceBarPhase(value: unknown): value is VoiceBarPhase {
  return typeof value === 'string' && VOICE_BAR_PHASES.has(value as VoiceBarPhase)
}

export function resolveVoiceBarPhase(phase: DesktopPhase, hasActiveRequest: boolean): VoiceBarPhase | null {
  if (isVoiceBarPhase(phase)) return phase
  return phase === 'idle' && hasActiveRequest ? 'starting' : null
}

export function parseErrorPayload(value: unknown): DesktopErrorPayload | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['message', 'hint', 'requestId'])) return null
  if (typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 240) return null
  if (value.hint !== undefined && (typeof value.hint !== 'string' || value.hint.length > 500)) return null
  if (value.requestId !== undefined && !isRequestId(value.requestId)) return null
  return {
    message: value.message,
    ...(value.hint === undefined ? {} : { hint: value.hint }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  }
}

export function parseClipboardText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CLIPBOARD_CHARS) return null
  return value
}

export function parseDictationPayload(value: unknown): DesktopDictationPayload | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'text'])) return null
  if (!isRequestId(value.requestId)) return null
  const text = parseClipboardText(value.text)
  return text === null ? null : { requestId: value.requestId, text }
}

export function parseApiKeys(value: unknown): DesktopApiKeys | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['gemini', 'openai', 'anthropic'])) return null
  const keys = ['gemini', 'openai', 'anthropic'] as const
  for (const key of keys) {
    const item = value[key]
    if (typeof item !== 'string' || item.length > MAX_KEY_CHARS || item.includes('\0')) return null
  }
  return {
    gemini: value.gemini as string,
    openai: value.openai as string,
    anthropic: value.anthropic as string,
  }
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      ALLOWED_EXTERNAL_ORIGINS.has(url.origin)
    )
  } catch {
    return false
  }
}

export function isTrustedRendererUrl(rawUrl: string, developmentUrl?: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (
      url.protocol === `${DESKTOP_SCHEME}:` &&
      url.hostname === DESKTOP_HOST &&
      !url.username &&
      !url.password &&
      !url.port
    ) {
      return true
    }

    if (!developmentUrl) return false
    const allowed = new URL(developmentUrl)
    return (
      (allowed.hostname === '127.0.0.1' || allowed.hostname === 'localhost') &&
      allowed.protocol === 'http:' &&
      url.origin === allowed.origin
    )
  } catch {
    return false
  }
}

export function isTrustedVoiceBarRendererUrl(rawUrl: string, developmentUrl?: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  const hasVoiceBarSurface =
    !url.username &&
    !url.password &&
    !url.hash &&
    url.searchParams.get('surface') === 'voicebar' &&
    [...url.searchParams.keys()].length === 1
  if (!hasVoiceBarSurface) return false

  if (
    url.protocol === `${DESKTOP_SCHEME}:` &&
    url.hostname === DESKTOP_HOST &&
    !url.port &&
    url.pathname === '/index.html'
  ) {
    return true
  }

  if (!developmentUrl) return false
  try {
    const allowed = new URL(developmentUrl)
    return (
      (allowed.hostname === '127.0.0.1' || allowed.hostname === 'localhost') &&
      allowed.protocol === 'http:' &&
      url.origin === allowed.origin &&
      url.pathname === '/'
    )
  } catch {
    return false
  }
}

export function resolveDesktopAssetPath(requestUrl: string, rendererRoot: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }

  if (
    url.protocol !== `${DESKTOP_SCHEME}:` ||
    url.hostname !== DESKTOP_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null

  const relativeRequest = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
  if (!relativeRequest || relativeRequest.endsWith('/')) return null

  const absoluteRoot = path.resolve(rendererRoot)
  const absoluteTarget = path.resolve(absoluteRoot, relativeRequest)
  const relativeTarget = path.relative(absoluteRoot, absoluteTarget)
  if (
    !relativeTarget ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    relativeTarget === '..' ||
    path.isAbsolute(relativeTarget)
  ) {
    return null
  }
  return absoluteTarget
}
