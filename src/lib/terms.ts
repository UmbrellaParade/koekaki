/**
 * 組み込み辞書。
 *
 * 音声認識は「Gemini」を「ジェミニ」、「Claude」を「クロード」のように
 * カタカナで返してくる。日本語の技術文脈ではアルファベット表記が普通なので、
 * よく使う名前だけ最初から登録しておく。
 *
 * 収録の基準は「カタカナ表記が別の一般語とぶつからないもの」だけ。
 * 例えば「ズーム」（拡大の意味がある）→ Zoom や、
 * 「カーソル」（画面上のカーソル）→ Cursor、
 * 「ブレンダー」（調理器具）→ Blender は、誤って置き換える危険があるので入れない。
 * 「ユーチューブ」「インスタグラム」のように、カタカナ表記自体が日本語として
 * 定着しているものも対象外にしている。
 */

export interface BuiltinTerm {
  /** 正しい表記 */
  term: string
  /** 音声認識が返しがちなカタカナ表記 */
  spoken: string[]
}

export const BUILTIN_TERMS: BuiltinTerm[] = [
  // --- AI / モデル ---
  { term: 'Gemini', spoken: ['ジェミニ', 'ジェミナイ', 'ジェミニー', 'ジェミナイト'] },
  { term: 'Claude', spoken: ['クロード', 'クロウド', 'クロド'] },
  { term: 'ChatGPT', spoken: ['チャットGPT', 'チャットジーピーティー', 'チャットジピティ'] },
  { term: 'OpenAI', spoken: ['オープンAI', 'オープンエーアイ', 'オープンエイアイ'] },
  { term: 'Anthropic', spoken: ['アンソロピック', 'アンスロピック', 'アントロピック'] },
  { term: 'Copilot', spoken: ['コパイロット', 'コーパイロット'] },
  { term: 'Midjourney', spoken: ['ミッドジャーニー'] },
  { term: 'Stable Diffusion', spoken: ['ステーブルディフュージョン', 'ステイブルディフュージョン'] },

  // --- 開発 ---
  { term: 'GitHub', spoken: ['ギットハブ', 'ギッハブ', 'ギットハフ'] },
  { term: 'Git', spoken: ['ギット'] },
  { term: 'Python', spoken: ['パイソン'] },
  { term: 'JavaScript', spoken: ['ジャバスクリプト', 'ジャヴァスクリプト'] },
  { term: 'TypeScript', spoken: ['タイプスクリプト'] },
  { term: 'Node.js', spoken: ['ノードジェイエス', 'ノードJS'] },
  { term: 'npm', spoken: ['エヌピーエム'] },
  { term: 'Docker', spoken: ['ドッカー', 'ドッカ'] },
  { term: 'Linux', spoken: ['リナックス'] },
  { term: 'Ubuntu', spoken: ['ウブントゥ', 'ウブンツ'] },
  { term: 'API', spoken: ['エーピーアイ'] },
  { term: 'VPS', spoken: ['ブイピーエス'] },
  { term: 'HTML', spoken: ['エイチティーエムエル'] },
  { term: 'CSS', spoken: ['シーエスエス'] },
  { term: 'PWA', spoken: ['ピーダブリューエー'] },

  // --- サービス / ツール ---
  { term: 'Slack', spoken: ['スラック'] },
  { term: 'Notion', spoken: ['ノーション'] },
  { term: 'Figma', spoken: ['フィグマ'] },
  { term: 'Canva', spoken: ['キャンバ'] },
  { term: 'Discord', spoken: ['ディスコード'] },
  { term: 'Obsidian', spoken: ['オブシディアン'] },
  { term: 'WordPress', spoken: ['ワードプレス'] },
  { term: 'Shopify', spoken: ['ショッピファイ'] },
  { term: 'Stripe', spoken: ['ストライプ決済'] },
  { term: 'Kindle', spoken: ['キンドル'] },
  { term: 'Suno', spoken: ['スノ', 'スーノ'] },
  { term: 'Roblox', spoken: ['ロブロックス'] },
  { term: 'Unity', spoken: ['ユニティ'] },
  { term: 'Premiere Pro', spoken: ['プレミアプロ'] },
  { term: 'Photoshop', spoken: ['フォトショップ'] },
  { term: 'Illustrator', spoken: ['イラストレーター'] },
]

/** プロンプトに載せる用の1行リスト */
export function builtinTermsPromptBlock(): string {
  const lines = BUILTIN_TERMS.map((t) => `- ${t.spoken.join('／')} → ${t.term}`)
  return `

# 表記のきまり（製品名・技術用語）
音声認識はサービス名や技術用語をカタカナで返してきます。日本語の文章としては
アルファベット表記が正しいので、次のように直してください。
${lines.join('\n')}

上に無い製品名・企業名・サービス名も、一般にアルファベットで書かれるものは
アルファベットに直してください。ただし「ユーチューブ」「インスタグラム」のように
カタカナ表記が日本語として定着しているものは、そのままで構いません。`
}

/**
 * ルールベース整形用の、文字列としての置き換え。
 * AI を使わない経路ではこれが唯一の手段になる。
 */
export function applyTermReplacements(text: string, useBuiltin: boolean, userTerms: Array<{ term: string; wrong?: string }>): string {
  let out = text

  // ユーザー辞書を先に当てる（組み込みより優先させたいので後勝ちを避ける）
  for (const entry of userTerms) {
    const term = entry.term.trim()
    if (!term) continue
    const variants = (entry.wrong ?? '')
      .split(/[,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
    for (const v of variants) {
      out = out.split(v).join(term)
    }
  }

  if (useBuiltin) {
    for (const t of BUILTIN_TERMS) {
      for (const spoken of t.spoken) {
        out = out.split(spoken).join(t.term)
      }
    }
  }

  return out
}
