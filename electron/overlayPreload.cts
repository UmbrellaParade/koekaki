import { contextBridge, ipcRenderer } from 'electron'

type VoiceBarPhase = 'starting' | 'recording' | 'transcribing' | 'polishing'

const phaseChannel = 'koekaki:voicebar-phase'
const allowedPhases = new Set<VoiceBarPhase>(['starting', 'recording', 'transcribing', 'polishing'])
const subscribers = new Set<(phase: VoiceBarPhase) => void>()
let latestPhase: VoiceBarPhase | null = null

function parsePhase(value: unknown): VoiceBarPhase | null {
  return typeof value === 'string' && allowedPhases.has(value as VoiceBarPhase)
    ? (value as VoiceBarPhase)
    : null
}

ipcRenderer.on(phaseChannel, (_event, value: unknown) => {
  const phase = parsePhase(value)
  if (!phase) return
  latestPhase = phase
  for (const subscriber of subscribers) subscriber(phase)
})

contextBridge.exposeInMainWorld('koekakiVoiceBar', {
  onPhase(callback: (phase: VoiceBarPhase) => void): () => void {
    if (typeof callback !== 'function') return () => undefined
    subscribers.add(callback)
    if (latestPhase) callback(latestPhase)
    return () => subscribers.delete(callback)
  },
})
