import { useState } from 'react'
import { isWebSpeechSupported } from '../lib/providers/webspeech'
import type { Settings } from '../lib/types'
import { EyeIcon, EyeOffIcon, MicIcon, SparkIcon } from './Icons'
import { Sheet } from './Sheet'

interface OnboardingProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onFinish: () => void
}

/** 初回起動時の3ステップ。ここで詰まるとアプリごと使われないので、極力短く。 */
export function Onboarding({ settings, onChange, onFinish }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const [reveal, setReveal] = useState(false)
  const hasKey = settings.apiKeys.gemini.trim().length > 0
  const webSpeechOk = isWebSpeechSupported()
  /** キーなし構成（ブラウザ内蔵の認識 + ルールベース整形）を選んでいるか */
  const keyless = settings.transcribeEngine === 'webspeech' && settings.polishEngine === 'rules'
  const canFinish = hasKey || keyless

  return (
    <Sheet
      title="こえかき へようこそ"
      onClose={onFinish}
      footer={
        <>
          {step > 0 && (
            <button className="btn sm" style={{ marginRight: 'auto' }} onClick={() => setStep((s) => s - 1)}>
              戻る
            </button>
          )}
          {step < 2 ? (
            <button className="btn primary sm" onClick={() => setStep((s) => s + 1)}>
              次へ
            </button>
          ) : (
            <button className="btn primary sm" onClick={onFinish} disabled={!canFinish}>
              {canFinish ? 'はじめる' : 'キーを入力してください'}
            </button>
          )}
        </>
      }
    >
      <div className="steps">
        {[0, 1, 2].map((i) => (
          <span key={i} className={i === step ? 'on' : ''} />
        ))}
      </div>

      {step === 0 && (
        <div className="onboard">
          <div style={{ display: 'grid', placeItems: 'center', marginBottom: 14 }}>
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: 22,
                background: 'linear-gradient(140deg, var(--accent), #4ac7ff)',
                display: 'grid',
                placeItems: 'center',
                color: '#fff',
              }}
            >
              <MicIcon size={32} />
            </div>
          </div>
          <h3>話すだけで、整った文章に。</h3>
          <p>
            「えーと」も、言い直しも、詰まったところも大丈夫です。
            話し終わったら、AI が読める文章に整えてくれます。あとは貼り付けるだけ。
          </p>
          <ul style={{ textAlign: 'left', color: 'var(--text-dim)', fontSize: 14, lineHeight: 1.9, paddingLeft: 20 }}>
            <li>フィラー（えー・あの・なんか）を自動で削除</li>
            <li>言い直したら、後から言った方だけ残す</li>
            <li>メール／チャット／議事録など、用途別に整形</li>
            <li>固有名詞は辞書に登録して誤変換を防止</li>
          </ul>
        </div>
      )}

      {step === 1 && (
        <div className="onboard">
          <h3>月額ゼロで使えます</h3>
          <p>
            こえかきに月額課金はありません。あなた自身の AI の API キーを使い、
            実際に使った分だけ AI 各社に支払う形です。
          </p>
          <div className="notice">
            <SparkIcon className="ico" />
            <div>
              Gemini の無料枠は1日1,500回。こえかきは1回の録音で1回しか使わないので、
              普通の使い方では無料の範囲を出ません。仮に超えても1分あたり1円未満です。
            </div>
          </div>
          <p style={{ fontSize: 13 }}>
            キーを用意したくない場合は、次の画面で「APIキーなしで始める」も選べます。
            精度は下がりますが、費用も通信も完全にゼロで使えます。
          </p>
          <p style={{ fontSize: 13 }}>
            音声とテキストは、このブラウザから AI 各社へ直接送られます。
            こえかきの運営者がその内容を受け取ることはありません（そもそも中継サーバーがありません）。
          </p>
        </div>
      )}

      {step === 2 && (
        <div className="onboard" style={{ textAlign: 'left' }}>
          <h3 style={{ textAlign: 'center' }}>API キーを設定する</h3>
          <ol>
            <li>
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">
                Google AI Studio
              </a>
              を開く（Google アカウントでログイン）
            </li>
            <li>「Create API key」を押す</li>
            <li>表示されたキーをコピーして、下に貼り付ける</li>
          </ol>
          <div className="field">
            <label htmlFor="onboard-key">Gemini の API キー</label>
            <div className="row">
              <input
                id="onboard-key"
                className="input mono"
                type={reveal ? 'text' : 'password'}
                value={settings.apiKeys.gemini}
                onChange={(e) =>
                  onChange({
                    apiKeys: { ...settings.apiKeys, gemini: e.target.value.trim() },
                    // キーを入れたら AI 経路に戻す
                    ...(e.target.value.trim() && keyless
                      ? { transcribeEngine: 'gemini' as const, polishEngine: 'gemini' as const }
                      : {}),
                  })
                }
                placeholder="AIza..."
                autoComplete="off"
                spellCheck={false}
              />
              <button className="icon-btn" onClick={() => setReveal((v) => !v)} aria-label="表示を切り替え">
                {reveal ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            <div className="desc">キーはこの端末のブラウザ内にだけ保存されます。後から設定画面で変更できます。</div>
          </div>

          <div
            style={{
              borderTop: '1px solid var(--border)',
              marginTop: 22,
              paddingTop: 18,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>キーを用意せずに試すこともできます</div>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
              ブラウザ内蔵の音声認識と、端末内のルールだけで整形する構成です。
              費用も通信先もゼロで、音声がどこにも送られません。
              ただし整形できるのはフィラー削除・言い詰まりの整理・句点の補完まで。
              メール調に直す、箇条書きに構造化するといった処理は AI が必要です。
            </p>
            {keyless ? (
              <div className="notice">
                <SparkIcon className="ico" />
                <div>
                  キーなし構成が選ばれています。このまま「はじめる」を押してください。
                  あとから設定画面でキーを入れれば AI 整形に切り替えられます。
                </div>
              </div>
            ) : (
              <button
                className="btn block"
                disabled={!webSpeechOk}
                onClick={() => onChange({ transcribeEngine: 'webspeech', polishEngine: 'rules' })}
              >
                {webSpeechOk ? 'APIキーなしで始める（無料）' : 'このブラウザは内蔵音声認識に非対応です'}
              </button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  )
}
