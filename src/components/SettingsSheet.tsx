import { useState } from 'react'
import { AUDIO_PRICES, TEXT_PRICES } from '../lib/cost'
import { isWebSpeechSupported } from '../lib/providers/webspeech'
import { exportSettings, importSettings } from '../lib/storage'
import type { PolishEngine, ProviderId, Settings, TranscribeEngine } from '../lib/types'
import { AlertIcon, EyeIcon, EyeOffIcon, PlusIcon, TrashIcon } from './Icons'
import { Segmented, Sheet, SwitchRow } from './Sheet'

interface SettingsSheetProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
  onClearHistory: () => void
  onNotify: (kind: 'ok' | 'err', message: string, hint?: string) => void
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

export function SettingsSheet({ settings, onChange, onClose, onClearHistory, onNotify }: SettingsSheetProps) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const webSpeechOk = isWebSpeechSupported()

  const setKey = (provider: ProviderId, value: string) =>
    onChange({ apiKeys: { ...settings.apiKeys, [provider]: value.trim() } })

  const setModel = (key: keyof Settings['models'], value: string) =>
    onChange({ models: { ...settings.models, [key]: value } })

  const handleExport = async () => {
    try {
      await navigator.clipboard.writeText(exportSettings(settings))
      onNotify('ok', '設定をコピーしました', 'APIキーは含まれません')
    } catch {
      onNotify('err', 'コピーできませんでした')
    }
  }

  const handleImport = () => {
    const json = window.prompt('エクスポートした設定 JSON を貼り付けてください')
    if (!json) return
    try {
      onChange(importSettings(json, settings))
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
            キーはこの端末のブラウザ内にだけ保存され、こえかきのサーバーには送られません（そもそもサーバーがありません）。
            音声とテキストは、あなたのキーで各AI社に直接送信されます。
          </div>
        </div>

        {(Object.keys(KEY_INFO) as ProviderId[]).map((provider) => {
          const info = KEY_INFO[provider]
          const shown = revealed[provider]
          return (
            <div className="field" key={provider}>
              <label htmlFor={`key-${provider}`}>{info.label}</label>
              <div className="row">
                <input
                  id={`key-${provider}`}
                  className="input mono"
                  type={shown ? 'text' : 'password'}
                  value={settings.apiKeys[provider]}
                  onChange={(e) => setKey(provider, e.target.value)}
                  placeholder="未設定"
                  autoComplete="off"
                  spellCheck={false}
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
              <div className="desc">
                {info.note}{' '}
                <a href={info.url} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>
                  キーを取得
                </a>
              </div>
            </div>
          )
        })}
      </div>

      {/* ---- エンジン ---- */}
      <div className="section">
        <div className="section-title">エンジン</div>

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
              { value: 'none', label: 'なし' },
            ]}
          />
          <div className="desc">
            {settings.polishEngine === 'none'
              ? '整形せず、書き起こしをそのまま出します。'
              : 'フィラー除去・言い直しの整理・句読点付けをこのエンジンが担当します。'}
          </div>
        </div>

        <div className="field">
          <span className="field-label">モデル</span>
          <div style={{ display: 'grid', gap: 10 }}>
            {(settings.transcribeEngine === 'gemini' || settings.polishEngine === 'gemini') && (
              <ModelInput
                label="Gemini"
                value={settings.models.geminiPolish}
                options={GEMINI_MODELS}
                onChange={(v) => {
                  // 音声と整形を同じモデルに揃えると一括処理の速い経路に乗る
                  setModel('geminiPolish', v)
                  setModel('geminiTranscribe', v)
                }}
              />
            )}
            {settings.transcribeEngine === 'openai' && (
              <ModelInput
                label="OpenAI 文字起こし"
                value={settings.models.openaiTranscribe}
                options={OPENAI_AUDIO_MODELS}
                onChange={(v) => setModel('openaiTranscribe', v)}
              />
            )}
            {settings.polishEngine === 'openai' && (
              <ModelInput
                label="OpenAI 整形"
                value={settings.models.openaiPolish}
                options={OPENAI_TEXT_MODELS}
                onChange={(v) => setModel('openaiPolish', v)}
              />
            )}
            {settings.polishEngine === 'anthropic' && (
              <ModelInput
                label="Claude 整形"
                value={settings.models.anthropicPolish}
                options={CLAUDE_MODELS}
                onChange={(v) => setModel('anthropicPolish', v)}
              />
            )}
          </div>
          <div className="desc">一覧にないモデル名を直接入力することもできます。</div>
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
        <div className="desc" style={{ marginBottom: 12 }}>
          人名・作品名・専門用語など、誤変換されやすい言葉を登録しておくと、AI が正しい表記に直します。
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
          <button className="btn sm" onClick={handleImport}>
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
          バージョン 1.0.0 ／ 音声はブラウザから各AI社へ直接送られ、こえかき側のサーバーを経由しません。録音した音声データは
          変換が終わった時点で破棄され、端末にも残りません。
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
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  const listId = `models-${label.replace(/\s/g, '-')}`
  return (
    <div>
      <span className="field-label" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>
        {label}
      </span>
      <input
        className="input mono"
        value={value}
        list={listId}
        onChange={(e) => onChange(e.target.value.trim())}
        spellCheck={false}
        autoComplete="off"
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
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
