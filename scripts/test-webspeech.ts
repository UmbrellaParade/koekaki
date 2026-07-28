/**
 * WebSpeechTranscriber の結果の数え方を検証する。
 *
 * スマホで「同じ文が何度も羅列される」不具合が出た。原因は、
 * onresult の results が「そのセッションの全結果」を持つ累積リストなのに、
 * resultIndex から先だけを足し込んでいたこと。
 * Android Chrome は resultIndex が 0 のまま来ることがあり、
 * コールバックのたびに全文を再加算していた。
 *
 * 実機を用意できないので、その挙動をここで再現して守る。
 *
 * 実行: node --experimental-strip-types scripts/test-webspeech.ts
 */

interface FakeResult {
  isFinal: boolean
  0: { transcript: string }
  length: number
}

type Handler = ((e: unknown) => void) | null

/** テストから結果を流し込める、最小限の SpeechRecognition もどき */
class FakeRecognition {
  static latest: FakeRecognition | null = null
  static startFailuresRemaining = 0

  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 1
  onresult: Handler = null
  onerror: Handler = null
  onend: (() => void) | null = null
  started = 0
  aborted = 0

  constructor() {
    FakeRecognition.latest = this
  }

  start() {
    if (FakeRecognition.startFailuresRemaining > 0) {
      FakeRecognition.startFailuresRemaining--
      const error = new Error('再開できません')
      error.name = 'InvalidStateError'
      throw error
    }
    this.started++
  }

  stop() {
    this.onend?.()
  }

  abort() {
    this.aborted++
  }

  /** 認識結果を配信する。resultIndex は端末の癖を再現するために指定できる。 */
  emit(transcripts: Array<{ text: string; final: boolean }>, resultIndex: number) {
    const results: Record<number, FakeResult> & { length: number } = { length: transcripts.length }
    transcripts.forEach((t, i) => {
      results[i] = { isFinal: t.final, 0: { transcript: t.text }, length: 1 }
    })
    this.onresult?.({ resultIndex, results })
  }

  emitError(error: string) {
    this.onerror?.({ error })
  }
}

const visibilityListeners = new Set<() => void>()
const pageHideListeners = new Set<() => void>()
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener(type: string, listener: () => void) {
    if (type === 'visibilitychange') visibilityListeners.add(listener)
  },
  removeEventListener(type: string, listener: () => void) {
    if (type === 'visibilitychange') visibilityListeners.delete(listener)
  },
}

// window / document の見た目だけ用意する（constructor探索と背面遷移の検証用）
;(globalThis as unknown as { window: unknown }).window = {
  webkitSpeechRecognition: FakeRecognition,
  addEventListener(type: string, listener: () => void) {
    if (type === 'pagehide') pageHideListeners.add(listener)
  },
  removeEventListener(type: string, listener: () => void) {
    if (type === 'pagehide') pageHideListeners.delete(listener)
  },
}
;(globalThis as unknown as { document: unknown }).document = fakeDocument

const { WebSpeechTranscriber } = await import('../src/lib/providers/webspeech.ts')

let failed = 0
function check(label: string, actual: string, expected: string) {
  if (actual === expected) {
    console.log(`  OK   ${label}`)
    console.log(`       ${JSON.stringify(actual)}`)
  } else {
    failed++
    console.log(`  FAIL ${label}`)
    console.log(`       期待: ${JSON.stringify(expected)}`)
    console.log(`       実際: ${JSON.stringify(actual)}`)
  }
}

// --- 1. Android Chrome の癖: resultIndex がいつも 0 ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP')
  const rec = FakeRecognition.latest!
  // 同じ確定結果を、累積リストごと何度も配信してくる
  rec.emit([{ text: '今、精度を確かめています', final: true }], 0)
  rec.emit([{ text: '今、精度を確かめています', final: true }], 0)
  rec.emit([{ text: '今、精度を確かめています', final: true }], 0)
  check('resultIndex が 0 のまま繰り返されても1回分になる', await t.stop(), '今、精度を確かめています')
}

