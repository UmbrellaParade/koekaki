import { isWebSpeechSupported } from '../lib/providers/webspeech'
import type { Settings } from '../lib/types'
import { AlertIcon } from './Icons'

interface ConfigBannerProps {
  /** キーが足りていない provider の表示名 */
  missing: string[]
  settings: Settings
  onApply: (patch: Partial<Settings>) => void
  onOpenSettings: () => void
}

/**
 * 「キーが無いので使えない」状態を、押す前に画面上で解決できるようにする。
 *
 * 以前はマイクを押した瞬間に設定画面へ飛ばしていたが、
 * それだと「キーを入れたのにまた要求される」（エンジンの選択が別 provider のまま）
 * という行き止まりに気づけなかった。ここで直接の逃げ道を出す。
 */
export function ConfigBanner({ missing, settings, onApply, onOpenSettings }: ConfigBannerProps) {
  const webSpeechOk = isWebSpeechSupported()
  const hasGemini = settings.apiKeys.gemini.trim().length > 0
  const hasOpenai = settings.apiKeys.openai.trim().length > 0

  return (
    <div className="notice warn config-banner">
      <AlertIcon className="ico" />
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {missing.join(' と ')} の API キーが設定されていないため、まだ話せません
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>
          下のどれかを選べば、すぐ使えるようになります。
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {webSpeechOk && (
            <button
              className="btn primary sm"
              onClick={() => onApply({ transcribeEngine: 'webspeech', polishEngine: 'rules' })}
            >
              キーなしで無料で使う
            </button>
          )}
          {hasOpenai && (
            <button className="btn sm" onClick={() => onApply({ transcribeEngine: 'openai', polishEngine: 'openai' })}>
              OpenAI のキーを使う
            </button>
          )}
          {hasGemini && (
            <button className="btn sm" onClick={() => onApply({ transcribeEngine: 'gemini', polishEngine: 'gemini' })}>
              Gemini のキーを使う
            </button>
          )}
          <button className="btn ghost sm" onClick={onOpenSettings}>
            設定を開く
          </button>
        </div>
      </div>
    </div>
  )
}
