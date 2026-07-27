import type { Mode } from './types'

/**
 * API キーを使わない、ルールベースの簡易整形。
 *
 * ブラウザ内蔵の音声認識と組み合わせれば、キーなし・費用ゼロでアプリが完結する。
 * AI 整形には遠く及ばないので、方針は「壊さないこと」に振っている。
 * 判断に迷うケースは手を付けない（消しすぎるより残しすぎる方がマシ）。
 */

/**
 * 単語として別の意味を持ちえない、ほぼ確実にフィラーな表現だけを並べている。
 * 「あの」「その」「まあ」「なんか」は普通の語としても使われるため、
 * 伸ばし棒が付いた形や重複した形だけを対象にする。
 */
const FILLERS = [
  'えーと',
  'えーっと',
  'えっと',
  'ええと',
  'えぇと',
  'えー',
  'えぇ',
  'あのー',
  'あのう',
  'あんのー',
  'そのー',
  'そのう',
  'うーん',
  'うーむ',
  'んーと',
  'んー',
  'あー',
  'あぁ',
  'おー',
  'まーその',
  'なんかその',
]

/**
 * 話し始めに限って落とせる語。文中では意味を持つので触らない。
 * さらに、直後に区切り（読点か空白）があることを必須にしている。
 * 「あの人が…」の「あの」を消してしまう事故を防ぐため。
 */
const LEADING_FILLERS = ['まあ', 'ま', 'あの', 'えっ']

/** 明確な言い直しの合図。これがあれば、同じ文の前半は捨ててよい。 */
const CORRECTION_MARKERS = [
  'あ、?違う',
  'あ、?間違えた',
  'あ、?間違い',
  'ごめん、?違う',
  'すみません、?違う',
  '訂正します',
  'じゃなくて、?ごめん',
]

/** 前に句点を打つべき、文の切り替わりを示す接続語 */
const CONJUNCTIONS = [
  'それで',
  'そして',
  'それから',
  'でも',
  'しかし',
  'ですが',
  'だから',
  'なので',
  'ただ',
  'あと',
  'また',
  '次に',
  'とりあえず',
  'ちなみに',
  'つまり',
]

/** 文末になりうる語尾 */
const SENTENCE_ENDS = [
  'ました',
  'ません',
  'でした',
  'ください',
  'でしょう',
  'ですね',
  'ますね',
  'ですよ',
  'ますよ',
  'します',
  'ます',
  'です',
]

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 表記のばらつきを先にそろえる */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

function removeFillers(text: string): string {
  let out = text
  // 長いものから消さないと「えーと」が「えー」+「と」に割れる
  const sorted = [...FILLERS].sort((a, b) => b.length - a.length)
  for (const f of sorted) {
    out = out.replace(new RegExp(`${escape(f)}、?`, 'g'), '')
  }
  for (const f of LEADING_FILLERS) {
    out = out.replace(new RegExp(`^${escape(f)}(?:、|\\s)\\s*`), '')
  }
  return out
}

/**
 * 直後に同じ文字列が続く「言い詰まり」をひとつにまとめる。
 * 3文字以上に限定しているのは、「いろいろ」「ますます」「もしもし」「だんだん」など
 * 2文字の繰り返しでできた正当な語を壊さないため。
 */
function collapseRepeats(text: string): string {
  let out = text.replace(/(.{3,12}?)(?:、?\1)+/g, '$1')
  // 「私は私は」のような助詞込みの繰り返しも、区切りをまたぐ形で1回だけ試す
  out = out.replace(/(.{3,10}?)、\1/g, '$1')
  return out
}

/**
 * 言い直しの合図が見つかったら、合図より前を捨てる。
 * 合図が文頭に来ている場合は、言い間違いは直前の文そのものなので、そちらを落とす。
 */
function applyCorrections(text: string): string {
  const markerSrc = `(?:${CORRECTION_MARKERS.join('|')})、?`
  const kept: string[] = []

  for (const sentence of text.split(/(?<=[。\n])/)) {
    const matches = [...sentence.matchAll(new RegExp(markerSrc, 'g'))]
    if (matches.length === 0) {
      kept.push(sentence)
      continue
    }
    const last = matches[matches.length - 1]
    const at = last.index ?? 0
    const before = sentence.slice(0, at)
    const after = sentence.slice(at + last[0].length)

    // 合図より前に中身が無い = 言い間違いは前の文
    if (!before.replace(/[、。\s]/g, '') && kept.length > 0) kept.pop()
    kept.push(after)
  }

  return kept.join('')
}

/**
 * 句点を補う。文末語尾 + 接続語 の並びだけを対象にする。
 * 「〜ますので」のように文が続いている場合を誤って切らないための制限。
 */
function addPunctuation(text: string): string {
  let out = text
  const ends = SENTENCE_ENDS.map(escape).join('|')
  const conj = CONJUNCTIONS.map(escape).join('|')
  out = out.replace(new RegExp(`(${ends})(?=(?:${conj}))`, 'g'), '$1。')

  // 全体の末尾が語尾で終わっていて句点が無ければ足す
  if (new RegExp(`(?:${ends})$`).test(out)) out += '。'
  return out
}

function finalTidy(text: string): string {
  return text
    .replace(/、{2,}/g, '、')
    .replace(/。{2,}/g, '。')
    .replace(/^[、。\s]+/gm, '')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 箇条書きモード用。句点で切って行頭に「- 」を付ける。 */
function toBullets(text: string): string {
  return text
    .split(/(?<=。)|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line.replace(/。$/, '')}`)
    .join('\n')
}

/** ルールベース整形が意味を持つモードかどうか（それ以外は素の整形だけ行う） */
export function ruleModeSupported(modeId: string): boolean {
  return modeId === 'standard' || modeId === 'raw' || modeId === 'notes'
}

export function rulePolish(text: string, mode: Mode): string {
  if (!text.trim()) return ''

  let out = normalize(text)
  out = removeFillers(out)
  out = collapseRepeats(out)
  out = applyCorrections(out)
  out = addPunctuation(out)
  out = finalTidy(out)

  if (mode.id === 'notes') out = toBullets(out)
  return out
}
