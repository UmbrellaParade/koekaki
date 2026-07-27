/**
 * 同じ文が羅列されてしまったときの後始末。
 *
 * 本来の原因（Web Speech API の結果の数え方）は providers/webspeech.ts で直しているが、
 * 音声認識まわりは端末ごとの癖が強く、別の形で重複が出る可能性がある。
 * 出力の直前でもう一度ならしておく。
 */

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
  return collapseAdjacentSentences(collapseWholeRepeat(text))
}
