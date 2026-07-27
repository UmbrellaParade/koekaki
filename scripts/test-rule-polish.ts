/**
 * ルールベース整形の動作確認。
 * 「消しすぎない」ことの確認が主目的なので、壊してはいけない語も検査する。
 *
 * 実行: node --experimental-strip-types scripts/test-rule-polish.ts
 */
import { rulePolish } from '../src/lib/rulePolish.ts'
import type { Mode } from '../src/lib/types.ts'

const standard: Mode = { id: 'standard', name: '標準', emoji: '✨', instruction: '' }
const notes: Mode = { id: 'notes', name: 'メモ', emoji: '📝', instruction: '' }

interface Case {
  label: string
  input: string
  mode?: Mode
  dictionary?: Array<{ term: string; wrong?: string }>
  /** 出力に含まれていてほしい文字列 */
  must?: string[]
  /** 出力に残っていてはいけない文字列 */
  mustNot?: string[]
  /** 独自の検査。問題があれば理由を返す */
  check?: (out: string) => string | null
}

const cases: Case[] = [
  {
    label: 'フィラー削除',
    input: 'えーと、あのー、明日の打ち合わせなんですけど、うーん、15時からでお願いします',
    must: ['明日の打ち合わせ', '15時からでお願いします'],
    mustNot: ['えーと', 'あのー', 'うーん'],
  },
  {
    label: '言い直しの整理',
    input: '14時からでお願いします。あ、違う、15時からでお願いします',
    must: ['15時'],
    mustNot: ['14時'],
  },
  {
    label: '言い詰まりの繰り返しをまとめる',
    input: 'ちょっと待ってちょっと待って、確認します',
    must: ['ちょっと待って', '確認します'],
  },
  {
    label: '正当な繰り返し語を壊さない（重要）',
    input: 'いろいろありますが、ますますよくなるし、だんだん慣れます。もしもし、いよいよですね',
    must: ['いろいろ', 'ますます', 'だんだん', 'もしもし', 'いよいよ'],
  },
  {
    label: '普通の「あの」「その」「なんか」を消さない',
    input: 'あの人がその資料を持っています。なんか変ですね',
    must: ['あの人', 'その資料', 'なんか変'],
  },
  {
    label: '文中の「まあ」を消さない（先頭のみ対象）',
    input: 'これはまあまあの出来です',
    must: ['まあまあの出来'],
  },
  {
    label: '接続語の前に句点を打つ',
    input: '資料を送りますそれでは確認をお願いします',
    must: ['送ります。それでは'],
  },
  {
    label: '「ますので」を誤って切らない',
    input: '明日送りますのでお待ちください',
    must: ['送りますのでお待ちください'],
    mustNot: ['送ります。ので'],
  },
  {
    label: '末尾に句点を補う',
    input: '確認しました',
    must: ['確認しました。'],
  },
  {
    label: '箇条書きモード',
    input: '資料を作ります。会議室を予約します。参加者に連絡します。',
    mode: notes,
    must: ['- 資料を作ります', '- 会議室を予約します', '- 参加者に連絡します'],
  },
  {
    label: '空入力',
    input: '   ',
    must: [],
  },
  {
    label: '組み込み辞書：カタカナの製品名をアルファベットに直す',
    input: 'えーと、ジェミニとクロードとギットハブを使っています',
    must: ['Gemini', 'Claude', 'GitHub'],
    mustNot: ['ジェミニ', 'クロード', 'ギットハブ'],
  },
  {
    label: '組み込み辞書：一般語を巻き込まない',
    input: 'カーソルをズームして、ブレンダーで混ぜます',
    must: ['カーソル', 'ズーム', 'ブレンダー'],
  },
  {
    label: 'スマホで起きた「同じ文の羅列」を1つにまとめる',
    input: '今精度を確かめています今精度を確かめています今精度を確かめています',
    must: ['精度を確かめています'],
    check: (out) => {
      const count = out.split('精度を確かめています').length - 1
      return count === 1 ? null : `${count} 回残っている`
    },
  },
  {
    label: '句点区切りで羅列された場合もまとめる',
    input: '精度を確かめています。精度を確かめています。精度を確かめています。',
    check: (out) => {
      const count = out.split('精度を確かめています').length - 1
      return count === 1 ? null : `${count} 回残っている`
    },
  },
  {
    label: '似ているだけの別の文は残す',
    input: '資料を送ります。資料を確認します。',
    must: ['資料を送ります', '資料を確認します'],
  },
  {
    label: 'ユーザー辞書が効く',
    input: 'アンブレラパレードの新曲です',
    dictionary: [{ term: 'Umbrella Parade', wrong: 'アンブレラパレード' }],
    must: ['Umbrella Parade'],
    mustNot: ['アンブレラパレード'],
  },
]

let failed = 0
for (const c of cases) {
  const out = rulePolish(c.input, c.mode ?? standard, {
    dictionary: c.dictionary ?? [],
    useBuiltinTerms: true,
  })
  const problems: string[] = []
  for (const m of c.must ?? []) if (!out.includes(m)) problems.push(`欠落: "${m}"`)
  for (const m of c.mustNot ?? []) if (out.includes(m)) problems.push(`残存: "${m}"`)
  const custom = c.check?.(out)
  if (custom) problems.push(custom)

  if (problems.length === 0) {
    console.log(`  OK   ${c.label}`)
    console.log(`       ${JSON.stringify(out)}`)
  } else {
    failed++
    console.log(`  FAIL ${c.label}`)
    console.log(`       in : ${JSON.stringify(c.input)}`)
    console.log(`       out: ${JSON.stringify(out)}`)
    for (const p of problems) console.log(`       -> ${p}`)
  }
}

console.log(failed === 0 ? `\n全 ${cases.length} 件 通過` : `\n${failed} / ${cases.length} 件 失敗`)
process.exit(failed === 0 ? 0 : 1)
