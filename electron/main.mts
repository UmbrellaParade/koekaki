import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MediaAccessPermissionRequest,
} from 'electron'
import {
  createDesktopProtocolHandler,
  DESKTOP_APP_URL,
  DESKTOP_CHANNELS,
  DESKTOP_PARTITION,
  DESKTOP_SCHEME,
  isTrustedVoiceBarRendererUrl,
  isVoiceBarPhase,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  parseApiKeys,
  parseClipboardText,
  parseDictationPayload,
  parseErrorPayload,
  parseReadyPayload,
  parseStatePayload,
  registerDesktopScheme,
  resolveVoiceBarPhase,
  resolveDesktopAssetPath,
  VOICE_BAR_APP_URL,
  VOICE_BAR_PARTITION,
  VOICE_BAR_PHASE_CHANNEL,
  type DesktopApiKeys,
  type DesktopPhase,
  type VoiceBarPhase,
} from './desktopProtocol.js'
import {
  LineBuffer,
  parseHotkeyLine,
  parsePasteStatusLine,
  type PasteStatus,
  type PasteTarget,
} from './hotkeyProtocol.js'

type PasteHelperRun =
  | { kind: 'status'; status: PasteStatus }
  | { kind: 'not-started' }
  | { kind: 'ambiguous' }

const HOTKEY_READY_TIMEOUT_MS = 8_000
const HOTKEY_SELF_TEST_TIMEOUT_MS = 12_000
const DESKTOP_SELF_TEST_TIMEOUT_MS = 20_000
const PASTE_HELPER_TIMEOUT_MS = 12_000
const VOICE_BAR_WIDTH = 420
const VOICE_BAR_HEIGHT = 92
const VOICE_BAR_BOTTOM_MARGIN = 24
const VOICE_BAR_RECOVERY_DELAYS_MS = [250, 1_000, 3_000] as const
const DEVELOPMENT_URLS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])
const EMPTY_API_KEYS: DesktopApiKeys = { gemini: '', openai: '', anthropic: '' }
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

const isHotkeySelfTest = process.argv.includes('--hotkey-self-test')
const isDesktopShellSelfTest = process.argv.includes('--desktop-shell-self-test')
const isAnySelfTest = isHotkeySelfTest || isDesktopShellSelfTest

let tray: Tray | null = null
let controllerWindow: BrowserWindow | null = null
let voiceBarWindow: BrowserWindow | null = null
let voiceBarReady = false
let voiceBarShowVersion = 0
let voiceBarRecoveryAttempts = 0
let voiceBarRecoveryTimer: NodeJS.Timeout | null = null
let hookProcess: ChildProcess | null = null
let hookReady = false
let hookPaused = false
let hookExpectedExit = false
let hookTransitioning = false
let hookError = ''
let rendererReady = false
let rendererPhase: DesktopPhase = 'idle'
let rendererIssue = ''
let currentRequestId: string | null = null
let currentPasteTarget: PasteTarget | null = null
let stopRequested = false
let lastDelivery: 'none' | 'pasted' | 'copied' | 'cancelled' = 'none'
let toggleCount = 0
let hotkeyReadyTimer: NodeJS.Timeout | null = null
let selfTestTimer: NodeJS.Timeout | null = null
let selfTestSawReady = false
let selfTestToggleCount = 0
let selfTestProtocolPassed = false
let selfTestFinished = false
let quitting = false
let apiKeySaveTail: Promise<void> = Promise.resolve()
let deliveryTail: Promise<void> = Promise.resolve()
const deliveryPromises = new Map<string, Promise<void>>()
const deliveryOrder: string[] = []
const activePasteProcesses = new Set<ChildProcess>()

registerDesktopScheme()
app.enableSandbox()

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is not defined')
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function hotkeyScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'hotkey.ps1')
    : path.join(app.getAppPath(), 'electron', 'hotkey.ps1')
}

function rendererRootPath(): string {
  return path.join(app.getAppPath(), 'dist-desktop')
}

function preloadPath(): string {
  return path.join(currentDirectory, 'preload.cjs')
}

function overlayPreloadPath(): string {
  return path.join(currentDirectory, 'overlayPreload.cjs')
}

function apiKeyFilePath(): string {
  return path.join(app.getPath('userData'), 'api-keys.bin')
}

function developmentUrl(): string | undefined {
  if (app.isPackaged) return undefined
  const raw = process.env.KOEKAKI_DESKTOP_DEV_URL
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    const origin = url.origin
    if (url.pathname !== '/' || url.search || url.hash || !DEVELOPMENT_URLS.has(origin)) return undefined
    return origin
  } catch {
    return undefined
  }
}

function voiceBarRendererUrl(): string {
  const devUrl = developmentUrl()
  return devUrl ? `${devUrl}/?surface=voicebar` : VOICE_BAR_APP_URL
}

function positionVoiceBar(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  win.setBounds({
    x: Math.round(x + (width - VOICE_BAR_WIDTH) / 2),
    y: y + height - VOICE_BAR_HEIGHT - VOICE_BAR_BOTTOM_MARGIN,
    width: VOICE_BAR_WIDTH,
    height: VOICE_BAR_HEIGHT,
  })
}

