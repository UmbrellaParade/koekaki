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

  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 1
  onresult: Handler = null
  onerror: Handler = null
  onend: (() => void) | null = null
  started = 0

  constructor() {
    FakeRecognition.latest = this
  }

  start() {
    this.started++
  }

  stop() {
    this.onend?.()
  }

  abort() {}

  /** 認識結果を配信する。resultIndex は端末の癖を再現するために指定できる。 */
  emit(transcripts: Array<{ text: string; final: boolean }>, resultIndex: number) {
    const results: Record<number, FakeResult> & { length: number } = { length: transcripts.length }
    transcripts.forEach((t, i) => {
      results[i] = { isFinal: t.final, 0: { transcript: t.text }, length: 1 }
    })
    this.onresult?.({ resultIndex, results })
  }
}

// window の見た目だけ用意する（getCtor が window から探すため）
;(globalThis as unknown as { window: unknown }).window = {
  webkitSpeechRecognition: FakeRecognition,
}

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

console.log(failed === 0 ? '\n全 4 件 通過' : `\n${failed} 件 失敗`)
process.exit(failed === 0 ? 0 : 1)
