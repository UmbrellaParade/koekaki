# こえかき — 引き継ぎ書（Codex 向け）

このドキュメントだけを読んで作業を続けられるように書いています。
**まず全部読んでから手を動かしてください。** 特に「踏んだ地雷」の章は、
同じ失敗を繰り返さないための記録です。

作成日: 2026-07-28 / 引き継ぎ元: Claude (Claude Code)

---

## 1. これは何か

**こえかき（Koekaki）** — 話し言葉を「そのまま使える文章」に整える音声入力 Web アプリ（PWA）。
Typeless / Wispr Flow の代替を、**月額課金なし**で実現するのが目的。

- 公開URL: https://umbrellaparade.github.io/koekaki/
- 紹介ページ: https://umbrellaparade.github.io/koekaki/lp.html
- GitHub: https://github.com/UmbrellaParade/koekaki （public / All rights reserved）

### 作業場所

| 用途 | パス |
|---|---|
| **作業リポジトリ（ここで開発する）** | `C:\Users\myabe\Documents\koekaki` |
| バックアップ（編集しない） | `C:\Users\myabe\OneDrive\Desktop\Obsidian Folder\Umbrella Parade\koekaki-backup` |

作業リポジトリを OneDrive の外に置いているのは、`node_modules` の同期で壊れるのを避けるため。
**Obsidian 側は `git archive` で書き出したバックアップです。そちらを編集しないでください。**

バックアップの更新コマンド（コミット後に実行）:

```bash
cd /c/Users/myabe/Documents/koekaki && git archive --format=tar HEAD | tar -x -C "/c/Users/myabe/OneDrive/Desktop/Obsidian Folder/Umbrella Parade/koekaki-backup"
```

---

## 2. 依頼主について（重要）

- 日本語で会話します。**回答も日本語で。**
- 個人開発者。Umbrella Parade という音楽・小説の IP を運営しています。
- **月額課金を強く嫌います。** このアプリを作った動機がまさにそれ。
  継続課金が発生する設計を勝手に選ばないこと。運用費ゼロの構成を先に検討する。
- 将来このアプリを**販売したい**意向があります。品質は「動けばいい」ではなく製品水準で。
- Claude のクレジットが尽きたため Codex へ引き継ぎ。**追加のクレジット購入はしない方針。**

---

## 3. 技術構成

```
Vite 6 + React 19 + TypeScript（素の CSS、UI ライブラリなし）
デプロイ: main へ push → GitHub Actions → GitHub Pages（自動）
サーバー: 無し。完全な静的サイト。
```

**中継サーバーを持たない**のが設計の芯です。音声もテキストも、
利用者のブラウザから各 AI 社の API へ直接飛びます（BYOK = 各自が自分のキーを入れる）。
3社ともブラウザから直接叩けることは実機確認済み（CORS 疎通OK）。

### ディレクトリ

```
src/
├── App.tsx                  画面全体の制御（録音の開始/停止、状態管理）
├── lib/
│   ├── recorder.ts          MediaRecorder + 音量計測 + 無音検出
│   ├── audio.ts             webm/mp4 → 16kHz モノラル WAV 変換
│   ├── prompts.ts           整形プロンプトと組み込みモード定義 ★品質の核
│   ├── rulePolish.ts        APIキー不要のルールベース整形
│   ├── dedupe.ts            重複（同じ文の羅列）の除去
│   ├── terms.ts             組み込み辞書（ジェミニ→Gemini など）
│   ├── pipeline.ts          文字起こし → 整形 の制御
│   ├── cost.ts              概算コスト（料金改定時はここだけ直す）
│   ├── storage.ts           設定（localStorage）
│   ├── db.ts                履歴（IndexedDB）
│   ├── types.ts             型定義
│   └── providers/
│       ├── gemini.ts        音声も直接扱える。モデル一覧取得あり
│       ├── openai.ts        Whisper系 + chat completions
│       ├── anthropic.ts     整形のみ（Claude は音声非対応）
│       └── webspeech.ts     ブラウザ内蔵の音声認識（無料・キー不要）
└── components/              UI
```

### コマンド

```bash
npm install
npm run dev      # http://localhost:5173/koekaki/  ← 末尾の /koekaki/ が必要
npm run build
npm test         # ルール整形と音声認識の回帰テスト（22件）
```

`npm test` は Node の型ストリップ（`--experimental-strip-types`）で TS を直接実行します。
このため **`src/lib` の値インポートは拡張子 `.ts` を明示**しています（Node の ESM 解決は省略不可）。
また **TypeScript のパラメータプロパティ構文は使えません**（`constructor(private x: T)` が動かない）。

---

## 4. 動作の流れ

1. マイクを押す → 録音開始
2. もう一度押す → 停止
3. 文字起こし → 整形 → 結果表示
4. 「コピー」で貼り付け