function syncVoiceBar(): void {
  const win = voiceBarWindow
  if (!win || win.isDestroyed()) return
  const showVersion = ++voiceBarShowVersion
  const voiceBarPhase = resolveVoiceBarPhase(rendererPhase, currentRequestId !== null)
  if (!voiceBarReady || !voiceBarPhase) {
    win.hide()
    if (
      !voiceBarReady &&
      voiceBarPhase &&
      !voiceBarRecoveryTimer &&
      voiceBarRecoveryAttempts >= VOICE_BAR_RECOVERY_DELAYS_MS.length
    ) {
      voiceBarRecoveryAttempts = 0
      scheduleVoiceBarRecovery()
    }
    return
  }

  positionVoiceBar(win)
  win.webContents.send(VOICE_BAR_PHASE_CHANNEL, voiceBarPhase)
  if (win.isVisible()) return

  const expectedPhase = JSON.stringify(voiceBarPhase)
  void win.webContents
    .executeJavaScript(`(() => new Promise((resolve) => {
      let framesRemaining = 8
      const check = () => {
        const rendered = document.querySelector('[data-voicebar-phase]')?.getAttribute('data-voicebar-phase')
        if (rendered === ${expectedPhase}) return resolve(true)
        framesRemaining -= 1
        if (framesRemaining <= 0) return resolve(false)
        requestAnimationFrame(check)
      }
      check()
    }))()`)
    .then((painted: unknown) => {
      if (
        painted !== true ||
        showVersion !== voiceBarShowVersion ||
        voiceBarWindow !== win ||
        win.isDestroyed() ||
        resolveVoiceBarPhase(rendererPhase, currentRequestId !== null) !== voiceBarPhase
      ) {
        return
      }
      positionVoiceBar(win)
      win.showInactive()
    })
    .catch(() => undefined)
}

function clearVoiceBarRecoveryTimer(): void {
  if (!voiceBarRecoveryTimer) return
  clearTimeout(voiceBarRecoveryTimer)
  voiceBarRecoveryTimer = null
}

function scheduleVoiceBarRecovery(): void {
  voiceBarReady = false
  voiceBarShowVersion += 1
  const current = voiceBarWindow
  if (current && !current.isDestroyed()) current.hide()
  if (quitting || isAnySelfTest || voiceBarRecoveryTimer) return
  if (voiceBarRecoveryAttempts >= VOICE_BAR_RECOVERY_DELAYS_MS.length) {
    console.error('[voicebar] Recovery attempts were exhausted')
    return
  }

  const delay = VOICE_BAR_RECOVERY_DELAYS_MS[voiceBarRecoveryAttempts]
  voiceBarRecoveryAttempts += 1
  voiceBarRecoveryTimer = setTimeout(() => {
    voiceBarRecoveryTimer = null
    if (quitting) return
    const win = voiceBarWindow
    if (!win || win.isDestroyed()) {
      createVoiceBarWindow()
      return
    }
    void win.loadURL(voiceBarRendererUrl()).catch(() => scheduleVoiceBarRecovery())
  }, delay)
}

function clearHotkeyReadyTimer() {
  if (!hotkeyReadyTimer) return
  clearTimeout(hotkeyReadyTimer)
  hotkeyReadyTimer = null
}

function clearSelfTestTimer() {
  if (!selfTestTimer) return
  clearTimeout(selfTestTimer)
  selfTestTimer = null
}

function phaseLabel(): string {
  if (rendererIssue) return `エラー: ${rendererIssue}`
  if (!rendererReady) return 'コントローラーを準備中'
  if (currentRequestId && rendererPhase === 'idle') return '録音開始を要求中'
  if (rendererPhase === 'starting') return 'マイクを開始中'
  if (rendererPhase === 'recording') return stopRequested ? '録音停止を要求中' : '録音中'
  if (rendererPhase === 'transcribing') return '文字起こし中'
  if (rendererPhase === 'polishing') return '文章を整形中'
  if (rendererPhase === 'error') return '処理エラー'
  if (lastDelivery === 'pasted') return '待機中（入力済み）'
  if (lastDelivery === 'copied') return '待機中（コピー済み）'
  if (lastDelivery === 'cancelled') return '待機中（入力を中止）'
  return '待機中'
}

function trayStatus(): string {
  if (hookTransitioning) return '右 Alt: 切り替え中'
  if (hookPaused) return '右 Alt: 一時停止中'
  if (hookError) return `右 Alt: エラー (${hookError})`
  if (!rendererReady) return `右 Alt: ${phaseLabel()}`
  if (!hookReady) return '右 Alt: 準備中'
  return phaseLabel()
}

function canOpenSettings(): boolean {
  return rendererReady && rendererPhase === 'idle' && currentRequestId === null
}

