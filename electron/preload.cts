import { contextBridge, ipcRenderer } from 'electron'

type Command = { requestId: string; action: 'start' | 'stop' }
type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'polishing' | 'error'
type ApiKeys = { gemini: string; openai: string; anthropic: string }

const channels = {
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

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseCommand(value: unknown): Command | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Object.keys(record).every((key) => key === 'requestId' || key === 'action')) return null
  if (typeof record.requestId !== 'string' || !requestIdPattern.test(record.requestId)) return null
  if (record.action !== 'start' && record.action !== 'stop') return null
  return { requestId: record.requestId, action: record.action }
}

function onCommand(callback: (command: Command) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
    const command = parseCommand(value)
    if (command) callback(command)
  }
  ipcRenderer.on(channels.command, listener)
  return () => ipcRenderer.removeListener(channels.command, listener)
}

function onOpenSettings(callback: () => void): () => void {
  const listener = () => callback()
  ipcRenderer.on(channels.openSettings, listener)
  return () => ipcRenderer.removeListener(channels.openSettings, listener)
}

contextBridge.exposeInMainWorld('koekakiDesktop', {
  isDesktop: true,
  onCommand,
  onOpenSettings,
  requestOpenSettings: () => ipcRenderer.send(channels.requestOpenSettings),
  reportReady: (payload: { onboarded: boolean }) => ipcRenderer.send(channels.ready, payload),
  reportState: (payload: { phase: Phase; requestId?: string }) => ipcRenderer.send(channels.state, payload),
  reportError: (payload: { message: string; hint?: string; requestId?: string }) =>
    ipcRenderer.send(channels.error, payload),
  completeDictation: (payload: { requestId: string; text: string }): Promise<void> =>
    ipcRenderer.invoke(channels.completeDictation, payload),
  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke(channels.writeClipboard, text),
  loadApiKeys: (): Promise<ApiKeys> => ipcRenderer.invoke(channels.loadApiKeys),
  saveApiKeys: (keys: ApiKeys): Promise<void> => ipcRenderer.invoke(channels.saveApiKeys, keys),
})