### エンジンの組み合わせ

設定で「文字起こし」と「整形」を別々に選べます。

| 文字起こし | 整形 | 費用 | 備考 |
|---|---|---|---|
| ブラウザ内蔵 | 簡易（rules） | **0円・キー不要** | Chrome / Edge のみ。精度は低い |
| Gemini | Gemini | 無料枠内なら0円 | **既定。同じモデルなら1リクエストで完結する高速経路** |
| OpenAI | OpenAI | 従量 | 文字起こし精度が高い |
| 任意 | Claude | 従量 | Claude は音声非対応なので整形専用 |

**高速経路**: 文字起こしと整形が両方 Gemini で、かつ**モデル名が一致**していると、
`geminiCombined()` が音声から `{raw, polished}` を1回のリクエストで取ります。
モデルが違うと2回に分かれます（`pipeline.ts` の冒頭を参照）。

---

## 5. 踏んだ地雷（同じ失敗を繰り返さないために）

### 5-1. Gemini は WebM を受け付けない

`MediaRecorder` は Chrome で `audio/webm;codecs=opus` を吐きますが、
Gemini の `inline_data` は WebM を公式サポートしていません。
**必ず `blobToWav16k()` で 16kHz モノラル WAV に変換してから送ること**（`audio.ts`）。
OpenAI は WebM をそのまま受けるので変換しません。

### 5-2. ブラウザ内蔵の音声認識と MediaRecorder を同時に使わない

同じマイクを2つの仕組みで掴むと、Chrome で認識結果が空になります。
`webspeech` を使うときは `MediaRecorder` を起動しない実装になっています（`App.tsx` の `startRecording`）。
音量メーターが取れないので、リングは CSS の脈打ちアニメーションで代替しています。

### 5-3. Web Speech API の results は「累積リスト」

**これが一番厄介でした。** `onresult` の `e.results` はそのセッションの全結果を含みます。
`e.resultIndex` から先だけを足し込むと、**Android Chrome では `resultIndex` が 0 のまま来る**ため、
コールバックのたびに全文を再加算して同じ文が何十回も並びます。

対策（`providers/webspeech.ts`）:
- 毎回 `results` の先頭から組み立て直す（何度呼ばれても同じ結果になる）
- セッションをまたぐ分だけ `committedText` に積む
- 再接続時は `appendWithoutOverlap()` で重なりを除いてから連結
- 終了→再開の連打を 400ms 抑制

実機が用意できないので `scripts/test-webspeech.ts` で Android の挙動を模擬しています。
**このテストを壊さないでください。**

### 5-4. 重複除去の境界

日本語には「いろいろ」「ますます」「もしもし」「だんだん」など、
繰り返しでできた**正当な語**があります。素朴に繰り返しを潰すとこれらが壊れます。
`dedupe.ts` の境界は実機のバグ報告を受けて調整した結果なので、
**変更する場合は必ず `npm test` で確認してください。**

- 6文字以上が2回以上 → 潰す
- 3〜5文字が3回以上 → 潰す
- 同じ1文字が3回以上 → 潰す
- **2文字の塊は対象外**（ここを緩めると「いろいろ」が「いろ」になる）

### 5-5. スマホの API キー入力

以下をやらないと入力できません。実際に「登録できない」と報告がありました。

- `type="password"` を使わない（パスワードマネージャの候補バーが被る）→ CSS の `-webkit-text-security` で伏せ字に
- `autoCapitalize="none"` `autoCorrect="off"`（先頭が大文字化されるとキーが壊れる）
- 入力欄の `font-size` を 16px 以上に（iOS が勝手に拡大する）
- viewport に `interactive-widget=resizes-content`（キーボードで欄が隠れる）

### 5-6. キーを入れたのに使えない、という行き止まり

キーを入れた provider と、エンジンの選択が連動していなかったため、
「OpenAI のキーを入れたのに Gemini のキーが無いと言われる」状態が起きました。

対策:
- `SettingsSheet` の `setKey()` が、キー未設定のエンジンを入れた provider に向け直す
- 画面上部の `ConfigBanner` が、その場で直せるボタンを出す
- **マイクを押した瞬間に設定画面へ飛ばさない**（何を直せばいいか分からなくなる）

### 5-7. 使えない機能を黙って隠さない

内蔵音声認識に非対応のブラウザで「キーなしで無料で使う」ボタンを非表示にしていたら、
「無料で使う選択肢が存在しない」と受け取られました。
**押せないなら、押せない理由と対処を必ず画面に出すこと。**

### 5-8. PowerShell スクリプトは ASCII で書く

Windows PowerShell は BOM 無しの `.ps1` を ANSI として読むため、
日本語コメントが化けて構文エラーになります（`scripts/make-icons.ps1` で発生）。