function updateTrayMenu() {
  if (!tray) return

  tray.setToolTip(`こえかき — ${trayStatus()}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayStatus(), enabled: false },
    { label: `右 Alt 受信回数: ${toggleCount}`, enabled: false },
    { type: 'separator' },
    {
      label: '設定を開く',
      enabled: canOpenSettings(),
      click: () => showSettings(),
    },
    {
      label: 'ホットキーを一時停止',
      type: 'checkbox',
      checked: hookPaused,
      enabled: !hookTransitioning && rendererPhase === 'idle' && currentRequestId === null,
      click: () => {
        void setHotkeyPaused(!hookPaused)
      },
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => app.quit(),
    },
  ]))
}

function displayBalloon(content: string, iconType: 'none' | 'info' | 'warning' | 'error' = 'info') {
  if (!tray || process.platform !== 'win32') return
  tray.displayBalloon({ title: 'こえかき', content: content.slice(0, 240), iconType })
}

function reportHookError(message: string) {
  hookError = message
  updateTrayMenu()
  console.error(`[hotkey] ${message}`)
  displayBalloon(`右 Alt の監視を開始できませんでした: ${message}`, 'error')
}

function revealController(openSettings: boolean) {
  const win = controllerWindow
  if (!win || win.isDestroyed()) return
  if (!canOpenSettings() && !isDesktopShellSelfTest) {
    displayBalloon('録音または処理が終わってから設定を開いてください。', 'warning')
    return
  }
  win.setSkipTaskbar(false)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (openSettings && rendererReady) win.webContents.send(DESKTOP_CHANNELS.openSettings)
}

function showSettings() {
  revealController(true)
}

function hideSettings() {
  const win = controllerWindow
  if (!win || win.isDestroyed()) return
  win.hide()
  win.setSkipTaskbar(true)
}

function sendDesktopCommand(action: 'start' | 'stop', requestId: string): boolean {
  const win = controllerWindow
  if (!rendererReady || !win || win.isDestroyed() || win.webContents.isDestroyed()) return false
  win.webContents.send(DESKTOP_CHANNELS.command, { action, requestId })
  return true
}

function handleRightAlt(target: PasteTarget | null) {
  if (hookPaused || quitting || !rendererReady) return
  toggleCount += 1

  if (currentRequestId === null && rendererPhase === 'idle') {
    const requestId = randomUUID()
    currentRequestId = requestId
    currentPasteTarget = target
    stopRequested = false
    lastDelivery = 'none'
    rendererIssue = ''
    if (!sendDesktopCommand('start', requestId)) {
      currentRequestId = null
      currentPasteTarget = null
    }
    syncVoiceBar()
    updateTrayMenu()
    return
  }

  if (currentRequestId && rendererPhase === 'recording') {
    if (!stopRequested && sendDesktopCommand('stop', currentRequestId)) stopRequested = true
    updateTrayMenu()
    return
  }

  updateTrayMenu()
}

function handleHotkeyLine(rawLine: string, selfTest: boolean) {
  const message = parseHotkeyLine(rawLine)
  if (!message) return

  if (message.type === 'ready') {
    hookReady = true
    hookError = ''
    clearHotkeyReadyTimer()
    if (selfTest) selfTestSawReady = true
    updateTrayMenu()
    return
  }

  if (message.type === 'right-alt') {
    if (!hookReady) {
      console.warn('[hotkey] Ignored RIGHT_ALT before READY')
      return
    }
    if (selfTest) {
      selfTestToggleCount += 1
      return
    }
    handleRightAlt(message.target ?? null)
    return
  }

  if (message.type === 'self-test-ok') {
    if (selfTest && selfTestSawReady && selfTestToggleCount === 1) selfTestProtocolPassed = true
    return
  }

  console.warn(`[hotkey] Unknown message: ${message.line}`)
}

function startHotkey(selfTest = false) {
  if (hookProcess) throw new Error('Hotkey process is already running')
  if (!selfTest && (!rendererReady || hookPaused)) return

  const executable = powershellPath()
  const script = hotkeyScriptPath()
  if (!existsSync(executable)) throw new Error('Windows PowerShell was not found')
  if (!existsSync(script)) throw new Error('hotkey.ps1 was not found')

  hookReady = false
  hookError = ''
  hookExpectedExit = false
  const stdoutBuffer = new LineBuffer()
  const stderrBuffer = new LineBuffer()
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-ParentPid',
    String(process.pid),
  ]
  if (selfTest) args.push('-SelfTest')

  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  hookProcess = child

  hotkeyReadyTimer = setTimeout(() => {
    if (hookProcess !== child || hookReady) return
    hookExpectedExit = true
    reportHookError('起動がタイムアウトしました')
    child.kill()
  }, HOTKEY_READY_TIMEOUT_MS)

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of stdoutBuffer.push(chunk.toString('utf8'))) handleHotkeyLine(line, selfTest)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of stderrBuffer.push(chunk.toString('utf8'))) {
      if (line.trim()) console.error(`[hotkey stderr] ${line.trim()}`)
    }
  })

  child.once('error', (error) => {
    if (hookProcess === child) hookProcess = null
    clearHotkeyReadyTimer()
    reportHookError(error.message)
    if (selfTest) finishSelfTest(1)
  })

  child.once('exit', (code, signal) => {
    for (const line of stdoutBuffer.flush()) handleHotkeyLine(line, selfTest)
    for (const line of stderrBuffer.flush()) {
      if (line.trim()) console.error(`[hotkey stderr] ${line.trim()}`)
    }

    if (hookProcess === child) hookProcess = null
    clearHotkeyReadyTimer()
    hookReady = false
    updateTrayMenu()

    if (selfTest) {
      const passed = selfTestProtocolPassed && code === 0
      if (passed) console.log('ELECTRON_HOTKEY_SELF_TEST_OK')
      else console.error(`ELECTRON_HOTKEY_SELF_TEST_FAILED code=${code} signal=${signal}`)
      finishSelfTest(passed ? 0 : 1)
      return
    }

    if (!hookExpectedExit && !quitting && !hookPaused) {
      reportHookError(`監視プロセスが終了しました (${code ?? signal ?? 'unknown'})`)
    }
  })
}

async function stopHotkey(): Promise<void> {
  const child = hookProcess
  if (!child) return
  hookExpectedExit = true
  clearHotkeyReadyTimer()

  await new Promise<void>((resolve) => {
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      resolve()
    }
    child.once('exit', finish)
    if (!child.kill()) finish()
    setTimeout(finish, 1_500)
  })
}

function pasteStatusMatchesExit(status: PasteStatus, exitCode: number | null): boolean {
  if (status.type === 'ok-restored' || status.type === 'ok-not-restored') return exitCode === 0
  if (status.type === 'send-failed') return exitCode === 3
  if (status.type === 'skipped' && status.reason === 'clipboard-failed') return exitCode === 4
  if (status.type === 'skipped' && status.reason === 'clipboard-changed') return exitCode === 5
  if (status.type === 'skipped') return exitCode === 2
  return false
}

function runPasteHelper(target: PasteTarget, text: string): Promise<PasteHelperRun> {
  return new Promise((resolve) => {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      hotkeyScriptPath(),
      '-Paste',
      '-TargetHandle',
      target.windowHandle,
      '-TargetProcessId',
      String(target.processId),
      '-TargetThreadId',
      String(target.threadId),
      '-OwnerProcessId',
      String(process.pid),
    ]

    let child: ChildProcess
    try {
      child = spawn(powershellPath(), args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ kind: 'not-started' })
      return
    }

    activePasteProcesses.add(child)
    let processStarted = child.pid !== undefined
    const stdout = new LineBuffer()
    const statuses: PasteStatus[] = []
    let invalidOutput = false
    let outputChars = 0
    let settled = false
    let timedOut = false
    let runtimeError = false
    let timer: NodeJS.Timeout | null = null

    const consumeLine = (line: string) => {
      const parsed = parsePasteStatusLine(line)
      if (!parsed) invalidOutput = true
      else statuses.push(parsed)
    }
    const finish = (result: PasteHelperRun) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      activePasteProcesses.delete(child)
      resolve(result)
    }

    timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, PASTE_HELPER_TIMEOUT_MS)

    child.once('spawn', () => {
      processStarted = true
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      outputChars += chunk.length
      if (outputChars > 4_096) {
        invalidOutput = true
        child.kill()
        return
      }
      for (const line of stdout.push(chunk.toString('utf8'))) consumeLine(line)
    })
    child.stderr?.on('data', () => {
      // Drain the pipe. Paste errors are fixed status codes and never logged here.
    })
    child.once('error', () => {
      if (!processStarted) {
        finish({ kind: 'not-started' })
        return
      }
      runtimeError = true
      child.kill()
    })
    child.once('close', (code) => {
      for (const line of stdout.flush()) consumeLine(line)
      const status = statuses.length === 1 ? statuses[0] : null
      finish(
        !timedOut && !runtimeError && !invalidOutput && status && pasteStatusMatchesExit(status, code)
          ? { kind: 'status', status }
          : { kind: 'ambiguous' },
      )
    })

    child.stdin?.on('error', () => {
      // The close handler classifies any incomplete protocol as ambiguous.
    })
    try {
      if (!child.stdin) throw new Error('Paste helper stdin is unavailable')
      child.stdin.end(text, 'utf8')
    } catch {
      if (!processStarted) {
        child.kill()
        finish({ kind: 'not-started' })
      } else {
        runtimeError = true
        child.kill()
      }
    }
  })
}

function copyDeliveryFallback(text: string, message: string) {
  try {
    clipboard.writeText(text)
    lastDelivery = 'copied'
    displayBalloon(message, 'warning')
  } catch {
    lastDelivery = 'cancelled'
    displayBalloon('文章を直接入力できず、クリップボードへのコピーにも失敗しました。', 'error')
  }
}

function notifyAmbiguousDelivery() {
  lastDelivery = 'cancelled'
  displayBalloon(
    '貼り付け処理の結果が不明なため、クリップボードへの追加の上書きは行っていません。文章はこえかきの結果画面または履歴からコピーしてください。',
    'warning',
  )
}

function notifyClipboardUnavailable() {
  lastDelivery = 'cancelled'
  displayBalloon(
    'クリップボードを安全に更新できなかったため、追加の上書きは行っていません。文章はこえかきの結果画面または履歴からコピーしてください。',
    'warning',
  )
}

async function deliverDictation(text: string, target: PasteTarget | null): Promise<void> {
  if (!target) {
    copyDeliveryFallback(text, '入力先を特定できなかったため、文章をクリップボードにコピーしました。')
    updateTrayMenu()
    return
  }

  const result = await runPasteHelper(target, text)
  if (result.kind === 'not-started') {
    copyDeliveryFallback(text, '貼り付け処理を開始できなかったため、文章をクリップボードにコピーしました。')
    rendererIssue = ''
    updateTrayMenu()
    return
  }
  if (result.kind === 'ambiguous') {
    notifyAmbiguousDelivery()
    rendererIssue = ''
    updateTrayMenu()
    return
  }

  const { status } = result
  if (status.type === 'ok-restored' || status.type === 'ok-not-restored') {
    lastDelivery = 'pasted'
  } else if (status.type === 'skipped' && status.reason === 'clipboard-changed') {
    lastDelivery = 'cancelled'
    displayBalloon('貼り付け中に別のコピー操作があったため、文章の入力を中止しました。', 'warning')
  } else if (status.type === 'skipped' && status.reason === 'clipboard-failed') {
    notifyClipboardUnavailable()
  } else if (
    status.type === 'send-failed' ||
    status.type === 'skipped'
  ) {
    lastDelivery = 'copied'
    displayBalloon('直接入力できなかったため、文章をクリップボードに残しました。', 'warning')
  }
  rendererIssue = ''
  updateTrayMenu()
}

function claimDelivery(requestId: string, text: string, target: PasteTarget | null): Promise<void> {
  const existing = deliveryPromises.get(requestId)
  if (existing) return existing

  const delivery = deliveryTail.then(() => deliverDictation(text, target)).catch(() => {
    notifyAmbiguousDelivery()
    rendererIssue = ''
    updateTrayMenu()
  })
  deliveryTail = delivery
  deliveryPromises.set(requestId, delivery)
  void delivery.then(() => {
    deliveryOrder.push(requestId)
    while (deliveryOrder.length > 100) {
      const oldest = deliveryOrder.shift()
      if (oldest) deliveryPromises.delete(oldest)
    }
  })
  return delivery
}

async function setHotkeyPaused(paused: boolean) {
  if (hookTransitioning || hookPaused === paused) return
  hookTransitioning = true
  updateTrayMenu()

  try {
    if (paused) {
      hookPaused = true
      await stopHotkey()
    } else {
      hookPaused = false
      if (rendererReady) startHotkey(false)
    }
  } catch (error) {
    hookPaused = true
    reportHookError(error instanceof Error ? error.message : String(error))
  } finally {
    hookTransitioning = false
    updateTrayMenu()
  }
}

function finishSelfTest(code: number) {
  if (selfTestFinished) return
  selfTestFinished = true
  clearSelfTestTimer()
  setImmediate(() => app.exit(code))
}

function runHotkeySelfTest() {
  selfTestTimer = setTimeout(() => {
    console.error('ELECTRON_HOTKEY_SELF_TEST_TIMEOUT')
    hookExpectedExit = true
    hookProcess?.kill()
    finishSelfTest(1)
  }, HOTKEY_SELF_TEST_TIMEOUT_MS)

  try {
    startHotkey(true)
  } catch (error) {
    console.error(error)
    finishSelfTest(1)
  }
}

function isTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = controllerWindow
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false
  if (event.senderFrame !== win.webContents.mainFrame) return false
  return isTrustedRendererUrl(event.senderFrame.url, developmentUrl())
}

function requireTrustedIpcSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedIpcSender(event)) throw new Error('IPC sender was rejected')
}

function stateMatchesCurrentRequest(phase: DesktopPhase, requestId?: string): boolean {
  if (currentRequestId === null) return requestId === undefined
  return requestId === currentRequestId
}

function enqueueApiKeySave(keys: DesktopApiKeys): Promise<void> {
  const operation = apiKeySaveTail.then(async () => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('APIキーの暗号化を利用できません')
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(keys))
    await writeFile(apiKeyFilePath(), encrypted, { mode: 0o600 })
  })
  apiKeySaveTail = operation.catch(() => undefined)
  return operation
}

async function loadApiKeys(): Promise<DesktopApiKeys> {
  await apiKeySaveTail
  let encrypted: Buffer
  try {
    encrypted = await readFile(apiKeyFilePath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_API_KEYS }
    throw new Error('保存済みAPIキーを読み込めませんでした')
  }

  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('unavailable')
    const decrypted = await safeStorage.decryptStringAsync(encrypted)
    const keys = parseApiKeys(JSON.parse(decrypted.result) as unknown)
    if (!keys) throw new Error('invalid')
    if (decrypted.shouldReEncrypt) await enqueueApiKeySave(keys)
    return keys
  } catch {
    throw new Error('保存済みAPIキーを復号できませんでした')
  }
}

function registerIpcHandlers() {
  ipcMain.on(DESKTOP_CHANNELS.ready, (event, rawPayload: unknown) => {
    if (!isTrustedIpcSender(event)) return
    const payload = parseReadyPayload(rawPayload)
    if (!payload) return

    if (rendererReady) return

    rendererReady = true
    rendererIssue = ''
    rendererPhase = 'idle'
    currentRequestId = null
    currentPasteTarget = null
    stopRequested = false
    syncVoiceBar()
    updateTrayMenu()

    if (!isAnySelfTest && !hookPaused && !hookProcess) {
      try {
        startHotkey(false)
      } catch (error) {
        reportHookError(error instanceof Error ? error.message : String(error))
      }
    }
    if (!payload.onboarded && !isAnySelfTest) revealController(false)
  })

  ipcMain.on(DESKTOP_CHANNELS.state, (event, rawPayload: unknown) => {
    if (!isTrustedIpcSender(event)) return
    const payload = parseStatePayload(rawPayload)
    if (!payload || !stateMatchesCurrentRequest(payload.phase, payload.requestId)) return

    rendererPhase = payload.phase
    if (payload.phase !== 'error') rendererIssue = ''
    if (payload.phase === 'idle') {
      currentRequestId = null
      currentPasteTarget = null
      stopRequested = false
    }
    syncVoiceBar()
    updateTrayMenu()
  })

  ipcMain.on(DESKTOP_CHANNELS.error, (event, rawPayload: unknown) => {
    if (!isTrustedIpcSender(event)) return
    const payload = parseErrorPayload(rawPayload)
    if (!payload) return
    if (payload.requestId !== undefined && payload.requestId !== currentRequestId) return

    rendererIssue = payload.message
    if (payload.requestId !== undefined) rendererPhase = 'error'
    syncVoiceBar()
    updateTrayMenu()
    displayBalloon(payload.hint ? `${payload.message}\n${payload.hint}` : payload.message, 'error')
  })

  ipcMain.on(DESKTOP_CHANNELS.requestOpenSettings, (event) => {
    if (!isTrustedIpcSender(event)) return
    setImmediate(() => {
      if (canOpenSettings()) revealController(false)
    })
  })

  ipcMain.handle(DESKTOP_CHANNELS.completeDictation, (event, rawPayload: unknown) => {
    requireTrustedIpcSender(event)
    const payload = parseDictationPayload(rawPayload)
    if (!payload) throw new Error('Invalid dictation result')
    const existing = deliveryPromises.get(payload.requestId)
    if (existing) return existing
    if (payload.requestId !== currentRequestId) throw new Error('Invalid dictation result')
    return claimDelivery(payload.requestId, payload.text, currentPasteTarget)
  })

  ipcMain.handle(DESKTOP_CHANNELS.writeClipboard, async (event, rawText: unknown) => {
    requireTrustedIpcSender(event)
    const text = parseClipboardText(rawText)
    if (text === null) throw new Error('Invalid clipboard text')
    clipboard.writeText(text)
  })

  ipcMain.handle(DESKTOP_CHANNELS.loadApiKeys, async (event) => {
    requireTrustedIpcSender(event)
    return loadApiKeys()
  })

  ipcMain.handle(DESKTOP_CHANNELS.saveApiKeys, async (event, rawKeys: unknown) => {
    requireTrustedIpcSender(event)
    const keys = parseApiKeys(rawKeys)
    if (!keys) throw new Error('Invalid API key settings')
    await enqueueApiKeySave(keys)
  })
}

function configureDesktopSession() {
  const devUrl = developmentUrl()
  const desktopSession = session.fromPartition(DESKTOP_PARTITION)
  if (!desktopSession.protocol.isProtocolHandled(DESKTOP_SCHEME)) {
    desktopSession.protocol.handle(DESKTOP_SCHEME, createDesktopProtocolHandler(rendererRootPath()))
  }

  const voiceBarSession = session.fromPartition(VOICE_BAR_PARTITION, { cache: false })
  if (!voiceBarSession.protocol.isProtocolHandled(DESKTOP_SCHEME)) {
    voiceBarSession.protocol.handle(DESKTOP_SCHEME, createDesktopProtocolHandler(rendererRootPath()))
  }
  voiceBarSession.setPermissionCheckHandler(() => false)
  voiceBarSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  voiceBarSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      let allowedDevelopmentRequest = false
      if (devUrl) {
        try {
          const allowed = new URL(devUrl)
          const requested = new URL(details.url)
          allowedDevelopmentRequest =
            requested.hostname === allowed.hostname &&
            requested.port === allowed.port &&
            (requested.protocol === 'http:' || requested.protocol === 'ws:')
        } catch {
          allowedDevelopmentRequest = false
        }
      }
      callback({ cancel: !allowedDevelopmentRequest })
    },
  )

  desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return Boolean(
      controllerWindow &&
        webContents === controllerWindow.webContents &&
        permission === 'media' &&
        details.isMainFrame &&
        details.mediaType === 'audio' &&
        isTrustedRendererUrl(details.requestingUrl ?? requestingOrigin, devUrl),
    )
  })

  desktopSession.setPermissionRequestHandler((webContents, permission, callback, rawDetails) => {
    const details = rawDetails as MediaAccessPermissionRequest
    const mediaTypes = details.mediaTypes ?? []
    const allowed = Boolean(
      controllerWindow &&
        webContents === controllerWindow.webContents &&
        permission === 'media' &&
        details.isMainFrame &&
        mediaTypes.length > 0 &&
        mediaTypes.every((type) => type === 'audio') &&
        isTrustedRendererUrl(details.requestingUrl, devUrl),
    )
    callback(allowed)
  })
}

async function markRendererUnavailable(message: string) {
  rendererReady = false
  rendererIssue = message
  rendererPhase = 'error'
  currentRequestId = null
  currentPasteTarget = null
  stopRequested = false
  syncVoiceBar()
  await stopHotkey()
  if (rendererReady && !hookPaused && !hookProcess && !quitting) {
    try {
      startHotkey(false)
    } catch (error) {
      reportHookError(error instanceof Error ? error.message : String(error))
    }
  }
  updateTrayMenu()
}

function createControllerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 420,
    minHeight: 600,
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'こえかき',
    webPreferences: {
      partition: DESKTOP_PARTITION,
      preload: preloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
      webviewTag: false,
    },
  })
  controllerWindow = win

  const devUrl = developmentUrl()
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, devUrl)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, devUrl)) event.preventDefault()
  })
  win.webContents.on('did-start-loading', () => {
    if (rendererReady && !isAnySelfTest) void markRendererUnavailable('コントローラーを再読み込み中')
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    if (isDesktopShellSelfTest) {
      console.error(`ELECTRON_DESKTOP_SHELL_SELF_TEST_RENDERER_GONE reason=${details.reason}`)
      finishSelfTest(1)
      return
    }
    void markRendererUnavailable('画面プロセスが停止しました')
  })
  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame) return
    if (isDesktopShellSelfTest) {
      console.error(`ELECTRON_DESKTOP_SHELL_SELF_TEST_LOAD_FAILED code=${code} description=${description}`)
      finishSelfTest(1)
    }
  })
  win.on('close', (event) => {
    if (quitting || isAnySelfTest) return
    event.preventDefault()
    hideSettings()
  })
  win.on('closed', () => {
    if (controllerWindow === win) controllerWindow = null
  })

  void win.loadURL(devUrl ?? DESKTOP_APP_URL)
  return win
}

function createVoiceBarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: VOICE_BAR_WIDTH,
    height: VOICE_BAR_HEIGHT,
    useContentSize: true,
    show: false,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'こえかき 録音中',
    webPreferences: {
      partition: VOICE_BAR_PARTITION,
      preload: overlayPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
      webviewTag: false,
      spellcheck: false,
    },
  })
  voiceBarWindow = win
  voiceBarReady = false
  voiceBarShowVersion += 1
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true)
  positionVoiceBar(win)

  const devUrl = developmentUrl()
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedVoiceBarRendererUrl(url, devUrl)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedVoiceBarRendererUrl(url, devUrl)) event.preventDefault()
  })
  win.webContents.on('did-start-loading', () => {
    voiceBarReady = false
    voiceBarShowVersion += 1
    win.hide()
  })
  win.webContents.on('did-finish-load', () => {
    clearVoiceBarRecoveryTimer()
    voiceBarRecoveryAttempts = 0
    voiceBarReady = true
    syncVoiceBar()
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    if (isDesktopShellSelfTest) {
      console.error(`ELECTRON_DESKTOP_SHELL_SELF_TEST_VOICE_BAR_GONE reason=${details.reason}`)
      finishSelfTest(1)
      return
    }
    scheduleVoiceBarRecovery()
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    if (isDesktopShellSelfTest) {
      console.error(`ELECTRON_DESKTOP_SHELL_SELF_TEST_VOICE_BAR_LOAD_FAILED code=${code} description=${description}`)
      finishSelfTest(1)
      return
    }
    scheduleVoiceBarRecovery()
  })
  win.on('closed', () => {
    if (voiceBarWindow === win) {
      voiceBarWindow = null
      voiceBarReady = false
      voiceBarShowVersion += 1
      scheduleVoiceBarRecovery()
    }
  })

  void win.loadURL(voiceBarRendererUrl()).catch(() => scheduleVoiceBarRecovery())
  return win
}

function createTray() {
  const sourceIcon = path.join(app.getAppPath(), 'public', 'icons', 'icon-192.png')
  const image = nativeImage.createFromPath(sourceIcon).resize({ width: 16, height: 16 })
  if (image.isEmpty()) throw new Error('Tray icon could not be loaded')
  tray = new Tray(image)
  tray.on('double-click', () => showSettings())
  updateTrayMenu()
}

function runNormalMode() {
  configureDesktopSession()
  registerIpcHandlers()
  createTray()
  createControllerWindow()
  createVoiceBarWindow()
}

function runDesktopShellSelfTest() {
  const root = rendererRootPath()
  const validAsset = resolveDesktopAssetPath(DESKTOP_APP_URL, root)
  const guardsPassed =
    validAsset === path.join(path.resolve(root), 'index.html') &&
    resolveDesktopAssetPath('koekaki://app/%2e%2e%2foutside.txt', root) === null &&
    resolveDesktopAssetPath('koekaki://evil/index.html', root) === null &&
    parseStatePayload({ phase: 'recording', requestId: 'not-a-request-id' }) === null &&
    parseReadyPayload({ onboarded: true, unexpected: true }) === null &&
    parseClipboardText('') === null &&
    parseApiKeys({ gemini: '', openai: '', anthropic: '' }) !== null &&
    isVoiceBarPhase('recording') &&
    !isVoiceBarPhase('idle') &&
    !VOICE_BAR_PARTITION.startsWith('persist:') &&
    isTrustedVoiceBarRendererUrl(VOICE_BAR_APP_URL) &&
    !isTrustedVoiceBarRendererUrl(DESKTOP_APP_URL)
  if (!guardsPassed) {
    console.error('ELECTRON_DESKTOP_SHELL_SELF_TEST_GUARD_FAILED')
    finishSelfTest(1)
    return
  }

  configureDesktopSession()
  registerIpcHandlers()
  const win = createControllerWindow()
  const voiceWin = createVoiceBarWindow()

  selfTestTimer = setTimeout(() => {
    console.error('ELECTRON_DESKTOP_SHELL_SELF_TEST_TIMEOUT')
    finishSelfTest(1)
  }, DESKTOP_SELF_TEST_TIMEOUT_MS)

  let controllerLoaded = false
  let voiceBarLoaded = false
  let checksStarted = false
  const runChecksWhenLoaded = () => {
    if (checksStarted || !controllerLoaded || !voiceBarLoaded) return
    checksStarted = true
    void (async () => {
      try {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) {
          throw new Error('secure storage is unavailable')
        }
        const encryptedProbe = await safeStorage.encryptStringAsync('koekaki-desktop-self-test')
        const decryptedProbe = await safeStorage.decryptStringAsync(encryptedProbe)
        if (decryptedProbe.result !== 'koekaki-desktop-self-test') {
          throw new Error('secure storage round trip failed')
        }

        const rendererCheck = (await win.webContents.executeJavaScript(`({
          secure: window.isSecureContext,
          bridge: window.koekakiDesktop?.isDesktop === true,
          nodeGlobalsHidden: typeof window.require === 'undefined' && typeof window.process === 'undefined',
          protocol: window.location.protocol,
          host: window.location.hostname
        })`)) as {
          secure?: boolean
          bridge?: boolean
          nodeGlobalsHidden?: boolean
          protocol?: string
          host?: string
        }
        const controllerPassed =
          rendererCheck.secure === true &&
          rendererCheck.bridge === true &&
          rendererCheck.nodeGlobalsHidden === true &&
          rendererCheck.protocol === `${DESKTOP_SCHEME}:` &&
          rendererCheck.host === 'app'
        if (!controllerPassed) throw new Error('secure controller shell checks failed')

        for (let attempt = 0; attempt < 50 && !rendererReady; attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
        if (!rendererReady) throw new Error('controller renderer did not report ready')

        await voiceWin.webContents.insertCSS('.voice-bar--recording .voice-bar__core { animation: none !important; }')
        const phaseExpectations: ReadonlyArray<readonly [VoiceBarPhase, string]> = [
          ['starting', 'マイクを準備しています…'],
          ['recording', 'もう一度 右Alt で終了'],
          ['transcribing', '文字にしています…'],
          ['polishing', '文章を整えています…'],
        ]
        for (const [phase, expectedMessage] of phaseExpectations) {
          rendererPhase = phase
          syncVoiceBar()
          await voiceWin.webContents.executeJavaScript(
            'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          )
          const phaseCheck = (await voiceWin.webContents.executeJavaScript(`(() => {
            const bar = document.querySelector('[data-voicebar-phase]')
            const message = document.querySelector('.voice-bar__message')
            return {
              phase: bar?.getAttribute('data-voicebar-phase'),
              message: message?.textContent,
              fits: message instanceof HTMLElement && message.scrollWidth <= message.clientWidth
            }
          })()`)) as { phase?: string | null; message?: string | null; fits?: boolean }
          if (
            phaseCheck.phase !== phase ||
            phaseCheck.message !== expectedMessage ||
            phaseCheck.fits !== true
          ) {
            throw new Error(`voice bar phase rendering failed: ${phase}`)
          }
        }
        console.log('ELECTRON_VOICE_BAR_PHASES_OK=starting,recording,transcribing,polishing')

        rendererPhase = 'idle'
        currentRequestId = null
        syncVoiceBar()
        if (voiceWin.isVisible()) throw new Error('voice bar did not hide between requests')
        currentRequestId = randomUUID()
        syncVoiceBar()
        if (voiceWin.isVisible()) throw new Error('voice bar showed a stale phase before starting was painted')
        await voiceWin.webContents.executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        )
        const immediateStartCheck = (await voiceWin.webContents.executeJavaScript(`({
          phase: document.querySelector('[data-voicebar-phase]')?.getAttribute('data-voicebar-phase'),
          visible: document.visibilityState === 'visible'
        })`)) as { phase?: string | null; visible?: boolean }
        if (
          immediateStartCheck.phase !== 'starting' ||
          immediateStartCheck.visible !== true ||
          !voiceWin.isVisible()
        ) {
          throw new Error('voice bar did not show starting after the start request')
        }

        currentRequestId = null
        rendererPhase = 'recording'
        syncVoiceBar()
        await voiceWin.webContents.executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        )

        const voiceBarCheck = (await voiceWin.webContents.executeJavaScript(`({
          secure: window.isSecureContext,
          bridgeKeys: Object.keys(window.koekakiVoiceBar ?? {}).sort(),
          controllerBridgeHidden: typeof window.koekakiDesktop === 'undefined',
          nodeGlobalsHidden: typeof window.require === 'undefined' && typeof window.process === 'undefined',
          protocol: window.location.protocol,
          host: window.location.hostname,
          surface: new URLSearchParams(window.location.search).get('surface'),
          phase: document.querySelector('[data-voicebar-phase]')?.getAttribute('data-voicebar-phase'),
          message: document.querySelector('.voice-bar__message')?.textContent
        })`)) as {
          secure?: boolean
          bridgeKeys?: string[]
          controllerBridgeHidden?: boolean
          nodeGlobalsHidden?: boolean
          protocol?: string
          host?: string
          surface?: string | null
          phase?: string | null
          message?: string | null
        }
        const voiceBarBridgePassed =
          voiceBarCheck.secure === true &&
          JSON.stringify(voiceBarCheck.bridgeKeys) === JSON.stringify(['onPhase']) &&
          voiceBarCheck.controllerBridgeHidden === true &&
          voiceBarCheck.nodeGlobalsHidden === true &&
          voiceBarCheck.protocol === `${DESKTOP_SCHEME}:` &&
          voiceBarCheck.host === 'app' &&
          voiceBarCheck.surface === 'voicebar' &&
          voiceBarCheck.phase === 'recording' &&
          voiceBarCheck.message === 'もう一度 右Alt で終了'
        if (!voiceBarBridgePassed) throw new Error('secure voice bar shell checks failed')

        const bounds = voiceWin.getBounds()
        const voiceBarDisplay = screen.getDisplayMatching(bounds)
        const workArea = voiceBarDisplay.workArea
        const windowStatePassed =
          bounds.width === VOICE_BAR_WIDTH &&
          bounds.height === VOICE_BAR_HEIGHT &&
          bounds.x === Math.round(workArea.x + (workArea.width - VOICE_BAR_WIDTH) / 2) &&
          bounds.y === workArea.y + workArea.height - VOICE_BAR_HEIGHT - VOICE_BAR_BOTTOM_MARGIN &&
          voiceWin.isVisible() &&
          !voiceWin.isFocusable() &&
          voiceWin.isAlwaysOnTop() &&
          !voiceWin.isResizable() &&
          !voiceWin.isMinimizable() &&
          !voiceWin.isMaximizable() &&
          BrowserWindow.getFocusedWindow() !== voiceWin &&
          voiceWin.webContents.session === session.fromPartition(VOICE_BAR_PARTITION) &&
          voiceWin.webContents.session !== win.webContents.session &&
          hookProcess === null &&
          activePasteProcesses.size === 0
        if (!windowStatePassed) {
          throw new Error(
            `voice bar window state checks failed ${JSON.stringify({
              bounds,
              workArea,
              visible: voiceWin.isVisible(),
              focusable: voiceWin.isFocusable(),
              alwaysOnTop: voiceWin.isAlwaysOnTop(),
              resizable: voiceWin.isResizable(),
              minimizable: voiceWin.isMinimizable(),
              maximizable: voiceWin.isMaximizable(),
              focused: BrowserWindow.getFocusedWindow() === voiceWin,
            })}`,
          )
        }

        const capture = await voiceWin.webContents.capturePage()
        const captureSize = capture.getSize()
        const captureBitmap = capture.toBitmap()
        const capturePng = capture.toPNG()
        let hasOpaquePixel = false
        for (let index = 3; index < captureBitmap.length; index += 4) {
          if (captureBitmap[index] > 200) {
            hasOpaquePixel = true
            break
          }
        }
        if (
          capture.isEmpty() ||
          captureSize.width < 1 ||
          captureSize.height < 1 ||
          capturePng.length < 512 ||
          captureBitmap.length < 4 ||
          captureBitmap[3] > 16 ||
          !hasOpaquePixel
        ) {
          throw new Error('voice bar capture was empty')
        }
        const captureDirectory = path.join(app.getPath('temp'), 'koekaki-self-test')
        const capturePath = path.join(
          captureDirectory,
          `voicebar-recording-${process.pid}-${randomUUID()}.png`,
        )
        await mkdir(captureDirectory, { recursive: true })
        await writeFile(capturePath, capturePng, { flag: 'wx' })
        console.log(
          `ELECTRON_VOICE_BAR_CAPTURE_META=css:${bounds.width}x${bounds.height},png:${captureSize.width}x${captureSize.height},scale:${voiceBarDisplay.scaleFactor}`,
        )
        console.log(`ELECTRON_VOICE_BAR_CAPTURE=${capturePath}`)

        rendererPhase = 'idle'
        syncVoiceBar()
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (voiceWin.isVisible()) throw new Error('voice bar remained visible while idle')
        rendererPhase = 'error'
        syncVoiceBar()
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (voiceWin.isVisible()) throw new Error('voice bar remained visible while in error')

        console.log('ELECTRON_DESKTOP_SHELL_SELF_TEST_OK')
        finishSelfTest(0)
      } catch (error) {
        console.error(`ELECTRON_DESKTOP_SHELL_SELF_TEST_FAILED: ${error instanceof Error ? error.message : String(error)}`)
        finishSelfTest(1)
      }
    })()
  }
  win.webContents.once('did-finish-load', () => {
    controllerLoaded = true
    runChecksWhenLoaded()
  })
  voiceWin.webContents.once('did-finish-load', () => {
    voiceBarLoaded = true
    runChecksWhenLoaded()
  })
}

app.setName('こえかき')
if (process.platform === 'win32') app.setAppUserModelId('com.umbrellaparade.koekaki')

const hasSingleInstanceLock = isAnySelfTest || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showSettings())
  app.on('activate', () => showSettings())

  app.on('before-quit', () => {
    quitting = true
    hookExpectedExit = true
    clearHotkeyReadyTimer()
    clearSelfTestTimer()
    clearVoiceBarRecoveryTimer()
    hookProcess?.kill()
    for (const child of activePasteProcesses) child.kill()
  })

  app.whenReady().then(() => {
    if (isHotkeySelfTest) runHotkeySelfTest()
    else if (isDesktopShellSelfTest) runDesktopShellSelfTest()
    else runNormalMode()
  })
}
