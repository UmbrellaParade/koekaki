# こえかき — 引き継ぎ書（Codex 向け）

このドキュメントだけを読んで作業を続けられるように書いています。
**まず全部読んでから手を動かしてください。**

特に **第5章「不具合の直し方」** と **第6章「踏んだ地雷」** は、
実際に何度も失敗して得た手順です。ここを飛ばすと同じ失敗を繰り返します。

- 作成: 2026-07-28 / 引き継ぎ元: Claude (Claude Code)
- 引き継ぎ理由: Claude のクレジット上限。**依頼主は追加クレジットを購入しない方針。**

---

## 1. これは何か

**こえかき（Koekaki）** — 話し言葉を「そのまま使える文章」に整える音声入力 Web アプリ（PWA）。
Typeless / Wispr Flow の代替を、**月額課金なし**で実現するのが目的。

| | |
|---|---|
| 公開URL（アプリ） | https://umbrellaparade.github.io/koekaki/ |
| 公開URL（紹介ページ） | https://umbrellaparade.github.io/koekaki/lp.html |
| GitHub | https://github.com/UmbrellaParade/koekaki （public / All rights reserved） |
| **作業リポジトリ** | `C:\Users\myabe\Documents\koekaki` |
| バックアップ（編集禁止） | `C:\Users\myabe\OneDrive\Desktop\Obsidian Folder\Umbrella Parade\koekaki-backup` |

作業リポジトリを OneDrive の外に置いているのは、`node_modules` の同期で壊れるのを避けるため。
Obsidian 側は `git archive` で書き出したコピーです。**そちらを編集しないでください。**

---

## 2. 依頼主について

- **日本語で会話します。回答も日本語で。**
- 個人開発者。Umbrella Parade という音楽・小説の IP を運営。
- **月額課金を強く嫌います。** このアプリを作った動機がそれ。
  継続課金が発生する設計を勝手に選ばないこと。運用費ゼロの構成を先に検討する。
- 将来このアプリを**販売したい**意向がある。品質は製品水準で。
- **実機（Android スマホ）を持っているのは依頼主だけです。**
  あなたの環境にマイクは無く、ブラウザのプレビューでもマイクはブロックされます。
  音声の通し確認は必ず依頼主に依頼してください。
- スクリーンショットを快く送ってくれます。**画面の状態が知りたいときは遠慮なく頼むこと。**
  （ただし画面共有・遠隔操作の許可は断られています。スクリーンショットで足ります）

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
├── main.tsx                 起動 + Service Worker の更新確認
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