---

## 6. 現在の状態

### 動作確認済み

- ビルド・デプロイ（GitHub Actions 自動）
- PWA（manifest / Service Worker / アイコン / インストール可能）
- 3社の API 疎通（公開URLからの CORS、認証エラーの取り回し）
- 録音 → 16kHz WAV 変換（合成音声で実ブラウザ検証）
- ルール整形 18件・音声認識 4件の回帰テスト
- スマホ幅（375px）での表示崩れなし、ダーク/ライト両対応

### 未確認・要検証

- **実マイクを使った通し動作**（引き継ぎ元の環境にマイクが無かったため未検証）
- **羅列バグの実機での解消**（2026-07-28 に修正を deploy 済み。依頼主に確認依頼中）
- AI 整形の実出力品質（API キーが無く未実行）

### 依頼主から出ている改善要望

1. **デスクトップ常駐版（最優先・着手前）** — 後述
2. Web 検索モード（「調べる」）— 未着手。OpenAI / Gemini とも検索ツールがあるので実装は可能
3. 英語 UI — 未着手

---

## 7. 次のタスク：デスクトップ常駐版

依頼主が一番望んでいる機能です。**「どのアプリでも右 Alt を押すと録音が始まり、
もう一度押すと停止して、カーソル位置に整形済みテキストが直接入る」**。

現在の Web 版の右 Alt は、こえかきの画面が前面にあるときしか効きません。

### 調査済みの前提

- この PC に **Rust も Visual Studio Build Tools も無い** → **Tauri は使えない**
- **Electron を使う**（プリビルドバイナリなのでコンパイラ不要）
- Node.js 24.15 / npm 11.12 は導入済み
- **Electron の `globalShortcut` は右 Alt のような修飾キー単独を登録できない**
  → Windows の低レベルキーボードフック（`WH_KEYBOARD_LL`）が必要
- **PowerShell の `Add-Type` は .NET Framework 同梱の C# コンパイラを使うため、
  追加インストール無しで C# を実行時コンパイルできる。**
  ここでフックと `SendInput`（Ctrl+V の送出）を実装するのが、依存を増やさない道。
- 全部無料。唯一お金がかかる可能性があるのは**コード署名証明書**（年2〜4万円）。
  無くても動くが Windows が「発行元不明」の警告を出す。**配布・販売する段階まで不要。**

### 想定する構成

```
electron/
├── main.ts         トレイ常駐、ウィンドウ管理、ホットキー受信、クリップボード、貼り付け指示
├── preload.ts      レンダラへの橋渡し
├── hotkey.ps1      C# の WH_KEYBOARD_LL フック。右Alt検出を stdout に出力。
│                   SendInput で Ctrl+V も送る
└── renderer/       録音 + 既存の src/lib をそのまま利用
```

**既存の `src/lib`（プロンプト・各社API・整形・辞書）はそのまま再利用できます。**
ゼロから作る必要はありません。ブラウザ API に依存しているのは `recorder.ts` と
`audio.ts` ですが、Electron のレンダラプロセスでは同じものが使えます。

### 注意点

- オーバーレイ表示は**フォーカスを奪わないこと**（`focusable: false`）。
  奪うと貼り付け先のアプリからフォーカスが外れ、Ctrl+V が別の場所に飛びます。
- 貼り付け前に、元のクリップボード内容を退避して後で戻すと親切です。
- 依頼主の環境にマイクがあるので、**最終確認は依頼主に実機で試してもらってください。**

---

## 8. 作業のルール

1. **編集したら必ずコミット & プッシュ。** GitHub Pages が公開版なので、
   プッシュしないと依頼主が確認できません。
2. **プッシュ後、Obsidian 側のバックアップも更新**（第1章のコマンド）。
3. **`npm test` を通してからコミット。** 特に `dedupe.ts` `rulePolish.ts`
   `webspeech.ts` を触ったときは必須。
4. **コミットメッセージは日本語で、「なぜそうしたか」を書く。**
   既存の履歴に合わせてください。
5. **実機確認が必要なものは、確認できていないと正直に伝える。**
   「できました」と言い切らない。
6. デプロイ確認: `gh run watch` で Actions の成否を見る。数十秒で終わります。
7. スマホ側は Service Worker のキャッシュがあるため、
   **依頼主には「一度閉じて開き直してください」と伝える**こと。

---

## 9. 用語メモ

| 語 | 意味 |
|---|---|
| BYOK | Bring Your Own Key。利用者が自分の API キーを入れる方式 |
| 高速経路 | Gemini で音声→整形を1リクエストにまとめる処理（`geminiCombined`） |
| 簡易整形 / rules | API を使わない、端末内のルールベース整形 |
| キーなし構成 | 文字起こし=ブラウザ内蔵 + 整形=簡易。完全無料 |
