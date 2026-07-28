import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
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
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  parseApiKeys,
  parseClipboardText,
  parseDictationPayload,
  parseErrorPayload,
  parseReadyPayload,
  parseStatePayload,
  registerDesktopScheme,
  resolveDesktopAssetPath,
  type DesktopApiKeys,
  type DesktopPhase,
} from './desktopProtocol.js'
import { LineBuffer, parseHotkeyLine } from './hotkeyProtocol.js'

const HOTKEY_READY_TIMEOUT_MS = 8_000
const HOTKEY_SELF_TEST_TIMEOUT_MS = 12_000
const DESKTOP_SELF_TEST_TIMEOUT_MS = 20_000
const DEVELOPMENT_URLS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])
const EMPTY_API_KEYS: DesktopApiKeys = { gemini: '', openai: '', anthropic: '' }
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

const isHotkeySelfTest = process.argv.includes('--hotkey-self-test')
const isDesktopShellSelfTest = process.argv.includes('--desktop-shell-self-test')
const isAnySelfTest = isHotkeySelfTest || isDesktopShellSelfTest

let tray: Tray | null = null
let controllerWindow: BrowserWindow | null = null
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
let stopRequested = false
let copiedLastResult = false
let toggleCount = 0
let hotkeyReadyTimer: NodeJS.Timeout | null = null
let selfTestTimer: NodeJS.Timeout | null = null
let selfTestSawReady = false
let selfTestToggleCount = 0
let selfTestProtocolPassed = false
let selfTestFinished = false
let quitting = false
let apiKeySaveTail: Promise<void> = Promise.resolve()

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
  return copiedLastResult ? '待機中（コピー済み）' : '待機中'
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

function handleRightAlt() {
  if (hookPaused || quitting || !rendererReady) return
  toggleCount += 1

  if (currentRequestId === null && rendererPhase === 'idle') {
    const requestId = randomUUID()
    currentRequestId = requestId
    stopRequested = false
    copiedLastResult = false
    rendererIssue = ''
    if (!sendDesktopCommand('start', requestId)) currentRequestId = null
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
    handleRightAlt()
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
    stopRequested = false
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
      stopRequested = false
    }
    updateTrayMenu()
  })

  ipcMain.on(DESKTOP_CHANNELS.error, (event, rawPayload: unknown) => {
    if (!isTrustedIpcSender(event)) return
    const payload = parseErrorPayload(rawPayload)
    if (!payload) return
    if (payload.requestId !== undefined && payload.requestId !== currentRequestId) return

    rendererIssue = payload.message
    if (payload.requestId !== undefined) rendererPhase = 'error'
    updateTrayMenu()
    displayBalloon(payload.hint ? `${payload.message}\n${payload.hint}` : payload.message, 'error')
  })

  ipcMain.on(DESKTOP_CHANNELS.requestOpenSettings, (event) => {
    if (!isTrustedIpcSender(event)) return
    setImmediate(() => {
      if (canOpenSettings()) revealController(false)
    })
  })

  ipcMain.handle(DESKTOP_CHANNELS.completeDictation, async (event, rawPayload: unknown) => {
    requireTrustedIpcSender(event)
    const payload = parseDictationPayload(rawPayload)
    if (!payload || payload.requestId !== currentRequestId) throw new Error('Invalid dictation result')
    clipboard.writeText(payload.text)
    copiedLastResult = true
    rendererIssue = ''
    updateTrayMenu()
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
  const desktopSession = session.fromPartition(DESKTOP_PARTITION)
  if (!desktopSession.protocol.isProtocolHandled(DESKTOP_SCHEME)) {
    desktopSession.protocol.handle(DESKTOP_SCHEME, createDesktopProtocolHandler(rendererRootPath()))
  }

  const devUrl = developmentUrl()
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
  stopRequested = false
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
  win.webContents.on('did-fail-load', (_event, code, description) => {
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
    parseApiKeys({ gemini: '', openai: '', anthropic: '' }) !== null
  if (!guardsPassed) {
    console.error('ELECTRON_DESKTOP_SHELL_SELF_TEST_GUARD_FAILED')
    finishSelfTest(1)
    return
  }

  configureDesktopSession()
  registerIpcHandlers()
  const win = createControllerWindow()

  selfTestTimer = setTimeout(() => {
    console.error('ELECTRON_DESKTOP_SHELL_SELF_TEST_TIMEOUT')
    finishSelfTest(1)
  }, DESKTOP_SELF_TEST_TIMEOUT_MS)

  win.webContents.once('did-finish-load', () => {
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
        const passed =
          rendererCheck.secure === true &&
          rendererCheck.bridge === true &&
          rendererCheck.nodeGlobalsHidden === true &&
          rendererCheck.protocol === `${DESKTOP_SCHEME}:` &&
          rendererCheck.host === 'app'
        if (!passed) throw new Error('secure shell checks failed')
        console.log('ELECTRON_DESKTOP_SHELL_SELF_TEST_OK')
        finishSelfTest(0)
      } catch (error) {
        console.error(`ELECTRON_DESKTOP_SHELL_SELF_TEST_FAILED: ${error instanceof Error ? error.message : String(error)}`)
        finishSelfTest(1)
      }
    })()
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
    hookProcess?.kill()
  })

  app.whenReady().then(() => {
    if (isHotkeySelfTest) runHotkeySelfTest()
    else if (isDesktopShellSelfTest) runDesktopShellSelfTest()
    else runNormalMode()
  })
}
