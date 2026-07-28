import assert from 'node:assert/strict'
import { LineBuffer, parseHotkeyLine, parsePasteStatusLine } from '../electron/hotkeyProtocol.ts'

let passed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  OK   ${name}`)
  } catch {
    console.error(`  NG   ${name}`)
    throw new Error(`Test failed: ${name}`)
  }
}

function expectUnknownHotkey(line: string) {
  const parsed = parseHotkeyLine(line)
  if (parsed?.type !== 'unknown') throw new Error('Malformed hotkey line was accepted')
}

function expectRejectedPasteStatus(line: string) {
  if (parsePasteStatusLine(line) !== null) throw new Error('Malformed paste status was accepted')
}

test('右Altの入力先を精度を落とさず解析する', () => {
  assert.deepEqual(parseHotkeyLine('RIGHT_ALT 1 1 1'), {
    type: 'right-alt',
    target: { windowHandle: '1', processId: 1, threadId: 1 },
  })
  assert.deepEqual(
    parseHotkeyLine('RIGHT_ALT 9223372036854775807 4294967295 4294967295'),
    {
      type: 'right-alt',
      target: {
        windowHandle: '9223372036854775807',
        processId: 4_294_967_295,
        threadId: 4_294_967_295,
      },
    },
  )
})

test('自己テストの対象なし通知だけを互換受理する', () => {
  assert.deepEqual(parseHotkeyLine('RIGHT_ALT'), { type: 'right-alt' })
  assert.deepEqual(parseHotkeyLine('RIGHT_ALT 0 0 0'), { type: 'right-alt' })
  expectUnknownHotkey('RIGHT_ALT 0 1 1')
  expectUnknownHotkey('RIGHT_ALT 1 0 1')
  expectUnknownHotkey('RIGHT_ALT 1 1 0')
})

test('HWNDはcanonical decimalかつInt64範囲だけを受理する', () => {
  for (const line of [
    'RIGHT_ALT 01 1 1',
    'RIGHT_ALT +1 1 1',
    'RIGHT_ALT -1 1 1',
    'RIGHT_ALT 0x1 1 1',
    'RIGHT_ALT 1.0 1 1',
    'RIGHT_ALT 1e1 1 1',
    'RIGHT_ALT 9223372036854775808 1 1',
    'RIGHT_ALT 99999999999999999999 1 1',
  ]) {
    expectUnknownHotkey(line)
  }
})

test('PIDとTIDはcanonical uint32だけを受理する', () => {
  for (const line of [
    'RIGHT_ALT 1 01 1',
    'RIGHT_ALT 1 1 01',
    'RIGHT_ALT 1 +1 1',
    'RIGHT_ALT 1 1 -1',
    'RIGHT_ALT 1 1.0 1',
    'RIGHT_ALT 1 1 1e1',
    'RIGHT_ALT 1 4294967296 1',
    'RIGHT_ALT 1 1 4294967296',
    'RIGHT_ALT 1 9007199254740991 1',
  ]) {
    expectUnknownHotkey(line)
  }
})

test('右Alt通知の不足・余分・制御文字を拒否する', () => {
  const bodySentinel = ['DICTATION', 'BODY', 'MUST', 'STAY', 'PRIVATE'].join('_')
  for (const line of [
    'RIGHT_ALT 1',
    'RIGHT_ALT 1 2',
    'RIGHT_ALT 1 2 3 4',
    'RIGHT_ALT  1 2 3',
    'RIGHT_ALT\t1\t2\t3',
    'RIGHT_ALT 1 2 3\nREADY',
    `RIGHT_ALT 1 2 3 ${bodySentinel}`,
  ]) {
    expectUnknownHotkey(line)
  }
})

test('貼り付け結果の固定statusを完全一致で解析する', () => {
  const cases = [
    ['PASTE_OK_RESTORED', { type: 'ok-restored' }],
    ['PASTE_OK_NOT_RESTORED', { type: 'ok-not-restored' }],
    ['PASTE_SKIPPED_INVALID_WINDOW', { type: 'skipped', reason: 'invalid-window' }],
    ['PASTE_SKIPPED_TARGET', { type: 'skipped', reason: 'target-changed' }],
    ['PASTE_SKIPPED_IDENTITY', { type: 'skipped', reason: 'identity-changed' }],
    ['PASTE_SKIPPED_SELF', { type: 'skipped', reason: 'self-process' }],
    ['PASTE_SKIPPED_MODIFIER', { type: 'skipped', reason: 'modifier-down' }],
    [
      'PASTE_SKIPPED_CLIPBOARD_CHANGED',
      { type: 'skipped', reason: 'clipboard-changed' },
    ],
    ['PASTE_CLIPBOARD_FAILED', { type: 'skipped', reason: 'clipboard-failed' }],
    ['PASTE_SELF_TEST_OK', { type: 'self-test-ok' }],
  ] as const

  for (const [line, expected] of cases) {
    assert.deepEqual(parsePasteStatusLine(line), expected)
  }
})

test('SendInput失敗は本文を含まない固定tokenだけを受理する', () => {
  assert.deepEqual(parsePasteStatusLine('PASTE_SEND_FAILED'), { type: 'send-failed' })
  for (const line of [
    'PASTE_SEND_FAILED 0',
    'PASTE_SEND_FAILED 00',
    'PASTE_SEND_FAILED +1',
    'PASTE_SEND_FAILED -1',
    'PASTE_SEND_FAILED 1.0',
    'PASTE_SEND_FAILED 4294967296',
    'PASTE_SEND_FAILED 1 2',
  ]) {
    expectRejectedPasteStatus(line)
  }
})

test('statusに本文・余分引数・類似tokenを混ぜられない', () => {
  const bodySentinel = ['DICTATION', 'BODY', 'MUST', 'STAY', 'PRIVATE'].join('_')
  for (const line of [
    '',
    'paste_ok_restored',
    'PASTE_OK_RESTORE',
    'PASTE_OK_RESTORED extra',
    ' PASTE_OK_RESTORED',
    'PASTE_OK_RESTORED ',
    'PASTE_OK_RESTORED\r\n',
    `PASTE_OK_RESTORED ${bodySentinel}`,
    'PASTE_OK_RESTORED\nPASTE_SELF_TEST_OK',
    'READY',
  ]) {
    expectRejectedPasteStatus(line)
  }
})

test('CRLFと分割chunkから完全なprotocol行だけを復元する', () => {
  const buffer = new LineBuffer()
  assert.deepEqual(buffer.push('RIGHT_ALT 9223372036854'), [])
  assert.deepEqual(buffer.push('775807 4294967295 4294967295\r'), [])
  assert.deepEqual(buffer.push('\nPASTE_OK_RES'), [
    'RIGHT_ALT 9223372036854775807 4294967295 4294967295',
  ])
  assert.deepEqual(buffer.push('TORED\r\nPASTE_SEND_FAILED 5\n'), [
    'PASTE_OK_RESTORED',
    'PASTE_SEND_FAILED 5',
  ])
  assert.deepEqual(buffer.flush(), [])
})

test('改行なしの末尾行はflush時だけ返す', () => {
  const buffer = new LineBuffer()
  assert.deepEqual(buffer.push('PASTE_SELF_'), [])
  assert.deepEqual(buffer.push('TEST_OK'), [])
  assert.deepEqual(buffer.flush(), ['PASTE_SELF_TEST_OK'])
  assert.deepEqual(buffer.flush(), [])
})

console.log(`\n全 ${passed} 件 通過`)