scripts/
├── make-icons.ps1           PWA アイコン生成
├── test-rule-polish.ts      ルール整形の回帰テスト（18件）
├── test-webspeech.ts        音声認識の回帰テスト（18件）
├── test-hotkey-protocol.ts  ホットキー行プロトコルのテスト（5件）
├── test-paste-protocol.ts   貼り付け対象・固定status・改行プロトコルのテスト（10件）
└── test-desktop.ts          デスクトップの状態・IPC・URL・録音バー・APIキー保存検証（21件）
```

### コマンド

```bash
npm install
npm run dev      # http://localhost:5173/koekaki/  ← 末尾の /koekaki/ が必要
npm run build
npm run build:desktop
npm run typecheck
npm test         # 72件（Web回帰36 + ホットキー5 + 貼り付け10 + デスクトップ21）
npm run test:paste # Ctrl+V用INPUT構造の自己テスト。実際のキー入力は送らない
```

`npm test` は Node の型ストリップ（`--experimental-strip-types`）で TS を直接実行します。この制約から:

- **`src/lib` の値インポートは拡張子 `.ts` を明示**（Node の ESM 解決は省略不可）
- **TypeScript のパラメータプロパティ構文は使えない**（`constructor(private x: T)` が動かない）

---

## 4. 動作の流れ

1. マイクを押す（または右 Alt / Space長押し）→ 録音開始
2. もう一度押す → 停止
3. 文字起こし → 整形 → 結果表示
4. 「コピー」で貼り付け

### エンジンの組み合わせ

| 文字起こし | 整形 | 費用 | 備考 |
|---|---|---|---|
| ブラウザ内蔵 | 簡易（rules） | **0円・キー不要** | Chrome / Edge のみ。精度は低い |
| Gemini | Gemini | 無料枠内なら0円 | **既定。モデル名が一致すると1リクエストで完結する高速経路** |
| OpenAI | OpenAI | 従量 | 文字起こし精度が高い |
| 任意 | Claude | 従量 | Claude は音声非対応なので整形専用 |

**高速経路**: 文字起こしと整形が両方 Gemini で、かつ**モデル名が一致**していると、
`geminiCombined()` が音声から `{raw, polished}` を1リクエストで取ります（`pipeline.ts` 冒頭）。

### スマホでの認識方式（重要）

スマホでは**区切り継続モード**で動きます。`continuous = false` の短い認識を使いますが、
短い無音でブラウザが `onend` を返しても、ユーザーが停止するまでは自動で次を開始します。
PC では `continuous = true`。判定は `prefersSegmentedRecognition()`（`providers/webspeech.ts`）です。

Android の連続認識は同じ内容を何度も返すことがあります。そのためスマホを
`continuous = true` へ戻さず、各区切りの `results` を毎回組み立て直し、
`appendWithoutOverlap()` と最終段の `collapseRepeatedSegments()` で重複を防ぎます。
再開時の `start()` 失敗は有限回だけ再試行し、権限拒否・マイク取得不能・非対応言語、
またはネットワーク再試行上限では `onUnavailable` からAppの停止処理へ戻します。
途中まで文字が取れている場合も中断理由を保持し、「ここまでの内容だけを処理する」と表示します。
停止・取消時は予約済みの再開タイマーを先に解除します。
画面が背面へ移った場合は認識器を停止して勝手なマイク再取得を防ぎ、手動停止時は
稼働中の認識器だけ `onend` を待ちます。応答しない場合は1.5秒を上限に `abort()` します。

---

## 5. 不具合の直し方（この順番で）

依頼主から不具合の報告を受けたときの手順です。**今回この順番を守らずに3回失敗しました。**

### 手順1. まず「どの版で起きているか」を確認する

**コードを疑う前にキャッシュを疑ってください。**
ホーム画面に追加した PWA は、アプリを完全終了しても Service Worker が古いコードを配り続けます。

依頼主に伝えること:

> 設定画面（歯車）を開いて一番下までスクロールし、「この端末で動いている版」の日時を教えてください。

公開中の版数は、こちらで確認できます:

```bash
JS=$(curl -s "https://umbrellaparade.github.io/koekaki/?nocache=$(date +%s)" | grep -o '/koekaki/assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -s "https://umbrellaparade.github.io$JS" | grep -o '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]' | head -1
```

**日時が一致しないなら、その報告は古い版の症状です。** 直す前に「最新版に更新」を押してもらうこと。

### 手順2. 報告された文字列を、そのままテストに入れる

依頼主はスクリーンショットで実際の出力を送ってくれます。
**その文字列をコピーして、テストケースとして追加してから直す。**

これで「13文字の繰り返し単位が、12文字上限の除去処理をすり抜けていた」という
原因を、推測ではなく事実として特定できました。

一時的に確かめたいだけなら、`scripts/tmp/` に使い捨てのスクリプトを置いて
`node --experimental-strip-types scripts/tmp/chk.ts` で実行し、あとで消してください。
（リポジトリのルート外に置くと相対インポートが解決できません）

### 手順3. 2回直して駄目なら、推測をやめて計測する

3回目の推測はしないこと。設定画面の一番下に「**診断ログをコピー**」があります。
音声認識が実際に何を返したかが記録されるので、依頼主に一度録音してから
これを押して貼り付けてもらってください。

記録している内容は `providers/webspeech.ts` の `record()` 付近。
足りない情報があれば項目を増やしてよいです。

### 手順4. 症状ではなく仕組みを直す

羅列バグでは、重複除去の条件をいじる（症状への対処）ことを繰り返して失敗し、
最終的に**スマホで連続認識をやめる**（仕組みの変更）ことで解決しました。

同じ不具合に2回対処したら、「そもそもこの仕組みが必要か」を疑ってください。

### 手順5. 直したら必ずテストを足す

再発防止です。特に `dedupe.ts` `rulePolish.ts` `webspeech.ts` を触ったら必須。
実機が無い領域は、`scripts/test-webspeech.ts` のように**端末の挙動を模擬する**
（`FakeRecognition` クラス）方法が取れます。

### 手順6. 依頼主に確認を頼むときの伝え方

- **「直りました」と言い切らない。** 実機で確認できていないなら、そう書く
- 「一度閉じて開き直してください」だけでは不十分。**版数の確認を頼む**
- 何をどう直したかを1〜2文で説明する（依頼主は技術的な説明を歓迎します）

---

## 6. 踏んだ地雷

### 6-1. インストール済み PWA は勝手に更新されない（最重要）

同じ不具合を3回「直した」のに実機で消えず、原因は結局これでした。
Android はアプリを閉じてもプロセスを保持するため、
利用者が「開き直した」と言っていても更新されていません。

対策として入れてあるもの:
- 設定画面の一番下に**ビルド日時を表示**（`vite.config.ts` の `define` で埋め込み）
- 「最新版に更新」ボタン（SW とキャッシュを捨てて読み込み直す）
- 画面に戻るたびに `registration.update()`、`controllerchange` で自動再読込（`main.tsx`）

### 6-2. Web Speech API の results は「累積リスト」

`onresult` の `e.results` はそのセッションの全結果を含みます。
`e.resultIndex` から先だけを足し込むと、**Android Chrome では `resultIndex` が 0 のまま来る**ため、
コールバックのたびに全文を再加算して同じ文が何十回も並びます。

現在の実装は毎回 `results` の先頭から組み立て直しています（何度呼ばれても同じ結果になる）。
セッションをまたぐ分だけ `committedText` に積み、再接続時は `appendWithoutOverlap()` で
重なりを除いてから連結します。

### 6-3. 重複除去の境界

日本語には「いろいろ」「ますます」「もしもし」「だんだん」など、
繰り返しでできた**正当な語**があります。素朴に潰すとこれらが壊れます。
`dedupe.ts` の境界は実機の報告を受けて調整した結果です:

- 6文字以上が2回以上 → 潰す
- 3〜5文字が3回以上 → 潰す
- 同じ1文字が3回以上 → 潰す
- **2文字の塊は対象外**（ここを緩めると「いろいろ」が「いろ」になる）

### 6-4. Gemini は WebM を受け付けない

`MediaRecorder` は Chrome で `audio/webm;codecs=opus` を吐きますが、
Gemini の `inline_data` は WebM を公式サポートしていません。
**必ず `blobToWav16k()` で 16kHz モノラル WAV に変換してから送ること**（`audio.ts`）。
OpenAI は WebM をそのまま受けるので変換しません。

### 6-5. 内蔵音声認識と MediaRecorder を同時に使わない

同じマイクを2つの仕組みで掴むと、Chrome で認識結果が空になります。
`webspeech` を使うときは `MediaRecorder` を起動しない実装です（`App.tsx` の `startRecording`）。
音量が取れないので、リングは CSS の脈打ちアニメーションで代替しています。

### 6-6. 認識途中の文字は画面に出さない

途中経過は同じ語が並んだり書き換わったりして必ず乱れます。
最終出力が正しくても、途中が汚いと利用者は「壊れている」と感じます。
Apple のディクテーションが途中を出さないのはこのため。
既定では出さず「声を拾っています」だけ伝えます（設定で変更可）。

### 6-7. スマホの API キー入力

以下をやらないと入力できません。実際に「登録できない」と報告がありました。

- `type="password"` を使わない（パスワードマネージャの候補バーが被る）
  → CSS の `-webkit-text-security` で伏せ字に
- `autoCapitalize="none"` `autoCorrect="off"`（先頭が大文字化されるとキーが壊れる）
- 入力欄の `font-size` を 16px 以上に（iOS が入力時に拡大する）
- viewport に `interactive-widget=resizes-content`（キーボードで欄が隠れる）

### 6-8. 「キーを入れたのに使えない」行き止まり

キーを入れた provider とエンジンの選択が連動しておらず、
「OpenAI のキーを入れたのに Gemini のキーが無いと言われる」状態が起きました。

- `SettingsSheet` の `setKey()` が、キー未設定のエンジンを入れた provider に向け直す
- 画面上部の `ConfigBanner` が、その場で直せるボタンを出す
- **マイクを押した瞬間に設定画面へ飛ばさない**（何を直せばいいか分からなくなる）

### 6-9. 使えない機能を黙って隠さない

内蔵音声認識に非対応のブラウザで「キーなしで無料で使う」ボタンを非表示にしていたら、
「無料で使う選択肢が存在しない」と受け取られました。
**押せないなら、押せない理由と対処を必ず画面に出すこと。**

### 6-10. 沈黙で終わらせない

認識結果が空のとき何も表示せず終了していたため、「押しても無反応」に見えていました。
**どの経路でも、失敗したら必ず理由を出すこと。**

### 6-11. PowerShell スクリプトは ASCII で書く

Windows PowerShell は BOM 無しの `.ps1` を ANSI として読むため、
日本語コメントが化けて構文エラーになります（`scripts/make-icons.ps1` で発生）。

---

## 7. 現在の状態

### 確認済み

- ビルド・デプロイ（GitHub Actions 自動）
- PWA（manifest / Service Worker / アイコン / インストール可能）
- 3社の API 疎通（公開URLからの CORS、認証エラーの取り回し）
- 録音 → 16kHz WAV 変換（合成音声で実ブラウザ検証）
- 回帰テスト72件（ルール整形18 + 音声認識18 + ホットキープロトコル5 + 貼り付けプロトコル10 + デスクトップ21）
- Electronの安全な専用URL、sandboxed preload、非表示controllerの自己テスト
- Ctrl+V用 `INPUT` 構造、対象照合、修飾キー判定の自己テスト（実キー送信なし）
- 表示専用録音バーの4状態、隔離bridge、非フォーカスwindow、位置、captureの自己テスト
- 依頼主提供画像と録音バーcaptureを同じcontact sheetで比較し、Design QAを通過
- デスクトップ版ではAPIキーを `safeStorage` で暗号化し、Web版の保存領域と分離
- スマホ幅（375px）での表示崩れなし、ダーク/ライト両対応
- **実機（Android）で羅列バグの解消と、APIキー入力の復旧を依頼主が確認済み**
- Android音声専用IMEのソース、初回設定導線、安全な入力先照合、14件のJVMテスト、APK生成CI

### 未確認

- **デスクトップ版の実マイク → AI 整形 → 実アプリへのCtrl+V**の通し動作
- 実際の右Altで取得した入力先、主要アプリへの貼り付け、クリップボード復元の実機動作
- AI 整形（Gemini / OpenAI / Claude）の実出力品質
- 短い無音のあとも区切り継続できることと、重複しないことのAndroid実機確認
- Android IMEのAPKインストール、端末マイク、Codex / Claude / LINEへの直接挿入、普段のIMEへの復帰
- iOS Safari での動作全般

### 依頼主から出ている要望

1. **デスクトップ常駐版（最優先・5段階のコードと視覚QA完了、実機確認待ち）** — 第8章
2. **Android音声専用IME（技術実証とAPK生成CIまで実装、実機確認待ち）** — 第9章と `docs/mobile-input.md`
3. Web 検索モード（「調べる」）— 未着手。OpenAI / Gemini とも検索ツールがあり実装は可能
4. 英語 UI — 未着手

---

## 8. 次のタスク：デスクトップ常駐版

依頼主が一番望んでいる機能です。**Typeless とほぼ同じものを、というのが要望。**

### 現在の進捗

- [x] `hotkey.ps1` 単体で右 Alt を検出し、合成入力で自己テスト
- [x] Electron からフックを起動し、右 Alt のトグルを受信
- [x] トレイ常駐 + 録音 + 既存 `src/lib` で整形してクリップボードへ
- [x] Ctrl+V の送出でカーソル位置へ挿入（コード・安全な自己テストまで。実アプリは未確認）
- [x] 参考画像に合わせてボイスバーを仕上げる（コード・capture比較・視覚QAまで。実機は未確認）

段階2では、親Electronが異常終了した場合にPowerShell側もフックを解除して終了する監視、
AltGr等で困ったときの「ホットキーを一時停止」、CRLF・分割チャンク対応の受信処理まで実装済みです。
このPCではApplication ControlがElectron付属のZIP展開モジュールを拒否するため、
`npm run install:electron-binary` で公式ZIPのSHA-256を照合してWindows標準機能で展開します。

段階3では、既存React画面を常時ロードされた非表示controller兼設定画面として再利用します。
本番rendererは `koekaki://app/` の専用originで配信し、PWAのService Workerは読み込みません。
右Altの開始から完成までUUIDで同じ録音を追跡し、過去の追記結果ではなく今回分だけを
Electronへ渡してクリップボードへ保存します。デスクトップのAPIキーはWeb版と共有せず、
Windowsの `safeStorage` で暗号化します。

