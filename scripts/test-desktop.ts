import assert from 'node:assert/strict'
import path from 'node:path'
import {
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  parseApiKeys,
  parseClipboardText,
  parseDictationPayload,
  parseErrorPayload,
  parseReadyPayload,
  parseStatePayload,
  resolveDesktopAssetPath,
} from '../electron/desktopContract.ts'
import { compactDesktopMessage, decideDesktopCommand } from '../src/lib/desktopFlow.ts'

let passed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  OK   ${name}`)
  } catch (error) {
    console.error(`  NG   ${name}`)
    throw error
  }
}

const requestId = '123e4567-e89b-12d3-a456-426614174000'
const otherRequestId = '223e4567-e89b-12d3-a456-426614174000'
const rendererRoot = path.resolve('test-fixtures', 'desktop-renderer')

test('待機中の開始指示だけを受け付ける', () => {
  assert.equal(decideDesktopCommand('idle', null, { action: 'start', requestId }), 'start')
  assert.equal(decideDesktopCommand('recording', requestId, { action: 'start', requestId }), 'ignore')
})

test('同じ録音IDの停止指示だけを受け付ける', () => {
  assert.equal(decideDesktopCommand('recording', requestId, { action: 'stop', requestId }), 'stop')
  assert.equal(decideDesktopCommand('recording', requestId, { action: 'stop', requestId: otherRequestId }), 'ignore')
  assert.equal(decideDesktopCommand('polishing', requestId, { action: 'stop', requestId }), 'ignore')
})

test('トレイ向けエラー文を一行・上限内に収める', () => {
  assert.equal(compactDesktopMessage('  マイク\nを  確認  '), 'マイク を 確認')
  assert.equal(compactDesktopMessage('abcdef', 5), 'abcd…')
  assert.equal(compactDesktopMessage('   '), undefined)
})

test('アプリルートをindex.htmlへ解決する', () => {
  assert.equal(resolveDesktopAssetPath('koekaki://app/', rendererRoot), path.join(rendererRoot, 'index.html'))
})

test('配下のアセットだけを解決する', () => {
  assert.equal(
    resolveDesktopAssetPath('koekaki://app/assets/index.js', rendererRoot),
    path.join(rendererRoot, 'assets', 'index.js'),
  )
})

test('異なるscheme・host・資格情報を拒否する', () => {
  assert.equal(resolveDesktopAssetPath('https://app/index.html', rendererRoot), null)
  assert.equal(resolveDesktopAssetPath('koekaki://evil/index.html', rendererRoot), null)
  assert.equal(resolveDesktopAssetPath('koekaki://user@app/index.html', rendererRoot), null)
})

test('エンコードされた親移動とWindows区切りを拒否する', () => {
  assert.equal(resolveDesktopAssetPath('koekaki://app/%2e%2e%2fsecret.txt', rendererRoot), null)
  assert.equal(resolveDesktopAssetPath('koekaki://app/%5c..%5csecret.txt', rendererRoot), null)
  assert.equal(resolveDesktopAssetPath('koekaki://app/%E0%A4%A', rendererRoot), null)
})

test('準備完了payloadを厳密に検証する', () => {
  assert.deepEqual(parseReadyPayload({ onboarded: true }), { onboarded: true })
  assert.equal(parseReadyPayload({ onboarded: true, extra: true }), null)
  assert.equal(parseReadyPayload({ onboarded: 'yes' }), null)
})

test('録音状態と録音IDを厳密に検証する', () => {
  assert.deepEqual(parseStatePayload({ phase: 'recording', requestId }), { phase: 'recording', requestId })
  assert.deepEqual(parseStatePayload({ phase: 'idle' }), { phase: 'idle' })
  assert.equal(parseStatePayload({ phase: 'unknown' }), null)
  assert.equal(parseStatePayload({ phase: 'recording', requestId: 'bad' }), null)
})

test('エラー通知の長さと項目を制限する', () => {
  assert.deepEqual(parseErrorPayload({ message: 'マイクを確認してください', requestId }), {
    message: 'マイクを確認してください',
    requestId,
  })
  assert.equal(parseErrorPayload({ message: '' }), null)
  assert.equal(parseErrorPayload({ message: 'x'.repeat(241) }), null)
  assert.equal(parseErrorPayload({ message: '失敗', secret: 'value' }), null)
})

test('クリップボード本文の型・空・上限を検証する', () => {
  assert.equal(parseClipboardText('本文'), '本文')
  assert.equal(parseClipboardText(''), null)
  assert.equal(parseClipboardText(123), null)
  assert.equal(parseClipboardText('x'.repeat(1_000_001)), null)
})

test('完成文は正しい録音IDと本文だけを受け付ける', () => {
  assert.deepEqual(parseDictationPayload({ requestId, text: '今回の本文' }), {
    requestId,
    text: '今回の本文',
  })
  assert.equal(parseDictationPayload({ requestId: 'bad', text: '本文' }), null)
  assert.equal(parseDictationPayload({ requestId, text: '本文', extra: true }), null)
})

test('APIキー設定は3項目だけを上限付きで受け付ける', () => {
  const keys = { gemini: 'gemini-test', openai: 'openai-test', anthropic: 'anthropic-test' }
  assert.deepEqual(parseApiKeys(keys), keys)
  assert.equal(parseApiKeys({ ...keys, extra: 'value' }), null)
  assert.equal(parseApiKeys({ ...keys, openai: 'x'.repeat(4_097) }), null)
  assert.equal(parseApiKeys({ ...keys, gemini: 'bad\0value' }), null)
})

test('APIキー取得ページは許可したHTTPS originだけを開く', () => {
  assert.equal(isAllowedExternalUrl('https://platform.openai.com/api-keys'), true)
  assert.equal(isAllowedExternalUrl('https://aistudio.google.com/apikey'), true)
  assert.equal(isAllowedExternalUrl('http://platform.openai.com/api-keys'), false)
  assert.equal(isAllowedExternalUrl('https://platform.openai.com.evil.example/'), false)
})

test('renderer URLは専用originか明示したloopbackだけを信頼する', () => {
  assert.equal(isTrustedRendererUrl('koekaki://app/index.html'), true)
  assert.equal(isTrustedRendererUrl('koekaki://evil/index.html'), false)
  assert.equal(
    isTrustedRendererUrl('http://127.0.0.1:5173/settings', 'http://127.0.0.1:5173'),
    true,
  )
  assert.equal(
    isTrustedRendererUrl('http://127.0.0.1:5174/', 'http://127.0.0.1:5173'),
    false,
  )
})

console.log(`\n全 ${passed} 件 通過`)
