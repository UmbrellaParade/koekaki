# こえかき Android IME

Android の入力欄へ音声認識結果を直接挿入する、ネイティブ IME の技術実証です。
このディレクトリは Web／Electron 版とは独立した Android アプリとしてビルドします。

この初版は端末の音声認識サービスを使います。短い無音で認識が一区切りになっても、
利用者が「停止して入力」を押すまでは自動で次の区切りを開始します。60秒間まったく音声が
得られない場合は安全に停止し、1回の全体上限は10分です。完成した区切りだけを
メモリ上で連結し、停止時に `InputConnection.commitText()` で現在のカーソル位置へ1回だけ
挿入します。Codex、Claude、LINEを含む通常の入力欄を同じ仕組みで扱い、アプリ名による
許可リストやDOM操作は行いません。

AIによる文章整形、ユーザー辞書、既存Web版との設定共有はまだ接続していません。
また、生成したAPKの実機インストールと各アプリでの入力確認も未実施です。

## 固定しているビルド環境

- Java 17
- Android Gradle Plugin 8.7.3
- Gradle 8.9
- `minSdk 28`（Android 9）
- `compileSdk 35` / `targetSdk 35`

## PCへ開発環境を入れずにビルドする

GitHub Actions の **Android IME** ワークフローが、クラウド上の一時的な環境で
Android SDK と Gradle を準備し、次を順番に実行します。

1. `testDebugUnitTest` — JVM 単体テスト
2. `lintDebug` — Android Lint
3. `assembleDebug` — 動作確認用 debug APK の生成

`main` への Android 関連変更の push、Pull Request、または GitHub の Actions 画面に
ある **Run workflow** から実行できます。成功後は実行結果の Artifacts にある
`koekaki-ime-debug-apk` をダウンロードしてください。ZIP 内の `app-debug.apk` を
Android 端末へ移してインストールできます。Artifact の保存期間は14日です。

この方式では、このPCへの Android Studio・JDK・Android SDK の追加インストールや、
常時稼働する有料ビルドサーバーは不要です。GitHub Actions の利用量は、リポジトリの
公開範囲とGitHubアカウントに含まれる無料枠・利用条件に従います。

> debug APK は実機検証専用です。ストア配布や正式リリースには、署名鍵を安全に管理した
> release ビルドと追加の審査準備が必要です。

## 初回設定と使い方

1. APKをインストールし、ランチャーから「こえかき」を開く
2. 画面の案内に沿って、マイク許可、IMEの有効化、入力方式の選択を行う
3. Codex、Claude、LINEなどの入力欄で「こえかき音声入力」を選ぶ
4. `話す` → 発話 → `停止して入力` の順に押す
5. 顔文字や手打ちを使うときは `⌨ いつものキーボード` で元のIMEへ戻る

パスワード欄、直接編集を扱えない入力欄、録音中に接続が変わった入力欄には挿入しません。
音声・認識文・周辺の入力文はログや永続ストレージへ保存しません。端末の音声認識サービスが
音声を端末外で処理するかどうかは、端末と選択中の認識サービスの設定に依存します。

## ローカル環境がある場合

Java 17、Android SDK 35、Gradle 8.9 が導入済みなら、`android` ディレクトリで
次を実行するとCIと同じ確認ができます。

```text
gradle --no-daemon testDebugUnitTest lintDebug assembleDebug
```

生成先は `app/build/outputs/apk/debug/app-debug.apk` です。
