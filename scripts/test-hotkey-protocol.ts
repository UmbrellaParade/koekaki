import assert from 'node:assert/strict'
import { LineBuffer, parseHotkeyLine } from '../electron/hotkeyProtocol.ts'

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

test('CRLF区切りの複数メッセージを分離する', () => {
  const buffer = new LineBuffer()
  assert.deepEqual(buffer.push('READY\r\nRIGHT_ALT\r\n'), ['READY', 'RIGHT_ALT'])
})

test('チャンク途中で分かれたメッセージを復元する', () => {
  const buffer = new LineBuffer()
  assert.deepEqual(buffer.push('REA'), [])
  assert.deepEqual(buffer.push('DY\r\nRIGHT_'), ['READY'])
  assert.deepEqual(buffer.push('ALT\r\n'), ['RIGHT_ALT'])
})

test('改行なしの末尾メッセージをflushで取り出す', () => {
  const buffer = new LineBuffer()
  assert.deepEqual(buffer.push('SELF_TEST_OK'), [])
  assert.deepEqual(buffer.flush(), ['SELF_TEST_OK'])
})

test('既知のプロトコル行を分類する', () => {
  assert.deepEqual(parseHotkeyLine(' READY '), { type: 'ready' })
  assert.deepEqual(parseHotkeyLine('RIGHT_ALT'), { type: 'right-alt' })
  assert.deepEqual(parseHotkeyLine('SELF_TEST_OK'), { type: 'self-test-ok' })
})

test('空行を無視し、不明な行を識別する', () => {
  assert.equal(parseHotkeyLine('  '), null)
  assert.deepEqual(parseHotkeyLine('OTHER'), { type: 'unknown', line: 'OTHER' })
})

console.log(`\n全 ${passed} 件 通過`)