段階4では、録音開始側の右Altを押した時点で、前面トップレベルウィンドウの
HWND / PID / TID を記録します。停止側の右Altでは入力先を上書きしません。
整形完了時に同じHWND・PID・TIDが前面にあることを再確認し、
Ctrl / Shift / Alt / Win が押されていない場合だけ `SendInput` でCtrl+Vを送ります。

対象の変更、ウィンドウIDの不一致、修飾キー押下、クリップボード競合、
`SendInput` の失敗を検出した場合は自動貼り付けしません。
対象不一致・修飾キー押下・送信失敗では、可能な限り整形文をクリップボードに残し、
クリップボードが別の操作で更新された場合はユーザー側の新しい内容を優先します。

元のクリップボードは、Unicode / ANSI / OEMテキスト、テキストのロケール情報、
HTML、RTF、ファイル一覧を同じ排他区間で完全に退避でき、貼り付け中に
変更されていない場合だけbest effortで復元します。画像などの未対応形式、
大きすぎるデータ、読み出せない形式が含まれる場合は復元せず、本文を残します。

入力先の照合単位はトップレベルウィンドウです。同じウィンドウ内でタブや入力欄だけが
変わった場合は検出できないため、貼り付け完了までは同じ入力欄にカーソルを置く必要があります。

