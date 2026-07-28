export type HotkeyMessage =
  | { type: 'ready' }
  | { type: 'right-alt' }
  | { type: 'self-test-ok' }
  | { type: 'unknown'; line: string }

export function parseHotkeyLine(rawLine: string): HotkeyMessage | null {
  const line = rawLine.trim()
  if (!line) return null
  if (line === 'READY') return { type: 'ready' }
  if (line === 'RIGHT_ALT') return { type: 'right-alt' }
  if (line === 'SELF_TEST_OK') return { type: 'self-test-ok' }
  return { type: 'unknown', line }
}

export class LineBuffer {
  private pending = ''

  push(chunk: string): string[] {
    const parts = (this.pending + chunk).split(/\r\n|\r|\n/)
    this.pending = parts.pop() ?? ''
    return parts
  }

  flush(): string[] {
    const remainder = this.pending
    this.pending = ''
    return remainder ? [remainder] : []
  }
}
