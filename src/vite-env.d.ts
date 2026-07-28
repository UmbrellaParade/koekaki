/// <reference types="vite/client" />

/** ビルド日時。vite.config.ts の define で埋め込む。 */
declare const __BUILD_ID__: string

/** Electron renderer 用のビルドか。Web/PWA では false。 */
declare const __DESKTOP__: boolean

interface KoekakiDesktopApiKeys {
  gemini: string
  openai: string
  anthropic: string
}

type KoekakiDesktopPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'polishing'
  | 'error'

interface KoekakiDesktopBridge {
  readonly isDesktop: true
  onCommand(callback: (command: { requestId: string; action: 'start' | 'stop' }) => void): () => void
  onOpenSettings(callback: () => void): () => void
  requestOpenSettings(): void
  reportReady(state: { onboarded: boolean }): void
  reportState(state: { phase: KoekakiDesktopPhase; requestId?: string }): void
  reportError(error: { message: string; hint?: string; requestId?: string }): void
  completeDictation(result: { requestId: string; text: string }): Promise<void>
  writeClipboard(text: string): Promise<void>
  loadApiKeys(): Promise<KoekakiDesktopApiKeys>
  saveApiKeys(keys: KoekakiDesktopApiKeys): Promise<void>
}

type KoekakiVoiceBarPhase = 'starting' | 'recording' | 'transcribing' | 'polishing'

interface KoekakiVoiceBarBridge {
  onPhase(callback: (phase: KoekakiVoiceBarPhase) => void): () => void
}

interface Window {
  readonly koekakiDesktop?: KoekakiDesktopBridge
  readonly koekakiVoiceBar?: KoekakiVoiceBarBridge
}
