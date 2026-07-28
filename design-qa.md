# 録音バー Design QA

## Evidence

- 状態: `recording`、ライト表示
- 参照: 依頼主提供の Typeless 録音中スクリーンショット
  - 原寸: 576 × 1280 px
  - SHA-256: `4ba7069ec031cb5fc09bec23c34bd4005582fece9af5bcb035846afcda69d969`
  - 全体比較 crop: `(0, 698, 576, 500)`
  - 波形比較 crop: `(138, 808, 300, 300)`
- 実装 capture:
  - CSS: 420 × 92 px
  - PNG: 420 × 92 px
  - display scale factor: 1
  - SHA-256: `c6db7903a074550953e1798eb038ebcb6db31616ed0d63b207f4ae5cc2d64027`
- 最終 contact sheet SHA-256:
  `6ae0b71def06b9ceefcae064c007b785008a93adb2fdfd3c5b3e9cc4ed0492f4`
- capture と contact sheet は、依頼主の画面を公開リポジトリへ残さないため
  OS の一時フォルダーだけで作成・比較した。

## Intentional adaptation

モバイルの下部シートをそのまま縮小せず、デスクトップで入力先を守る表示専用バーへ変換した。

- 維持したもの:
  - パネル `#F1F1F1`
  - ハロー `#E6E6E6`
  - 黒い芯 `#131313`
  - 白い波形
  - 芯とハローの比率（参照約 0.779、実装 56 / 72 = 0.778）
  - 短い終了案内と、静かで低刺激な見た目
- 意図的に変えたもの:
  - 縦長のタッチ操作面から 420 × 92 DIP の横長バーへ変更
  - 巨大な中央ボタンを、左側の表示専用アイコンへ変更
  - 「もう一度タップ」を「もう一度 右Alt で終了」へ変更
  - Typeless の名称を「こえかき」へ変更
  - 閉じるボタン、タイマー、認識途中の文章、操作ボタンを置かない
  - `focusable: false`、`showInactive()`、クリック透過にして入力先を奪わない

## Findings

### Font

- 既存の日本語フォントスタックを再利用している。
- ブランド 12 px、状態文 16 px。4状態とも折返し、切れ、三点リーダー化なし。
- `#656565` のブランドと `#151515` の本文は、明るいパネル上で判読できる。

### Spacing and shape

- 420 × 92 DIP、ハロー 72 px、芯 56 px。
- `72px minmax(0, 1fr) 72px` の3列で、アイコンを左に置きながら文言中心を
  バー全体の x = 210 に合わせた。
- 角丸、境界線、影は92 px内に収まり、切れや黒い縁はない。

### Color and icon quality

- 参照の主要3色を実装値へそのまま反映した。
- 波形は手書きSVGやCSS描画ではなく、MITライセンスの
  `@phosphor-icons/react` の `Waveform` を使用した。
- 420 × 92の原寸captureで、ぼけ、欠け、不要なalpha縁は見られない。

### Copy and states

- `starting`: 「マイクを準備しています…」
- `recording`: 「もう一度 右Alt で終了」
- `transcribing`: 「文字にしています…」
- `polishing`: 「文章を整えています…」
- `idle` と `error` ではバーを非表示にする。
- バーへ送る情報は上記4状態だけで、本文、APIキー、音声、request IDは送らない。

### Interaction, accessibility, and resilience

- 表示は `showInactive()`、ウィンドウはフォーカス不可・クリック透過・タスクバー非表示。
- カーソルがあるディスプレイの作業領域下端から24 DIP上に配置する。
- `role="status"` と `aria-live="polite"` を持ち、動きを減らすOS設定にも従う。
- visual self-test は固定の録音状態だけを描画し、マイク、右Altフック、
  `SendInput`、クリップボード、API通信を実行しない。

## Comparison history

1. iteration 1
   - P2: 文言群が左に寄り、参照色と芯・ハロー比率に小さな差があった。
   - 修正: 色を参照値へ統一し、72 / 56の比率へ変更。文言を中央寄せした。
2. iteration 2
   - P2: 残り領域内の中央寄せにより、アイコンと文言の間が広く見えた。
   - 修正: 左右対称の3列gridで、文言中心をバー全体の中央へ移した。
3. iteration 3
   - 同一contact sheetで全景と波形detailを再比較。
   - P0 / P1 / P2なし。

## Open questions

- 実マイク利用中に元のアプリがフォーカスを保つことは、依頼主の実機確認が必要。
- 125% / 150% DPI と複数モニターの物理表示は、境界計算と自動検査は済んでいるが
  実ディスプレイでの最終確認が必要。

## Follow-up polish

- 参照とPhosphorでは波形の棒の並びがわずかに異なるが、実アイコンライブラリを使う
  制約と小サイズでの明瞭さを優先し、P3として許容した。

final result: passed
