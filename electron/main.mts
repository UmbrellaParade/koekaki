import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import { LineBuffer, parseHotkeyLine } from './hotkeyProtocol.js'

const HOTKEY_READY_TIMEOUT_MS = 8_000
const SELF_TEST_TIMEOUT_MS = 12_000
const isHotkeySelfTest = process.argv.includes('--hotkey-self-test')

let tray: Tray | null = null
let hookProcess: ChildProcess | null = null
let hookReady = false
let hookPaused = false
let hookExpectedExit = false
let hookTransitioning = false
let hookError = ''
let diagnosticActive = false
let toggleCount = 0
let readyTimer: NodeJS.Timeout | null = null
let selfTestTimer: NodeJS.Timeout | null = null
let selfTestSawReady = false
let selfTestToggleCount = 0
let selfTestProtocolPassed = false
let selfTestFinished = false
let quitting = false

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is not defined')
  return path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

function hotkeyScriptPath(): string {
  return path.join(app.getAppPath(), 'electron', 'hotkey.ps1')
}

function clearReadyTimer() {
  if (!readyTimer) return
  clearTimeout(readyTimer)
  readyTimer = null
}

function clearSelfTestTimer() {
  if (!selfTestTimer) return
  clearTimeout(selfTestTimer)
  selfTestTimer = null
}

function trayStatus(): string {
  if (hookTransitioning) return '右 Alt: 切り替え中'
  if (hookPaused) return '右 Alt: 一時停止中'
  if (hookError) return `右 Alt: エラー (${hookError})`
  if (!hookReady) return '右 Alt: 準備中'
  return diagnosticActive ? '右 Alt: ON を受信' : '右 Alt: OFF を受信'
}

function updateTrayMenu() {
  if (!tray) return

  tray.setToolTip(`こえかき — ${trayStatus()}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayStatus(), enabled: false },
    { label: `受信回数: ${toggleCount}`, enabled: false },
    { type: 'separator' },
    {
      label: 'ホットキーを一時停止',
      type: 'checkbox',
      checked: hookPaused,
      enabled: !hookTransitioning,
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

function reportHookError(message: string) {
  hookError = message
  updateTrayMenu()
  console.error(`[hotkey] ${message}`)

  if (tray && process.platform === 'win32') {
    tray.displayBalloon({
      title: 'こえかき',
      content: `右 Alt の監視を開始できませんでした: ${message}`,
      iconType: 'error',
    })
  }
}

function handleHotkeyLine(rawLine: string, selfTest: boolean) {
  const message = parseHotkeyLine(rawLine)
  if (!message) return

  if (message.type === 'ready') {
    hookReady = true
    hookError = ''
    clearReadyTimer()
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

    if (hookPaused || quitting) return
    diagnosticActive = !diagnosticActive
    toggleCount += 1
    updateTrayMenu()
    console.log(`[hotkey] toggle ${diagnosticActive ? 'on' : 'off'}`)
    return
  }

  if (message.type === 'self-test-ok') {
    if (selfTest && selfTestSawReady && selfTestToggleCount === 1) {
      selfTestProtocolPassed = true
    }
    return
  }

  console.warn(`[hotkey] Unknown message: ${message.line}`)
}

function startHotkey(selfTest = false) {
  if (hookProcess) throw new Error('Hotkey process is already running')

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

  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  hookProcess = child

  readyTimer = setTimeout(() => {
    if (hookProcess !== child || hookReady) return
    hookExpectedExit = true
    reportHookError('起動がタイムアウトしました')
    child.kill()
  }, HOTKEY_READY_TIMEOUT_MS)

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of stdoutBuffer.push(chunk.toString('utf8'))) {
      handleHotkeyLine(line, selfTest)
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of stderrBuffer.push(chunk.toString('utf8'))) {
      if (line.trim()) console.error(`[hotkey stderr] ${line.trim()}`)
    }
  })

  child.once('error', (error) => {
    if (hookProcess === child) hookProcess = null
    clearReadyTimer()
    reportHookError(error.message)
    if (selfTest) finishSelfTest(1)
  })

  child.once('exit', (code, signal) => {
    for (const line of stdoutBuffer.flush()) handleHotkeyLine(line, selfTest)
    for (const line of stderrBuffer.flush()) {
      if (line.trim()) console.error(`[hotkey stderr] ${line.trim()}`)
    }

    if (hookProcess === child) hookProcess = null
    clearReadyTimer()
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
  clearReadyTimer()

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
      diagnosticActive = false
      await stopHotkey()
    } else {
      hookPaused = false
      startHotkey(false)
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

function createTray() {
  const sourceIcon = path.join(app.getAppPath(), 'public', 'icons', 'icon-192.png')
  const image = nativeImage.createFromPath(sourceIcon).resize({ width: 16, height: 16 })
  if (image.isEmpty()) throw new Error('Tray icon could not be loaded')

  tray = new Tray(image)
  updateTrayMenu()
}

function runNormalMode() {
  createTray()
  try {
    startHotkey(false)
  } catch (error) {
    reportHookError(error instanceof Error ? error.message : String(error))
  }
}

function runSelfTestMode() {
  selfTestTimer = setTimeout(() => {
    console.error('ELECTRON_HOTKEY_SELF_TEST_TIMEOUT')
    hookExpectedExit = true
    hookProcess?.kill()
    finishSelfTest(1)
  }, SELF_TEST_TIMEOUT_MS)

  try {
    startHotkey(true)
  } catch (error) {
    console.error(error)
    finishSelfTest(1)
  }
}

app.setName('こえかき')
if (process.platform === 'win32') app.setAppUserModelId('com.umbrellaparade.koekaki')

const hasSingleInstanceLock = isHotkeySelfTest || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    tray?.popUpContextMenu()
  })

  app.on('before-quit', () => {
    quitting = true
    hookExpectedExit = true
    clearReadyTimer()
    clearSelfTestTimer()
    hookProcess?.kill()
  })

  app.whenReady().then(() => {
    if (isHotkeySelfTest) runSelfTestMode()
    else runNormalMode()
  })
}