// --- 2. 通常のブラウザ: resultIndex が進み、文が増えていく ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP')
  const rec = FakeRecognition.latest!
  rec.emit([{ text: 'おはようございます', final: true }], 0)
  rec.emit(
    [
      { text: 'おはようございます', final: true },
      { text: '今日はいい天気ですね', final: true },
    ],
    1,
  )
  check('複数の確定結果が正しく連結される', await t.stop(), 'おはようございます今日はいい天気ですね')
}

// --- 3. 未確定（interim）は確定分の後ろに一度だけ付く ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP')
  const rec = FakeRecognition.latest!
  rec.emit(
    [
      { text: '確定した文です', final: true },
      { text: 'まだ途中', final: false },
    ],
    0,
  )
  rec.emit(
    [
      { text: '確定した文です', final: true },
      { text: 'まだ途中の文', final: false },
    ],
    0,
  )
  check('未確定分が重複しない', await t.stop(), '確定した文ですまだ途中の文')
}

// --- 4. セッションが切れて再開しても、前半が消えない ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP')
  const rec = FakeRecognition.latest!
  rec.emit([{ text: '前半の内容です', final: true }], 0)
  // Chrome は無音が続くと勝手に終了して再開する
  rec.onend?.()
  rec.emit([{ text: '後半の内容です', final: true }], 0)
  check('セッションをまたいでも連結される', await t.stop(), '前半の内容です後半の内容です')
}

// --- 5. スマホ向け区切り認識: 短い無音で終わっても録音を継続する ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP', true)
  const rec = FakeRecognition.latest!
  const startedAtBegin = rec.started

  if (rec.continuous) {
    failed++
    console.log('  FAIL スマホ向け認識は1回ずつ区切る')
  } else {
    console.log('  OK   スマホ向け認識は1回ずつ区切る')
  }

  rec.emit([{ text: '少し考えます', final: true }], 0)
  rec.onend?.() // ブラウザが短い無音を検知して、この区切りを終了

  await new Promise((r) => setTimeout(r, 600)) // 再開猶予より長く待つ

  if (rec.started === startedAtBegin + 1) {
    console.log('  OK   短い無音のあと自動で認識を再開する')
  } else {
    failed++
    console.log(`  FAIL 短い無音のあと1回だけ再開する（実際 ${rec.started - startedAtBegin} 回）`)
  }

  rec.emit([{ text: '続きを話します', final: true }], 0)
  check('無音の前後を1回の録音としてつなぐ', await t.stop(), '少し考えます続きを話します')
}

// --- 6. 実機で出た羅列の形が、最終出力でならされる ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP')
  const rec = FakeRecognition.latest!
  // 同じ確定文が繰り返し積まれていく最悪のパターン
  for (let i = 0; i < 7; i++) {
    rec.emit([{ text: '今 制度のチェックしてます', final: true }], 0)
    rec.onend?.()
    await new Promise((r) => setTimeout(r, 5))
  }
  const out = await t.stop()
  const count = out.split('制度のチェックしてます').length - 1
  if (count === 1) {
    console.log('  OK   セッションが何度切れても1回分に収まる')
    console.log(`       ${JSON.stringify(out)}`)
  } else {
    failed++
    console.log(`  FAIL セッションが何度切れても1回分に収まる（${count} 回残った）`)
    console.log(`       ${JSON.stringify(out)}`)
  }
}

