/**
 * 同じ文が羅列されてしまったときの後始末。
 *
 * 本来の原因（Web Speech API の結果の数え方）は providers/webspeech.ts で直しているが、
 * 端末ごとの癖が強く、別の形で重複が出ることがある。実機で確認できない以上、
 * 出力の直前で必ずならしておく。
 *
 * 方針は「明らかに繰り返しと言い切れるものだけ潰す」。
 * 日本語には「いろいろ」「ますます」「そうそう」のように、
 * 繰り返しでできた正当な語があるので、そこを壊さない境界を引いている。
 */

/** 安全に処理できる長さの上限。これを超えたら正規表現を走らせない */
const MAX_LENGTH = 20000

/**
 * 繰り返された塊を1つにまとめる。
 *
 * 境界の決め方:
 * - 6文字以上の塊が2回以上 → 潰す（この長さの語がそのまま重なるのは、まず不具合）
 * - 3〜5文字の塊が3回以上 → 潰す（2回だけだと「わかるわかる」のような強調を壊す）
 * - 同じ1文字が3回以上   → 潰す（「今今今」など）
 *
 * 2文字の塊は対象外。「いろいろ」「ますます」「もしもし」「だんだん」を守るため。
 */
export function collapseRepeatedUnits(text: string): string {
  if (!text || text.length > MAX_LENGTH) return text
  return text
    .replace(/(.{6,120}?)\1+/g, '$1')
    .replace(/(.{3,5}?)\1{2,}/g, '$1')
    .replace(/(.)\1{2,}/g, '$1')
}

/** 文字列全体がひとつの単位の繰り返しなら、1回分に縮める */
function collapseWholeRepeat(text: string): string {
  const n = text.length
  if (n < 6) return text

  for (let unit = 3; unit <= Math.floor(n / 2); unit++) {
    if (n % unit !== 0) continue
    const head = text.slice(0, unit)
    let allSame = true
    for (let i = unit; i < n; i += unit) {
      if (text.slice(i, i + unit) !== head) {
        allSame = false
        break
      }
    }
    if (allSame) return head
  }
  return text
}

/** 隣り合う同じ文を1つにまとめる */
function collapseAdjacentSentences(text: string): string {
  // 区切り文字は残したいので、後読みで分割する
  const parts = text.split(/(?<=[。！？\n])/)
  const kept: string[] = []
  for (const part of parts) {
    const key = part.trim().replace(/[。！？\s]+$/, '')
    if (!key) {
      kept.push(part)
      continue
    }
    const prev = kept.length > 0 ? kept[kept.length - 1].trim().replace(/[。！？\s]+$/, '') : null
    if (prev === key) continue
    kept.push(part)
  }
  return kept.join('')
}

export function collapseRepeatedSegments(text: string): string {
  if (!text) return text
  // 単位の繰り返し → 全体の繰り返し → 文単位、の順に粗くしていく
  return collapseAdjacentSentences(collapseWholeRepeat(collapseRepeatedUnits(text)))
}

/**
 * すでに持っている文字列の末尾と重なる分を落としてから、chunk をつなぐ。
 *
 * 音声認識のセッションが切れて再開したとき、直前に確定した内容を
 * もう一度返してくる端末があるため。
 */
export function appendWithoutOverlap(base: string, chunk: string): string {
  if (!chunk) return base
  if (!base) return chunk

  // 丸ごと同じものが続いた場合
  if (base.endsWith(chunk)) return base

  // 末尾と先頭が重なっている場合は、重なった分だけ削って足す
  const max = Math.min(base.length, chunk.length)
  for (let len = max; len >= 4; len--) {
    if (base.slice(-len) === chunk.slice(0, len)) {
      return base + chunk.slice(len)
    }
  }
  return base + chunk
}
