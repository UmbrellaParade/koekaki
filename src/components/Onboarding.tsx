import { useState } from 'react'
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
            <button className="btn primary sm" onClick={onFinish} disabled={!hasKey}>
              {hasKey ? 'はじめる' : 'キーを入力してください'}
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
            こえかきは、あなた自身の AI の API キーを使って動きます。
            月額課金はなく、実際に使った分だけ AI 各社に支払う形です。
          </p>
          <div className="notice">
            <SparkIcon className="ico" />
            <div>
              Google の Gemini には無料枠があります。1日に何十回か使う程度なら、
              多くの場合そのまま無料の範囲に収まります。
            </div>
          </div>
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
                onChange={(e) => onChange({ apiKeys: { ...settings.apiKeys, gemini: e.target.value.trim() } })}
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
        </div>
      )}
    </Sheet>
  )
}
