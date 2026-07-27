import { pickRecorderMime } from './audio'

export interface RecorderEvents {
  /** 0..1 の音量。UI のレベルメーター用 */
  onLevel?: (level: number) => void
  /** 無音が続いて自動停止するべきタイミング */
  onSilence?: () => void
  onError?: (err: Error) => void
}

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationMs: number
}

/**
 * MediaRecorder + AnalyserNode のラッパー。
 * 「無音が silenceStopSec 続いたら onSilence」を内蔵しているので、
 * ハンズフリー録音（話し終わったら勝手に止まる）が実装できる。
 */
export class Recorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private rafId = 0
  private startedAt = 0
  private silenceSince = 0
  private silenceStopMs = 0
  /** 録音開始直後は無音判定しない猶予 */
  private readonly warmupMs = 700

  private readonly events: RecorderEvents

  constructor(events: RecorderEvents = {}) {
    this.events = events
  }

  get isRecording(): boolean {
    return this.recorder?.state === 'recording'
  }

  /** マイク権限を先に取っておく（初回タップの体感を良くするため） */
  static async requestPermission(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
  }

  async start(silenceStopSec = 0): Promise<void> {
    if (this.isRecording) return
    this.silenceStopMs = silenceStopSec > 0 ? silenceStopSec * 1000 : 0

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    const mimeType = pickRecorderMime()
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.chunks = []
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.onerror = () => {
      this.events.onError?.(new Error('録音中にエラーが発生しました'))
    }

    this.setupAnalyser(this.stream)
    this.startedAt = performance.now()
    this.silenceSince = 0
    this.recorder.start(250)
  }

  /** 録音を止めて Blob を返す */
  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder
      if (!rec || rec.state === 'inactive') {
        this.teardown()
        reject(new Error('録音していません'))
        return
      }
      rec.onstop = () => {
        const durationMs = performance.now() - this.startedAt
        const mimeType = rec.mimeType || 'audio/webm'
        const blob = new Blob(this.chunks, { type: mimeType })
        this.teardown()
        resolve({ blob, mimeType, durationMs })
      }
      rec.stop()
    })
  }

  /** 保存せずに破棄する */
  cancel(): void {
    const rec = this.recorder
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null
      rec.stop()
    }
    this.chunks = []
    this.teardown()
  }

  private setupAnalyser(stream: MediaStream) {
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AC()
    const source = this.ctx.createMediaStreamSource(stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.6
    source.connect(this.analyser)

    const data = new Uint8Array(this.analyser.frequencyBinCount)
    const tick = () => {
      if (!this.analyser) return
      this.analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / data.length)
      // RMS はそのままだと動きが地味なので、体感に合わせて持ち上げる
      const level = Math.min(1, rms * 3.2)
      this.events.onLevel?.(level)

      if (this.silenceStopMs > 0) {
        const elapsed = performance.now() - this.startedAt
        if (elapsed > this.warmupMs) {
          if (level < 0.045) {
            if (this.silenceSince === 0) this.silenceSince = performance.now()
            else if (performance.now() - this.silenceSince > this.silenceStopMs) {
              this.silenceSince = 0
              this.events.onSilence?.()
            }
          } else {
            this.silenceSince = 0
          }
        }
      }

      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private teardown() {
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.analyser = null
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.recorder = null
    this.events.onLevel?.(0)
  }
}
