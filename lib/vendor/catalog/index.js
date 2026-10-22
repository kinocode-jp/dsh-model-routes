// @kinocode/dsh-provider-catalog
// モデル登録(dsh-model-routes)とクォータ表示(dsh-usage-bars)が共有する
// プロバイダ定義。依存パッケージなしの素の ESM。
import { PROVIDER_PRESETS, OAUTH_PROVIDERS } from './presets.js'
import { QUOTA_SOURCES, PRESET_QUOTA } from './quota.js'

export { PROVIDER_PRESETS, OAUTH_PROVIDERS, QUOTA_SOURCES, PRESET_QUOTA }

const usedSources = new Set(Object.values(PRESET_QUOTA).filter(Boolean))

// 1プロバイダ1レコード。routes はモデル登録用、quota は使用量取得用。
export const PROVIDERS = Object.fromEntries([
  ...Object.entries(PROVIDER_PRESETS).map(([id, preset]) => {
    const source = PRESET_QUOTA[id] ?? null
    const quota = source === null ? null : { source, ...QUOTA_SOURCES[source] }
    return [id, { id, labels: { ja: preset.name, en: preset.name, zh: preset.name }, routes: { subscription: preset.subscription ?? null, api: preset.api ?? null }, quota }]
  }),
  ...Object.entries(QUOTA_SOURCES).filter(([source]) => !usedSources.has(source)).map(([source, quota]) => [source, { id: source, labels: quota.labels, routes: { subscription: null, api: null }, quota: { source, ...quota } }]),
])

export const providerIds = () => Object.keys(PROVIDERS)
export const provider = id => PROVIDERS[id] ?? null
export const quotaFor = id => PROVIDERS[id]?.quota ?? null
export const sourceToProvider = source => Object.values(PROVIDERS).find(p => p.quota?.source === source)?.id ?? null

/** モデル登録用プリセット(購読/API)を返す。未定義なら null。 */
export function routePreset(id, kind = 'api') {
  if (kind !== 'subscription' && kind !== 'api') throw new TypeError('kind は subscription か api を指定してください')
  return PROVIDERS[id]?.routes?.[kind] ?? null
}

/** 取得元に対応するモデル登録の枠(subscription/api)。対象外なら null。 */
export const quotaRoute = source => QUOTA_SOURCES[source]?.route ?? null

/** クォータ設定画面で使う認証情報の名前。登録がない場合は空配列。 */
export const keyNamesForSource = source => QUOTA_SOURCES[source]?.keyNames ?? []

/** モデル登録ルートが参照するAPIキー名。プロバイダIDごとに返す。 */
export function routeKeyNames() {
  const result = {}
  for (const [id, record] of Object.entries(PROVIDERS)) {
    const names = []
    for (const kind of ['subscription', 'api']) {
      const env = record.routes?.[kind]?.apiKeyEnv
      if (typeof env === 'string' && env && !names.includes(env)) names.push(env)
    }
    if (names.length) result[id] = names
  }
  return result
}

/** usage-bars の設定画面用。キー入力が必要な取得元だけを返す。 */
export function keyNamesBySource() {
  return Object.fromEntries(Object.entries(QUOTA_SOURCES).filter(([, quota]) => quota.keyNames.length > 0).map(([source, quota]) => [source, [...quota.keyNames]]))
}