段階5では、420 × 92 DIPの録音バーをcontrollerとは別の `BrowserWindow` で実装しました。
`showInactive()`、`focusable: false`、`setIgnoreMouseEvents(true)` により、
表示時も元の入力先へフォーカスやクリックを移しません。カーソルがあるディスプレイの
作業領域下端から24 DIP上へ表示し、`idle` / `error` では非表示にします。

録音バーは非永続の専用partitionと専用preloadを使い、受信できるのは
`starting` / `recording` / `transcribing` / `polishing` の4状態だけです。
本文、音声、APIキー、request ID、クリップボード操作、送信IPCは公開しません。
波形にはMITライセンスの `@phosphor-icons/react` を使い、追加の月額費用はありません。
依頼主提供画像との3回の比較と判定は `design-qa.md` に記録しています。

### 再現対象（公式ドキュメントで確認済み）

| 項目 | 仕様 |
|---|---|
| Windows の既定ホットキー | **右 Alt** |
| 動作 | **トグル**（1回押して開始、もう1回押して終了。押しっぱなしではない） |
| 開始時のフィードバック | 効果音 ＋ 画面上に「ボイスバー」を表示 |
| 前提条件 | **カーソルがテキスト入力欄に入っていること** |
| 挿入方法 | 整形を済ませてから、カーソル位置に直接挿入 |
| 挿入前のプレビュー | 無し |

