import { useEffect, useState } from 'react'
import { Waveform } from '@phosphor-icons/react/Waveform'

type VoiceBarPhase = 'starting' | 'recording' | 'transcribing' | 'polishing'

const PHASE_LABELS: Record<VoiceBarPhase, string> = {
  starting: 'マイクを準備しています…',
  recording: 'もう一度 右Alt で終了',
  transcribing: '文字にしています…',
  polishing: '文章を整えています…',
}

export default function VoiceBar() {
  const [phase, setPhase] = useState<VoiceBarPhase>('starting')

  useEffect(() => window.koekakiVoiceBar?.onPhase(setPhase), [])

  return (
    <main className={`voice-bar voice-bar--${phase}`} role="status" aria-live="polite" data-voicebar-phase={phase}>
      <div className="voice-bar__halo" aria-hidden="true">
        <div className="voice-bar__core">
          <Waveform size={34} weight="regular" />
        </div>
      </div>
      <div className="voice-bar__copy">
        <div className="voice-bar__brand">こえかき</div>
        <div className="voice-bar__message">{PHASE_LABELS[phase]}</div>
      </div>
      <div className="voice-bar__balance" aria-hidden="true" />
    </main>
  )
}
