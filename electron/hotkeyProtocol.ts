export type HotkeyMessage =
  | { type: 'ready' }
  | { type: 'right-alt'; target?: PasteTarget }
  | { type: 'self-test-ok' }
  | { type: 'unknown'; line: string }

export interface PasteTarget {
  /** Canonical decimal HWND. Keep as a string to avoid precision loss. */
  windowHandle: string
  processId: number
  threadId: number
}

export type PasteStatus =
  | { type: 'ok-restored' }
  | { type: 'ok-not-restored' }
  | {
      type: 'skipped'
      reason:
        | 'invalid-window'
        | 'target-changed'
        | 'identity-changed'
        | 'self-process'
        | 'modifier-down'
        | 'clipboard-changed'
        | 'clipboard-failed'
    }
  | { type: 'send-failed' }
  | { type: 'self-test-ok' }

const MAX_INT64 = 9_223_372_036_854_775_807n
const MAX_UINT32 = 4_294_967_295

function parseCanonicalUint32(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,9})$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= MAX_UINT32 ? parsed : null
}

function parseTarget(line: string): PasteTarget | 'no-target' | null {
  const match = /^RIGHT_ALT (0|[1-9]\d{0,18}) (0|[1-9]\d{0,9}) (0|[1-9]\d{0,9})$/.exec(line)
  if (!match) return null
  const [, rawHandle, rawProcessId, rawThreadId] = match
  const processId = parseCanonicalUint32(rawProcessId)
  const threadId = parseCanonicalUint32(rawThreadId)
  if (processId === null || threadId === null) return null

  if (rawHandle === '0' && processId === 0 && threadId === 0) return 'no-target'
  if (rawHandle === '0' || processId === 0 || threadId === 0) return null
  if (BigInt(rawHandle) > MAX_INT64) return null
  return { windowHandle: rawHandle, processId, threadId }
}

export function parseHotkeyLine(rawLine: string): HotkeyMessage | null {
  const line = rawLine.trim()
  if (!line) return null
  if (line === 'READY') return { type: 'ready' }
  if (line === 'RIGHT_ALT') return { type: 'right-alt' }
  if (line.startsWith('RIGHT_ALT ')) {
    const target = parseTarget(line)
    if (target === 'no-target') return { type: 'right-alt' }
    if (target) return { type: 'right-alt', target }
  }
  if (line === 'SELF_TEST_OK') return { type: 'self-test-ok' }
  return { type: 'unknown', line }
}

export function parsePasteStatusLine(rawLine: string): PasteStatus | null {
  const line = rawLine
  if (line === 'PASTE_OK_RESTORED') return { type: 'ok-restored' }
  if (line === 'PASTE_OK_NOT_RESTORED') return { type: 'ok-not-restored' }
  if (line === 'PASTE_SKIPPED_INVALID_WINDOW') return { type: 'skipped', reason: 'invalid-window' }
  if (line === 'PASTE_SKIPPED_TARGET') return { type: 'skipped', reason: 'target-changed' }
  if (line === 'PASTE_SKIPPED_IDENTITY') return { type: 'skipped', reason: 'identity-changed' }
  if (line === 'PASTE_SKIPPED_SELF') return { type: 'skipped', reason: 'self-process' }
  if (line === 'PASTE_SKIPPED_MODIFIER') return { type: 'skipped', reason: 'modifier-down' }
  if (line === 'PASTE_SKIPPED_CLIPBOARD_CHANGED') return { type: 'skipped', reason: 'clipboard-changed' }
  if (line === 'PASTE_CLIPBOARD_FAILED') return { type: 'skipped', reason: 'clipboard-failed' }
  if (line === 'PASTE_SELF_TEST_OK') return { type: 'self-test-ok' }

  if (line === 'PASTE_SEND_FAILED') return { type: 'send-failed' }
  return null
}

export class LineBuffer {
  private pending = ''

  push(chunk: string): string[] {
    const source = this.pending + chunk
    const lines: string[] = []
    let start = 0

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index]
      if (char === '\n') {
        lines.push(source.slice(start, index))
        start = index + 1
        continue
      }
      if (char !== '\r') continue
      if (index + 1 >= source.length) break

      lines.push(source.slice(start, index))
      if (source[index + 1] === '\n') index += 1
      start = index + 1
    }

    this.pending = source.slice(start)
    return lines
  }

  flush(): string[] {
    const remainder = this.pending
    this.pending = ''
    if (!remainder) return []
    return [remainder.endsWith('\r') ? remainder.slice(0, -1) : remainder]
  }
}
