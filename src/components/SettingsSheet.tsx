import { useRef, useState } from 'react'
import { AUDIO_PRICES, TEXT_PRICES } from '../lib/cost'
import { resolveEnginePatchAfterApiKeySave } from '../lib/apiKeySettings'
import { testProviderKey } from '../lib/pipeline'
import { anthropicListModels } from '../lib/providers/anthropic'
import { geminiListModels } from '../lib/providers/gemini'
import { openaiListModels } from '../lib/providers/openai'
import {
  isWebSpeechSupported,
  prefersSegmentedRecognition,
  type SpeechDiagnostic,
} from '../lib/providers/webspeech'
import { exportSettings, importSettings } from '../lib/storage'
import type { PolishEngine, ProviderId, Settings, TranscribeEngine } from '../lib/types'
import { ApiError } from '../lib/types'
import { AlertIcon, EyeIcon, EyeOffIcon, LoaderIcon, PlusIcon, RefreshIcon, SparkIcon, TrashIcon } from './Icons'
import { Segmented, Sheet, SwitchRow } from './Sheet'

interface SettingsSheetProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
  apiKeySaveState: 'idle' | 'saving' | 'saved' | 'error'
  apiKeysLoaded: boolean
  getSettingsForConnectionTest: () => Promise<Settings | null>
  onClose: () => void
  onClearHistory: () => void
  onNotify: (kind: 'ok' | 'err', message: string, hint?: string) => void
  diagnostics: SpeechDiagnostic[]
}

async function readClipboardText(): Promise<string> {
  const desktop = window.koekakiDesktop
  return desktop ? desktop.readApiKeyClipboard() : navigator.clipboard.readText()
}

async function writeClipboardText(text: string): Promise<void> {
  const desktop = window.koekakiDesktop
  if (desktop) await desktop.writeClipboard(text)
  else await navigator.clipboard.writeText(text)
}

/**
 * Service Worker とキャッシュを捨てて読み込み直す。
 *
 * ホーム画面に追加した PWA は、アプリを完全に終了しないと古いコードのまま動き続ける。
 * 「直したはずの不具合が消えない」の原因がこれだったことがあるので、
 * 利用者が自分で確実に更新できる手段を用意しておく。
 */
async function forceUpdate(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.()
    await Promise.all((regs ?? []).map((r) => r.unregister()))
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    // 消せなくても、とにかく読み込み直す
  }
  // クエリを変えて、キャッシュを迂回して取り直す
  const url = new URL(window.location.href)
  url.searchParams.set('u', Date.now().toString(36))
  window.location.replace(url.toString())
}

const KEY_INFO: Record<ProviderId, { label: string; url: string; note: string }> = {
  gemini: {
    label: 'Google Gemini',
    url: 'https://aistudio.google.com/apikey',
    note: '無料枠があります。まずはこれ1つで十分動きます。',
  },
  openai: {
    label: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    note: '文字起こしの精度が高い。無料枠はなく従量課金です。',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    url: 'https://console.anthropic.com/settings/keys',
    note: '整形の文章力に定評あり。音声には非対応なので整形専用です。',
  },
}

const GEMINI_MODELS = Object.keys(TEXT_PRICES).filter((m) => m.startsWith('gemini'))
const OPENAI_TEXT_MODELS = Object.keys(TEXT_PRICES).filter((m) => m.startsWith('gpt'))
const OPENAI_AUDIO_MODELS = Object.keys(AUDIO_PRICES)
const CLAUDE_MODELS = Object.keys(TEXT_PRICES).filter((m) => m.startsWith('claude'))

const LANGS: Array<{ value: string; label: string }> = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: '自動判定' },
  { value: 'zh', label: '中文' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
]

