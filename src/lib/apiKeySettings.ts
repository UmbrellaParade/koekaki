import type { ProviderId, Settings } from './types'

type EngineSnapshot = Pick<Settings, 'transcribeEngine' | 'polishEngine'>
type LatestEngineSettings = EngineSnapshot & Pick<Settings, 'apiKeys'>

function engineHasKey(engine: string, apiKeys: Settings['apiKeys']): boolean {
  if (engine === 'webspeech' || engine === 'rules' || engine === 'none') return true
  return Boolean(apiKeys[engine as ProviderId]?.trim())
}

/**
 * キー保存後も利用者がエンジンを変えていない場合だけ、行き止まりを避ける自動切替を行う。
 * 保存待ち中に行われた手動選択は上書きしない。
 */
export function resolveEnginePatchAfterApiKeySave(
  provider: ProviderId,
  hasSavedKey: boolean,
  enginesAtSaveStart: EngineSnapshot,
  latest: LatestEngineSettings,
): Partial<Settings> {
  if (!hasSavedKey) return {}

  const patch: Partial<Settings> = {}
  if (
    provider !== 'anthropic' &&
    latest.transcribeEngine === enginesAtSaveStart.transcribeEngine &&
    !engineHasKey(latest.transcribeEngine, latest.apiKeys)
  ) {
    patch.transcribeEngine = provider
  }
  if (
    latest.polishEngine === enginesAtSaveStart.polishEngine &&
    !engineHasKey(latest.polishEngine, latest.apiKeys)
  ) {
    patch.polishEngine = provider
  }
  return patch
}