// --- 7. 回復不能なエラーは再開を繰り返さず、Appへ1回だけ知らせる ---
{
  let unavailable = 0
  const t = new WebSpeechTranscriber({ onUnavailable: () => unavailable++ })
  t.start('ja-JP', true)
  const rec = FakeRecognition.latest!
  const startedAtBegin = rec.started

  rec.emit([{ text: 'ここまでは聞き取れました', final: true }], 0)
  rec.emitError('audio-capture')
  rec.onend?.()
  await new Promise((r) => setTimeout(r, 20))

  if (unavailable === 1) {
    console.log('  OK   回復不能なエラーをAppへ1回だけ通知する')
  } else {
    failed++
    console.log(`  FAIL 回復不能なエラー通知は1回（実際 ${unavailable} 回）`)
  }

  await new Promise((r) => setTimeout(r, 500))
  if (rec.started === startedAtBegin) {
    console.log('  OK   回復不能なエラーでは再開しない')
  } else {
    failed++
    console.log(`  FAIL 回復不能なエラー後に再開しない（実際 ${rec.started - startedAtBegin} 回）`)
  }

  if (t.getTerminalError() === 'audio-capture') {
    console.log('  OK   途中まで文字があっても中断理由を保持する')
  } else {
    failed++
    console.log(`  FAIL 中断理由を保持する（実際 ${JSON.stringify(t.getTerminalError())}）`)
  }
  check('中断までに聞き取れた文字は失わない', await t.stop(), 'ここまでは聞き取れました')
}

// --- 8. 一時的な start() 失敗は有限リトライで回復する ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP', true)
  const rec = FakeRecognition.latest!
  const startedAtBegin = rec.started
  FakeRecognition.startFailuresRemaining = 1

  rec.emit([{ text: '前半です', final: true }], 0)
  rec.onend?.()
  await new Promise((r) => setTimeout(r, 1000))

  if (rec.started === startedAtBegin + 1) {
    console.log('  OK   再開の一時失敗後にリトライして復帰する')
  } else {
    failed++
    console.log(`  FAIL 再開の一時失敗後に1回復帰する（実際 ${rec.started - startedAtBegin} 回）`)
  }
  await t.stop()
}

// --- 9. 再開待ちの間に取消したら、マイクを取り直さない ---
{
  const t = new WebSpeechTranscriber()
  t.start('ja-JP', true)
  const rec = FakeRecognition.latest!
  const startedAtBegin = rec.started
  rec.onend?.()
  t.cancel()
  await new Promise((r) => setTimeout(r, 500))

  if (rec.started === startedAtBegin) {
    console.log('  OK   取消後は予約済みの再開を実行しない')
  } else {
    failed++
    console.log(`  FAIL 取消後に再開しない（実際 ${rec.started - startedAtBegin} 回）`)
  }
}

// --- 10. PWAを背面へ移したら、マイクを止めて勝手に再取得しない ---
{
  let unavailable = 0
  const t = new WebSpeechTranscriber({ onUnavailable: () => unavailable++ })
  t.start('ja-JP', true)
  const rec = FakeRecognition.latest!
  rec.emit([{ text: '背面へ移る前の内容です', final: true }], 0)

  fakeDocument.visibilityState = 'hidden'
  visibilityListeners.forEach((listener) => listener())
  await new Promise((r) => setTimeout(r, 20))

  if (rec.aborted === 1) {
    console.log('  OK   背面へ移ると稼働中の認識器を停止する')
  } else {
    failed++
    console.log(`  FAIL 背面移行時のabortは1回（実際 ${rec.aborted} 回）`)
  }
  if (unavailable === 1) {
    console.log('  OK   背面移行をAppへ1回だけ通知する')
  } else {
    failed++
    console.log(`  FAIL 背面移行通知は1回（実際 ${unavailable} 回）`)
  }
  if (t.getTerminalError() === 'backgrounded') {
    console.log('  OK   背面移行の中断理由を保持する')
  } else {
    failed++
    console.log(`  FAIL 背面移行理由を保持する（実際 ${JSON.stringify(t.getTerminalError())}）`)
  }
  check('背面へ移る前に聞き取れた文字は失わない', await t.stop(), '背面へ移る前の内容です')
  fakeDocument.visibilityState = 'visible'
}

console.log(failed === 0 ? '\n全 18 件 通過' : `\n${failed} 件 失敗`)
process.exit(failed === 0 ? 0 : 1)