export function SettingsSheet({
  settings,
  onChange,
  apiKeySaveState,
  apiKeysLoaded,
  getSettingsForConnectionTest,
  onClose,
  onClearHistory,
  onNotify,
  diagnostics,
}: SettingsSheetProps) {
  const copyDiagnostics = async () => {
    const body = [
      `build: ${__BUILD_ID__}`,
      `ua: ${navigator.userAgent}`,
      `engines: ${settings.transcribeEngine} -> ${settings.polishEngine}`,
      '',
      ...diagnostics.map((d) => `[${d.kind}] ${d.detail}`),
    ].join('\n')
    try {
      await writeClipboardText(body)
      onNotify('ok', '診断ログをコピーしました', 'そのまま貼り付けて共有できます')
    } catch {
      onNotify('err', 'コピーできませんでした')
    }
  }

  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [pasting, setPasting] = useState<ProviderId | null>(null)
  const [pendingKeySaves, setPendingKeySaves] = useState(0)
  const keyActionBusyRef = useRef(false)
  const pendingKeySavesRef = useRef(0)
  const latestSettingsRef = useRef(settings)
  latestSettingsRef.current = settings
  const keyActionBusy = testing !== null || pasting !== null
  const keyControlBusy =
    !apiKeysLoaded || keyActionBusy || pendingKeySaves > 0 || apiKeySaveState === 'saving'
  const webSpeechOk = isWebSpeechSupported()
  /** 文字起こしと整形が同じ Gemini モデルなら、1リクエストで済む経路に乗る */
  const geminiFastPath = settings.models.geminiTranscribe === settings.models.geminiPolish
  const keylessPreset = settings.transcribeEngine === 'webspeech' && settings.polishEngine === 'rules'
  const aiPreset = settings.transcribeEngine === 'gemini' && settings.polishEngine === 'gemini'
  const openaiPreset = settings.transcribeEngine === 'openai' && settings.polishEngine === 'openai'

  const testKey = async (provider: ProviderId) => {
    if (
      !apiKeysLoaded ||
      keyActionBusyRef.current ||
      pendingKeySavesRef.current > 0 ||
      apiKeySaveState === 'saving'
    ) {
      return
    }
    keyActionBusyRef.current = true
    setTesting(provider)
    try {
      const persistedSettings = await getSettingsForConnectionTest()
      if (!persistedSettings) return
      await testProviderKey(provider, persistedSettings)
      onNotify('ok', `${KEY_INFO[provider].label} につながりました`)
    } catch (err) {
      if (err instanceof ApiError) onNotify('err', err.message, err.hint)
      else onNotify('err', '接続できませんでした')
    } finally {
      keyActionBusyRef.current = false
      setTesting(null)
    }
  }

  /**
   * キーを保存する。
   * このとき、いま選んでいるエンジンがキー未設定の provider を指したままだと
   * 「キーを入れたのにまだ使えない」状態になるので、入れた provider に向け直す。
   */
  const setKey = async (provider: ProviderId, value: string): Promise<boolean> => {
    // API キーに空白や改行は含まれない。貼り付け時に紛れ込むことが多いので落とす。
    const trimmed = value.replace(/\s+/g, '')
    const nextKeys = { ...settings.apiKeys, [provider]: trimmed }
    const transcribeEngineAtStart = settings.transcribeEngine
    const polishEngineAtStart = settings.polishEngine
    pendingKeySavesRef.current += 1
    setPendingKeySaves(pendingKeySavesRef.current)
    try {
      try {
        await onChange({ apiKeys: nextKeys })
      } catch {
        return false
      }

      const latestSettings = latestSettingsRef.current
      const enginePatch = resolveEnginePatchAfterApiKeySave(
        provider,
        Boolean(trimmed),
        { transcribeEngine: transcribeEngineAtStart, polishEngine: polishEngineAtStart },
        latestSettings,
      )
      if (enginePatch.transcribeEngine !== undefined || enginePatch.polishEngine !== undefined) {
        await onChange(enginePatch)
      }
      return true
    } finally {
      pendingKeySavesRef.current = Math.max(0, pendingKeySavesRef.current - 1)
      setPendingKeySaves(pendingKeySavesRef.current)
    }
  }

  /** ボタン操作のときだけ、各環境に合った安全な経路でクリップボードを読む。 */
  const pasteKey = async (provider: ProviderId) => {
    if (
      !apiKeysLoaded ||
      keyActionBusyRef.current ||
      pendingKeySavesRef.current > 0 ||
      apiKeySaveState === 'saving'
    ) {
      return
    }
    keyActionBusyRef.current = true
    setPasting(provider)
    try {
      let text: string
      try {
        text = await readClipboardText()
      } catch {
        onNotify(
          'err',
          '貼り付けできませんでした',
          window.koekakiDesktop
            ? '入力欄を選び、Ctrl+V で貼り付けてください。'
            : '入力欄を長押しして手動で貼り付けてください。',
        )
        return
      }
      if (!text.trim()) {
        onNotify('err', 'クリップボードが空です')
        return
      }
      if (!(await setKey(provider, text))) return
      onNotify('ok', `${KEY_INFO[provider].label} のキーを貼り付けました`, '「接続テスト」で確認できます')
    } finally {
      keyActionBusyRef.current = false
      setPasting(null)
    }
  }

  const setModel = (key: keyof Settings['models'], value: string) => {
    void onChange({ models: { ...settings.models, [key]: value } })
  }

  const handleExport = async () => {
    try {
      await writeClipboardText(exportSettings(settings))
      onNotify('ok', '設定をコピーしました', 'APIキーは含まれません')
    } catch {
      onNotify('err', 'コピーできませんでした')
    }
  }

  const handleImport = () => {
    if (keyActionBusyRef.current || pendingKeySavesRef.current > 0 || apiKeySaveState === 'saving') return
    const json = window.prompt('エクスポートした設定 JSON を貼り付けてください')
    if (!json) return
    try {
      const { apiKeys: _apiKeys, ...importedSettings } = importSettings(json, settings)
      void onChange(importedSettings)
      onNotify('ok', '設定を読み込みました')
    } catch {
      onNotify('err', '設定の形式が正しくありません')
    }
  }

  return (
    <Sheet title="設定" onClose={onClose}>
      {/* ---- API キー ---- */}
      <div className="section">
        <div className="section-title">API キー</div>
        <div className="notice">
          <AlertIcon className="ico" />
          <div>
            {window.koekakiDesktop
              ? 'キーはこのPCの暗号化された保存領域にだけ保存され、こえかきのサーバーには送られません（そもそもサーバーがありません）。'
              : 'キーはこの端末のブラウザ内にだけ保存され、こえかきのサーバーには送られません（そもそもサーバーがありません）。'}
            音声とテキストは、あなたのキーで各AI社に直接送信されます。
          </div>
        </div>
        {!apiKeysLoaded && window.koekakiDesktop && (
          <div className="notice" style={{ marginTop: 8 }}>
            <LoaderIcon size={16} className="spin" />
            <div>保存済みのAPIキーを読み込んでいます…</div>
          </div>
        )}

        {(Object.keys(KEY_INFO) as ProviderId[]).map((provider) => {
          const info = KEY_INFO[provider]
          const shown = revealed[provider]
          return (
            <div className="field" key={provider}>
              <label htmlFor={`key-${provider}`}>{info.label}</label>
              <div className="row">
                {/*
                  type="password" は使わない。スマホだとパスワードマネージャの候補バーが
                  被さって入力できなくなることがあるため、CSS で隠す方式にしている。
                  autoCapitalize / autoCorrect を切らないと、スマホのキーボードが
                  先頭を大文字にしたり綴りを直したりしてキーが壊れる。
                */}
                <input
                  id={`key-${provider}`}
                  className={`input mono${shown ? '' : ' masked'}`}
                  type="text"
                  inputMode="text"
                  value={settings.apiKeys[provider]}
                  onChange={(e) => {
                    if (!keyActionBusyRef.current) void setKey(provider, e.target.value)
                  }}
                  disabled={!apiKeysLoaded || keyActionBusy}
                  onFocus={(e) => {
                    // キーボードが出ると入力欄が隠れることがあるので、見える位置へ寄せる
                    setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250)
                  }}
                  placeholder="未設定"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setRevealed((r) => ({ ...r, [provider]: !r[provider] }))}
                  aria-label={shown ? 'キーを隠す' : 'キーを表示'}
                >
                  {shown ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>

              <div className="row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
                <button className="btn sm" onClick={() => void pasteKey(provider)} disabled={keyControlBusy}>
                  {pasting === provider && <LoaderIcon size={14} className="spin" />}
                  {pasting === provider ? '貼り付け中…' : '貼り付け'}
                </button>
                {settings.apiKeys[provider] && (
                  <>
                    <span
                      style={{
                        fontSize: 12,
                        color:
                          apiKeySaveState === 'error'
                            ? 'var(--danger)'
                            : apiKeySaveState === 'saving'
                              ? 'var(--warn)'
                              : 'var(--ok)',
                      }}
                    >
                      {settings.apiKeys[provider].length} 文字{' '}
                      {apiKeySaveState === 'saving'
                        ? '保存中…'
                        : apiKeySaveState === 'error'
                          ? '保存失敗'
                          : '保存済み'}
                      （末尾 …
                      {settings.apiKeys[provider].slice(-4)}）
                    </span>
                    <button
                      className="btn danger sm"
                      onClick={() => {
                        if (!keyActionBusyRef.current && pendingKeySavesRef.current === 0) {
                          void setKey(provider, '')
                        }
                      }}
                      disabled={keyControlBusy}
                    >
                      消す
                    </button>
                  </>
                )}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => void testKey(provider)}
                  disabled={!settings.apiKeys[provider] || keyControlBusy}
                >
                  {testing === provider && <LoaderIcon size={14} className="spin" />}
                  {testing === provider ? '確認中…' : '接続テスト'}
                </button>
                <a href={info.url} target="_blank" rel="noreferrer noopener" className="btn ghost sm">
                  キーを取得
                </a>
              </div>
              <div className="desc">{info.note}</div>
            </div>
          )
        })}
      </div>

      {/* ---- エンジン ---- */}
      <div className="section">
        <div className="section-title">エンジン</div>

        {/* 無料構成は2か所を同時に変える必要があり、片方だけだと無料にならない。
            間違えようがないように、ワンタップの切り替えを置いておく。 */}
        <div className="field">
          <span className="field-label">かんたん切り替え</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button
              className={`btn sm${keylessPreset ? ' primary' : ''}`}
              disabled={!webSpeechOk}
              onClick={() => onChange({ transcribeEngine: 'webspeech', polishEngine: 'rules' })}
            >
              {keylessPreset ? '✓ ' : ''}完全無料（キー不要）
            </button>
            <button
              className={`btn sm${aiPreset ? ' primary' : ''}`}
              disabled={!settings.apiKeys.gemini}
              onClick={() => onChange({ transcribeEngine: 'gemini', polishEngine: 'gemini' })}
            >
              {aiPreset ? '✓ ' : ''}Gemini（おすすめ）
            </button>
            <button
              className={`btn sm${openaiPreset ? ' primary' : ''}`}
              disabled={!settings.apiKeys.openai}
              onClick={() => onChange({ transcribeEngine: 'openai', polishEngine: 'openai' })}
            >
              {openaiPreset ? '✓ ' : ''}OpenAI
            </button>
          </div>
          <div className="desc">
            「完全無料」は、APIキーをまったく使わない構成です。文字起こしをブラウザ内蔵の音声認識に、
            整形を端末内のルール処理に、同時に切り替えます。下の2つを個別に変えるより確実です。
            {!webSpeechOk && (
              <>
                <br />
                <strong style={{ color: 'var(--warn)' }}>
                  ※ このブラウザは内蔵の音声認識に対応していないため、完全無料の構成は選べません。Chrome か Microsoft
                  Edge で開くと使えます（Firefox・iOS Safari は非対応）。
                </strong>
              </>
            )}
          </div>
          <div className="desc" style={{ marginTop: 8 }}>
            この端末の内蔵音声認識：{' '}
            <strong style={{ color: webSpeechOk ? 'var(--ok)' : 'var(--warn)' }}>
              {webSpeechOk ? '使えます' : '使えません'}
            </strong>
            {webSpeechOk && (
              <>
                {' ／ 認識方式：'}
                <strong>{prefersSegmentedRecognition() ? '区切りながら継続（スマホ向け）' : '連続（PC向け）'}</strong>
              </>
            )}
          </div>
          {webSpeechOk && prefersSegmentedRecognition() && (
            <div className="desc" style={{ marginTop: 6 }}>
              スマホでは、短い無音でブラウザの認識が区切られても自動で次へつなぎます。
              マイクをもう一度押すまでは録音を続けるので、考えながら話しても大丈夫です。
            </div>
          )}
        </div>

        <div className="field">
          <span className="field-label">文字起こし（音声 → 文字）</span>
          <Segmented<TranscribeEngine>
            value={settings.transcribeEngine}
            onChange={(v) => onChange({ transcribeEngine: v })}
            options={[
              { value: 'gemini', label: 'Gemini' },
              { value: 'openai', label: 'OpenAI' },
              { value: 'webspeech', label: 'ブラウザ内蔵' },
            ]}
          />
          <div className="desc">
            {settings.transcribeEngine === 'gemini' &&
              'Gemini は音声をそのまま理解できます。整形も Gemini にすると1回のリクエストで完結し、最も速く安くなります。'}
            {settings.transcribeEngine === 'openai' && 'Whisper 系。ノイズが多い環境や専門用語に強い傾向があります。'}
            {settings.transcribeEngine === 'webspeech' &&
              (webSpeechOk
                ? 'ブラウザ内蔵の音声認識。完全無料で、話している最中から文字が出ます。長時間や句読点の精度は AI に劣ります。'
                : '⚠ このブラウザは内蔵音声認識に対応していません。Gemini か OpenAI を選んでください。')}
          </div>
        </div>

        <div className="field">
          <span className="field-label">整形（文字 → 読める文章）</span>
          <Segmented<PolishEngine>
            value={settings.polishEngine}
            onChange={(v) => onChange({ polishEngine: v })}
            options={[
              { value: 'gemini', label: 'Gemini' },
              { value: 'openai', label: 'OpenAI' },
              { value: 'anthropic', label: 'Claude' },
              { value: 'rules', label: '簡易（無料）' },
              { value: 'none', label: 'なし' },
            ]}
          />
          <div className="desc">
            {settings.polishEngine === 'none' &&
              '整形せず、書き起こしをそのまま出します。'}
            {settings.polishEngine === 'rules' &&
              'APIキーも通信も使わず、端末内のルールだけで整形します。費用は完全にゼロですが、できるのは「明らかなフィラーの削除」「言い詰まりの繰り返しをまとめる」「言い直しの整理」「句点の補完」までです。メール調に直す・箇条書きに構造化するといった判断はAIにしかできません。'}
            {settings.polishEngine !== 'none' &&
              settings.polishEngine !== 'rules' &&
              'フィラー除去・言い直しの整理・句読点付けをこのエンジンが担当します。'}
          </div>
          {settings.polishEngine === 'rules' && settings.transcribeEngine !== 'webspeech' && (
            <div className="notice warn" style={{ marginTop: 10 }}>
              <AlertIcon className="ico" />
              <div>
                整形は無料ですが、文字起こしに {settings.transcribeEngine === 'gemini' ? 'Gemini' : 'OpenAI'} を使う設定のままです。
                完全に無料・キーなしにするには、上の「文字起こし」を<strong>ブラウザ内蔵</strong>にしてください。
              </div>
            </div>
          )}
        </div>

        <div className="field">
          <span className="field-label">モデル</span>
          <div style={{ display: 'grid', gap: 12 }}>
            {settings.transcribeEngine === 'gemini' && (
              <ModelInput
                label="Gemini 文字起こし"
                value={settings.models.geminiTranscribe}
                options={GEMINI_MODELS}
                onChange={(v) => setModel('geminiTranscribe', v)}
                onFetch={() => geminiListModels(settings.apiKeys.gemini)}
                onNotify={onNotify}
              />
            )}
            {settings.polishEngine === 'gemini' && (
              <ModelInput
                label="Gemini 整形"
                value={settings.models.geminiPolish}
                options={GEMINI_MODELS}
                onChange={(v) => setModel('geminiPolish', v)}
                onFetch={() => geminiListModels(settings.apiKeys.gemini)}
                onNotify={onNotify}
              />
            )}
            {settings.transcribeEngine === 'openai' && (
              <ModelInput
                label="OpenAI 文字起こし"
                value={settings.models.openaiTranscribe}
                options={OPENAI_AUDIO_MODELS}
                onChange={(v) => setModel('openaiTranscribe', v)}
                onFetch={() => openaiListModels(settings.apiKeys.openai, 'audio')}
                onNotify={onNotify}
              />
            )}
            {settings.polishEngine === 'openai' && (
              <ModelInput
                label="OpenAI 整形"
                value={settings.models.openaiPolish}
                options={OPENAI_TEXT_MODELS}
                onChange={(v) => setModel('openaiPolish', v)}
                onFetch={() => openaiListModels(settings.apiKeys.openai, 'text')}
                onNotify={onNotify}
              />
            )}
            {settings.polishEngine === 'anthropic' && (
              <ModelInput
                label="Claude 整形"
                value={settings.models.anthropicPolish}
                options={CLAUDE_MODELS}
                onChange={(v) => setModel('anthropicPolish', v)}
                onFetch={() => anthropicListModels(settings.apiKeys.anthropic)}
                onNotify={onNotify}
              />
            )}
          </div>
          <div className="desc">
            「一覧」を押すと、そのキーで<strong>実際に使えるモデル</strong>を各社から取得して並べます。上位モデルを選べば精度が上がり、
            そのぶん料金も上がります。名前を直接入力しても構いません。
          </div>
          {settings.transcribeEngine === 'gemini' && settings.polishEngine === 'gemini' && (
            <div className={geminiFastPath ? 'notice' : 'notice warn'} style={{ marginTop: 10 }}>
              {geminiFastPath ? <SparkIcon className="ico" /> : <AlertIcon className="ico" />}
              <div>
                {geminiFastPath
                  ? '文字起こしと整形が同じモデルなので、1回のリクエストで完結する高速・低コスト経路で動きます。'
                  : '文字起こしと整形でモデルが違うため、リクエストが2回に分かれます（少し遅く、少し高くなります）。整形だけ上位モデルにしたい場合はこのままで問題ありません。'}
              </div>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="lang">話す言語</label>
          <select
            id="lang"
            className="select"
            value={settings.spokenLang}
            onChange={(e) => onChange({ spokenLang: e.target.value })}
          >
            {LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- 動作 ---- */}
      <div className="section">
        <div className="section-title">動作</div>
        <SwitchRow
          title="録音を止めたら自動で変換"
          desc="オフにすると、停止後に自分で変換ボタンを押す形になります。"
          checked={settings.autoProcess}
          onChange={(v) => onChange({ autoProcess: v })}
        />
        <SwitchRow
          title="話している最中の文字を表示する"
          desc="認識の途中経過は、同じ語が並んだり書き換わったりして必ず乱れます。見ていて不安になるので既定では出しません。停止したあとに、整った文章だけをお見せします。"
          checked={settings.showLiveText}
          onChange={(v) => onChange({ showLiveText: v })}
        />
        <SwitchRow
          title="続けて話したら書き足す"
          desc="オンにすると、次の録音が今の文章を置き換えずに末尾へ追加されます。長い文章を何回かに分けて吹き込むときに便利です。"
          checked={settings.appendMode}
          onChange={(v) => onChange({ appendMode: v })}
        />
        <SwitchRow
          title="変換できたら自動でコピー"
          desc="結果が出た瞬間にクリップボードへ入るので、貼り付けるだけで済みます。"
          checked={settings.autoCopy}
          onChange={(v) => onChange({ autoCopy: v })}
        />
        <SwitchRow
          title="履歴を保存する"
          desc="この端末の中だけに保存されます。音声は保存されません。"
          checked={settings.saveHistory}
          onChange={(v) => onChange({ saveHistory: v })}
        />

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="silence">話し終わったら自動で停止</label>
          <select
            id="silence"
            className="select"
            value={String(settings.silenceStopSec)}
            onChange={(e) => onChange({ silenceStopSec: Number(e.target.value) })}
          >
            <option value="0">使わない</option>
            <option value="1.5">1.5秒 無音で停止</option>
            <option value="2">2秒 無音で停止</option>
            <option value="3">3秒 無音で停止</option>
            <option value="5">5秒 無音で停止</option>
          </select>
          <div className="desc">手が離せないときに便利です。考えながら話す場合は長めにするか、オフにしてください。</div>
        </div>
      </div>

      {/* ---- 辞書 ---- */}
      <div className="section">
        <div className="section-title">ユーザー辞書</div>
        <SwitchRow
          title="よく使う製品名を自動で直す"
          desc="「ジェミニ」→ Gemini、「クロード」→ Claude、「ギットハブ」→ GitHub のように、カタカナで書き起こされた製品名やサービス名をアルファベットに直します。キーなしの無料モードでも効きます。"
          checked={settings.useBuiltinTerms}
          onChange={(v) => onChange({ useBuiltinTerms: v })}
        />
        <div className="desc" style={{ margin: '12px 0' }}>
          人名・作品名・専門用語など、上の一覧に無い言葉はここに登録してください。
          結果画面で語を選択して「辞書に追加」を押すと素早く登録できます。
        </div>
        <DictionaryEditor settings={settings} onChange={onChange} />
      </div>

      {/* ---- 文体 ---- */}
      <div className="section">
        <div className="section-title">文体を覚えさせる</div>
        <div className="field">
          <label htmlFor="style">自分が書いた文章のサンプル</label>
          <textarea
            id="style"
            className="textarea"
            value={settings.styleSample}
            onChange={(e) => onChange({ styleSample: e.target.value })}
            placeholder="普段書いているメールやブログの文章を、数百文字ぶん貼り付けてください。"
          />
          <div className="desc">
            語尾・改行の癖・漢字とひらがなの使い分けを、この文章に寄せて整形します。内容は参照されません。空欄でも問題ありません。
          </div>
        </div>
      </div>

      {/* ---- 表示 ---- */}
      <div className="section">
        <div className="section-title">表示</div>
        <div className="field">
          <span className="field-label">テーマ</span>
          <Segmented<Settings['theme']>
            value={settings.theme}
            onChange={(v) => onChange({ theme: v })}
            options={[
              { value: 'system', label: '端末に合わせる' },
              { value: 'dark', label: 'ダーク' },
              { value: 'light', label: 'ライト' },
            ]}
          />
        </div>
      </div>

      {/* ---- データ ---- */}
      <div className="section">
        <div className="section-title">データ</div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn sm" onClick={handleExport}>
            設定をコピー（バックアップ）
          </button>
          <button className="btn sm" onClick={handleImport} disabled={keyControlBusy}>
            設定を貼り付けて復元
          </button>
          <button className="btn danger sm" onClick={onClearHistory}>
            <TrashIcon />
            履歴を全部消す
          </button>
        </div>
        <div className="desc" style={{ marginTop: 10 }}>
          設定のバックアップに API キーは含まれません。別の端末では改めてキーを入力してください。
        </div>
      </div>

      <div className="section" style={{ marginBottom: 0 }}>
        <div className="section-title">こえかきについて</div>
        <div className="desc">
          音声はブラウザから各AI社へ直接送られ、こえかき側のサーバーを経由しません。録音した音声データは
          変換が終わった時点で破棄され、端末にも残りません。
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <span className="field-label">この端末で動いている版</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                background: 'var(--surface-2)',
                padding: '6px 10px',
                borderRadius: 8,
              }}
            >
              {__BUILD_ID__}
            </code>
            {!__DESKTOP__ && (
              <button className="btn sm" onClick={() => void forceUpdate()}>
                最新版に更新
              </button>
            )}
          </div>
          <div className="desc">
            {__DESKTOP__
              ? 'デスクトップ版ではブラウザのキャッシュ更新は使いません。現在の版は上の日時で確認できます。'
              : 'スマホに追加したアプリは古い版が残ることがあります。直したはずの不具合が続くときは、まずここの日時を確認して「最新版に更新」を押してください。'}
          </div>
        </div>

        <div className="field">
          <span className="field-label">音声認識の診断</span>
          <div className="desc" style={{ marginBottom: 8 }}>
            直近の録音で、ブラウザが実際に何を返したかの記録です（{diagnostics.length} 件）。
            スマホ特有の不具合を調べるときに使います。
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn sm" onClick={() => void copyDiagnostics()} disabled={diagnostics.length === 0}>
              診断ログをコピー
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}