出典: https://www.typeless.com/help/quickstart/first-dictation

**ボイスバーの参考画像は依頼主から受領し、デスクトップ向け実装へ反映済みです。**
設定画面は依頼主側でも場所が分からなかったため、追加で探してもらう必要はありません。
モバイル下部シートの主要色・二重円・波形・終了案内を維持し、
フォーカスを奪わない横長の表示専用バーへ適応しました。

### 技術的な前提（調査済み）

- この PC に **Rust も Visual Studio Build Tools も無い** → **Tauri は使えない**
- **Electron を使う**（プリビルドバイナリなのでコンパイラ不要）
- Node.js 24.15 / npm 11.12 は導入済み
- **Electron の `globalShortcut` は右 Alt のような修飾キー単独を登録できない**
  → Windows の低レベルキーボードフック（`WH_KEYBOARD_LL`）が必要
- **PowerShell の `Add-Type` は .NET Framework 同梱の C# コンパイラを使うため、
  追加インストール無しで C# を実行時コンパイルできる。**
  ここでフックと `SendInput`（Ctrl+V の送出）を実装するのが、依存を増やさない道
- 費用は**すべて無料**。唯一かかりうるのはコード署名証明書（年2〜4万円）だが、
  無くても動く（Windows が「発行元不明」と警告するだけ）。**配布・販売する段階まで不要。**