/** 定義の整合性を検査する。壊れた定義を配布前に検出するためのもの。 */
export function validateCatalog() {
  const errors = []
  const presetIds = Object.keys(PROVIDER_PRESETS)
  for (const id of presetIds) {
    if (Object.hasOwn(QUOTA_SOURCES, id) && PRESET_QUOTA[id] !== id) errors.push(`${id}: プリセットと取得元のIDが衝突しています`)
    if (!PRESET_QUOTA[id] && PRESET_QUOTA[id] !== null) errors.push(`${id}: PRESET_QUOTA に登録されていません`)
  }
  for (const [id, source] of Object.entries(PRESET_QUOTA)) {
    if (!presetIds.includes(id)) errors.push(`${id}: 存在しないプリセットです`)
    if (source === null) continue
    if (!Object.hasOwn(QUOTA_SOURCES, source)) { errors.push(`${id}: クォータ取得元 ${source} が未定義です`); continue }
    const route = QUOTA_SOURCES[source].route
    if (route && !PROVIDER_PRESETS[id][route]) errors.push(`${id}: プリセットに ${route} 枠がありません`)
  }
  for (const [source, quota] of Object.entries(QUOTA_SOURCES)) {
    if (!quota.labels?.ja) errors.push(`${source}: ja ラベルがありません`)
    if (!['oauth', 'apiKey', 'cookie', 'local'].includes(quota.auth)) errors.push(`${source}: 認証方式が不正です`)
    if (!Array.isArray(quota.keyNames) || quota.keyNames.some(name => typeof name !== 'string' || !name)) errors.push(`${source}: キー名が不正です`)
    if (quota.route !== undefined && quota.route !== null) {
      if (quota.route !== 'subscription' && quota.route !== 'api') errors.push(`${source}: route は subscription/api のみ指定できます`)
      const owner = Object.keys(PRESET_QUOTA).find(id => PRESET_QUOTA[id] === source)
      if (!owner) errors.push(`${source}: route がありますが対応するプリセットがありません`)
      else if (!PROVIDER_PRESETS[owner][quota.route]) errors.push(`${source}: プリセットに ${quota.route} 枠がありません`)
    }
  }
  for (const [id, record] of Object.entries(PROVIDERS)) {
    if (record.id !== id) errors.push(`${id}: id が一致しません`)
    if (!record.labels?.ja) errors.push(`${id}: ja ラベルがありません`)
    for (const kind of ['subscription', 'api']) {
      const route = record.routes?.[kind]
      if (!route) continue
      if (!route.provider) errors.push(`${id}/${kind}: provider がありません`)
      if (route.apiKeyEnv !== undefined && route.apiKeyEnv !== null && typeof route.apiKeyEnv !== 'string') errors.push(`${id}/${kind}: apiKeyEnv が不正です`)
      // サブスク(OAuth)枠と API キー枠を取り違えていないか。
      const expected = kind === 'subscription' ? 'oauth' : 'apiKey'
      if (route.auth !== expected) errors.push(`${id}/${kind}: auth は ${expected} にしてください（現在: ${route.auth ?? '未指定'}）`)
      if (kind === 'subscription') {
        if (route.apiKeyEnv) errors.push(`${id}/${kind}: サブスク枠に API キー名(${route.apiKeyEnv})があります。API 枠に移してください`)
        if (!OAUTH_PROVIDERS.includes(route.provider)) errors.push(`${id}/${kind}: ${route.provider} には OAuth ログインがありません。API 枠にしてください`)
      } else if (typeof route.apiKeyEnv !== 'string' || !route.apiKeyEnv) errors.push(`${id}/${kind}: API 枠には apiKeyEnv が必要です`)
      if (!Array.isArray(route.legacyLabels) || route.legacyLabels.some(label => typeof label !== 'string' || !label)) errors.push(`${id}/${kind}: legacyLabels が不正です`)
      // 表示名: OAuth 枠は「(OAuth)」付き、API 枠は付けない(設定画面とモデル選択で、見分けがつくように)
      const label = route.labels?.ja
      if (kind === 'subscription' && !/\(OAuth\)$/.test(label ?? '')) errors.push(`${id}/${kind}: 表示名は「… (OAuth)」にしてください(現在: ${label})`)
      if (kind === 'api' && /\(.*\)$/.test(label ?? '')) errors.push(`${id}/${kind}: API 枠の表示名はサービス名だけにしてください(現在: ${label})`)
      if (!Array.isArray(route.models) || route.models.length === 0) errors.push(`${id}/${kind}: モデルがありません`)
      for (const model of route.models ?? []) if (!model?.id || !model?.name) errors.push(`${id}/${kind}: モデル定義が不正です`)
    }
    if (record.quota) {
      const { source } = record.quota
      if (!Object.hasOwn(QUOTA_SOURCES, source)) errors.push(`${id}: クォータ取得元 ${source} が未定義です`)
    } else if (!Object.hasOwn(PRESET_QUOTA, id) && !Object.hasOwn(QUOTA_SOURCES, id)) errors.push(`${id}: クォータもプリセットもありません`)
  }
  return errors
}