function ModelInput({
  label,
  value,
  options,
  onChange,
  onFetch,
  onNotify,
}: {
  label: string
  value: string
  /** 取得前に見せる、よく使うモデルの候補 */
  options: string[]
  onChange: (v: string) => void
  /** キーを使って実際に使えるモデル一覧を取ってくる */
  onFetch: () => Promise<string[]>
  onNotify: (kind: 'ok' | 'err', message: string, hint?: string) => void
}) {
  const listId = `models-${label.replace(/[\s（）]/g, '-')}`
  const [fetched, setFetched] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchModels = async () => {
    setLoading(true)
    try {
      const models = await onFetch()
      setFetched(models)
      onNotify('ok', `${models.length} 個のモデルが使えます`, '一覧から選べます')
    } catch (err) {
      if (err instanceof ApiError) onNotify('err', err.message, err.hint)
      else onNotify('err', 'モデル一覧を取得できませんでした')
    } finally {
      setLoading(false)
    }
  }

  const suggestions = fetched ?? options

  return (
    <div>
      <span className="field-label" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>
        {label}
      </span>
      <div className="row">
        <input
          className="input mono"
          value={value}
          list={listId}
          onChange={(e) => onChange(e.target.value.trim())}
          spellCheck={false}
          autoComplete="off"
        />
        <button className="btn sm" onClick={() => void fetchModels()} disabled={loading} style={{ flex: 'none' }}>
          {loading ? <LoaderIcon size={14} className="spin" /> : <RefreshIcon size={14} />}
          一覧
        </button>
      </div>
      <datalist id={listId}>
        {suggestions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>

      {fetched && (
        <select
          className="select"
          style={{ marginTop: 6 }}
          value={fetched.includes(value) ? value : ''}
          onChange={(e) => e.target.value && onChange(e.target.value)}
        >
          <option value="">使えるモデルから選ぶ…</option>
          {fetched.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function DictionaryEditor({
  settings,
  onChange,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}) {
  const entries = settings.dictionary

  const update = (index: number, patch: Partial<Settings['dictionary'][number]>) => {
    const next = entries.map((e, i) => (i === index ? { ...e, ...patch } : e))
    onChange({ dictionary: next })
  }

  const remove = (index: number) => onChange({ dictionary: entries.filter((_, i) => i !== index) })
  const add = () => onChange({ dictionary: [...entries, { term: '', wrong: '' }] })

  return (
    <div>
      {entries.length === 0 && <div className="desc">まだ登録がありません。</div>}
      {entries.map((entry, i) => (
        <div className="list-item" key={i}>
          <div className="row">
            <input
              className="input"
              value={entry.term}
              onChange={(e) => update(i, { term: e.target.value })}
              placeholder="正しい表記（例: Umbrella Parade）"
            />
            <button className="icon-btn" onClick={() => remove(i)} aria-label="削除">
              <TrashIcon />
            </button>
          </div>
          <input
            className="input"
            style={{ marginTop: 6 }}
            value={entry.wrong ?? ''}
            onChange={(e) => update(i, { wrong: e.target.value })}
            placeholder="誤変換されやすい表記（任意・カンマ区切り）"
          />
        </div>
      ))}
      <button className="btn sm" style={{ marginTop: 10 }} onClick={add}>
        <PlusIcon />
        語を追加
      </button>
    </div>
  )
}