### 想定する構成

```
electron/
├── main.mts        トレイ常駐、ウィンドウ管理、ホットキー受信、
│                   クリップボード、貼り付け指示
├── preload.cts     レンダラへの橋渡し
├── hotkey.ps1      C# の WH_KEYBOARD_LL フック。右Alt検出を stdout に出力。
│                   SendInput で Ctrl+V も送る（ASCII で書くこと。6-11 参照）
└── renderer/       録音 + 既存の src/lib をそのまま利用
```

**既存の `src/lib`（プロンプト・各社API・整形・辞書・設定）はそのまま再利用できます。**
ゼロから作る必要はありません。ブラウザ API に依存しているのは `recorder.ts` と
`audio.ts` ですが、Electron のレンダラプロセスでは同じものが使えます。

### 実装上の注意

- オーバーレイは**フォーカスを絶対に奪わないこと**（`focusable: false`）。
  奪うと貼り付け先のアプリからフォーカスが外れ、Ctrl+V が別の場所に飛びます
- 元のクリップボードは、主要形式を完全に退避でき、処理中に変更されていない場合だけ
  best effort で復元します。未対応形式の完全復元は約束しません
- 右 Alt を押した瞬間に録音を開始すること（体感の遅れを作らない）
- **最終確認は依頼主に実機で試してもらうこと**（あなたの環境にマイクは無い）

### 進め方の提案

一度に全部作らず、この順で動くものを刻んでください。依頼主が途中経過を確認できます。

1. `hotkey.ps1` 単体で右 Alt を検出し、標準出力に出せることを確認
   （自分で `SendInput` して自分のフックで拾う自己テストが書けます）
2. Electron から `hotkey.ps1` を起動し、右 Alt のトグルを受け取る
3. トレイ常駐 + 録音 + 既存 `src/lib` で整形して、結果をクリップボードへ
4. Ctrl+V の送出でカーソル位置へ挿入
   （コード・自動テスト完了。実マイクと実アプリへの貼り付けは未確認）
