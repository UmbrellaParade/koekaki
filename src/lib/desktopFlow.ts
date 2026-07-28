export type DesktopCommand = {
  requestId: string
  action: 'start' | 'stop'
}

export type DesktopFlowPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'polishing'

export type DesktopCommandDecision = 'start' | 'stop' | 'ignore'

/**
 * Electron から届いた指示を、現在の録音セッションに対して実行してよいか決める。
 * requestId が違う停止指示や、処理中の連打はここで捨てる。
 */
export function decideDesktopCommand(
  phase: DesktopFlowPhase,
  activeRequestId: string | null,
  command: DesktopCommand,
): DesktopCommandDecision {
  if (!command.requestId) return 'ignore'

  if (command.action === 'start') {
    return phase === 'idle' && activeRequestId === null ? 'start' : 'ignore'
  }

  return phase === 'recording' && activeRequestId === command.requestId ? 'stop' : 'ignore'
}

/** トレイ通知に載せても読める長さへ整える。本文やキーは渡さない。 */
export function compactDesktopMessage(value: string | undefined, maxLength = 180): string | undefined {
  if (!value) return undefined
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`
}