5. ボイスバーの見た目を整える
   （コード・自動capture・参照画像との視覚QA完了。実機でのフォーカス維持は未確認）

---

## 9. 次のタスク：スマホ版の標準キーボード連携

仕様と公式資料は [`docs/mobile-input.md`](docs/mobile-input.md) にまとめてあります。

- 実装の本命はAndroidネイティブの `InputMethodService`
- こえかきは音声専用とし、独自の文字キー配列・顔文字パネルを作らない
- `いつものキーボード` を常に見える位置に置き、直前のIMEへ戻す
- Typelessのように設定場所が不明にならないよう、IME面とランチャーの両方から設定を開けるようにする
- iOS Keyboard Extensionは公開仕様上マイクを使えないため、同等機能を約束しない
- PWAは自アプリ内で標準キーボードを使い、他アプリへはコピー／共有で渡す

### 現在の進捗

- [x] `android/` にJava 17 / minSdk 28の `InputMethodService` を追加
- [x] 端末の `SpeechRecognizer` を短い区切りで再開する音声入力（無音60秒、全体10分で安全停止）
- [x] 区切り境界の重複を除き、最終文だけを `InputConnection.commitText()` で1回挿入
- [x] 開始時の `InputConnection` と入力セッションを保持し、変更時・接続切れ時は破棄
- [x] password variation / `TYPE_NULL` の無効化、取消・IME非表示・設定移動時の破棄
- [x] `いつものキーボード`、設定、挿入後の自動復帰、初回チェックリスト
- [x] GitHub ActionsでJava 17 / Gradle 8.9 / API 35を用意し、テスト・Lint・debug APKをArtifact化
- [ ] 依頼主のAndroid実機でAPKをインストールし、Codex / Claude / LINE、Pixel / Samsung、
      Gboard / Samsung Keyboardを確認
- [ ] 既存Web版のAI整形、辞書、モード、APIキー管理をネイティブIMEへ接続

初版は端末の音声認識結果を直接挿入する技術実証です。Codex / Claudeを名前で許可する実装ではなく、
LINEを含む通常の入力欄へ共通経路で挿入します。このPCにはAndroid Studio、JDK、SDK、Gradle、ADBが
無いため、ローカルAPKビルドはできません。`.github/workflows/android.yml` のCIを使います。
debug APKの取得と初回設定は `android/README.md` を参照してください。

端末・IMEごとの差と実マイク動作は必ず実機で確認します。確認前に「スマホ版で動作済み」とは言いません。

---

## 10. 作業のルール

1. **編集したら必ずコミット & プッシュ。** GitHub Pages が公開版なので、
   プッシュしないと依頼主が確認できません
2. **プッシュ後、Obsidian 側のバックアップも更新:**
   ```bash
   cd /c/Users/myabe/Documents/koekaki && git archive --format=tar HEAD | tar -x -C "/c/Users/myabe/OneDrive/Desktop/Obsidian Folder/Umbrella Parade/koekaki-backup"
   ```
   （`_バックアップについて.md` は Git 管理外なので、消えたら書き直すこと）
3. **`npm test` を通してからコミット**
4. **コミットメッセージは日本語で、「なぜそうしたか」を書く。** 既存の履歴に合わせること
5. **デプロイ確認:** `gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId')`
   数十秒で終わります
6. **実機確認が必要なものは、確認できていないと正直に伝える。**「できました」と言い切らない

---

## 11. 用語メモ

| 語 | 意味 |
|---|---|
| BYOK | Bring Your Own Key。利用者が自分の API キーを入れる方式 |
| 高速経路 | Gemini で音声→整形を1リクエストにまとめる処理（`geminiCombined`） |
| 簡易整形 / rules | API を使わない、端末内のルールベース整形 |
| キーなし構成 | 文字起こし=ブラウザ内蔵 + 整形=簡易。完全無料 |
| 区切り継続モード | スマホでの認識方式。短い認識を重複除去しながら自動でつなぎ、停止操作まで続ける |
