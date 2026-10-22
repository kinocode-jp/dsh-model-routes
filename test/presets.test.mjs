import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_PRESETS, buildProviderRoute, buildCustomProviderRoute, filterModels } from '../lib/index.js'
import { validateCatalog, provider } from '../lib/vendor/catalog/index.js'

test('共有カタログの定義が壊れていない', () => {
  assert.deepEqual(validateCatalog(), [])
})

test('モデル登録プリセットは従来どおり6プロバイダを持つ', () => {
  assert.deepEqual(Object.keys(PROVIDER_PRESETS), ['claude', 'openai', 'google', 'xai', 'opencode', 'commandcode'])
  assert.equal(PROVIDER_PRESETS.claude.subscription.provider, 'anthropic')
  assert.equal(PROVIDER_PRESETS.claude.api.provider, 'anthropic-api')
  assert.equal(PROVIDER_PRESETS.openai.subscription.provider, 'openai-codex')
  assert.equal(PROVIDER_PRESETS.google.api.apiKeyEnv, 'GEMINI_API_KEY')
  assert.equal(PROVIDER_PRESETS.opencode.api.apiKeyEnv, 'OPENCODE_API_KEY')
  assert.equal(PROVIDER_PRESETS.opencode.api.provider, 'opencode')
  assert.equal(PROVIDER_PRESETS.google.subscription, undefined)
  assert.equal(PROVIDER_PRESETS.opencode.subscription, undefined)
  assert.equal(PROVIDER_PRESETS.commandcode.subscription, undefined)
})

test('各ルートは1件以上のモデルを持つ', () => {
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    for (const kind of ['subscription', 'api']) {
      if (!preset[kind]) continue
      assert.ok(preset[kind].models.length > 0, `${id}/${kind}`)
      assert.ok(preset[kind].labels.ja, `${id}/${kind}`)
    }
  }
})

test('共有カタログ経由でも同じモデルが引ける', () => {
  assert.equal(provider('claude').routes.api.models.length, PROVIDER_PRESETS.claude.api.models.length)
  assert.equal(provider('commandcode').quota.source, 'commandcode')
  assert.equal(provider('openai').quota.source, 'codex')
  assert.equal(provider('xai').quota, null)
})

test('表示フィルタとルート構築は従来どおり動く', () => {
  const preset = PROVIDER_PRESETS.claude.api
  const route = buildProviderRoute('api', preset, { visibleModels: ['claude-sonnet-5-5'] }, 'ja')
  assert.deepEqual(route.models.map(m => m.id), ['claude-sonnet-5-5'])
  assert.equal(route.apiKeyEnv, 'ANTHROPIC_API_KEY')
  assert.equal(buildProviderRoute('api', preset, { enabled: false }, 'ja'), null)
  const filtered = filterModels([{ id: 'a', name: 'A', defaultVisible: true }, { id: 'b', name: 'B', defaultVisible: false }], {})
  assert.deepEqual(filtered.map(m => m.id), ['a'])
  const custom = buildCustomProviderRoute('local', { displayName: 'Local', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY', models: [{ id: 'm', name: 'M' }] }, 'ja')
  assert.equal(custom.baseURL, 'http://127.0.0.1:11434/v1')
  assert.equal(custom.apiKeyEnv, 'LOCAL_KEY')
})

test('サブスク枠はAPIキー名を持たず、API枠は必ず持つ', () => {
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.subscription) {
      const route = buildProviderRoute('subscription', preset.subscription, {}, 'ja')
      assert.equal(route.apiKeyEnv, undefined, `${id}/subscription`)
      assert.equal(route.auth, undefined, `${id}: auth は設定へ漏らさない`)
    }
    if (preset.api) {
      const route = buildProviderRoute('api', preset.api, {}, 'ja')
      assert.ok(route.apiKeyEnv, `${id}/api`)
      assert.equal(route.auth, undefined, `${id}: auth は設定へ漏らさない`)
    }
  }
})

test('OpenCode Zen は pi-ai 同梱プロバイダ(api/baseURL なし)をAPIキーで使う', () => {
  const route = buildProviderRoute('api', PROVIDER_PRESETS.opencode.api, {}, 'ja')
  assert.equal(route.apiKeyEnv, 'OPENCODE_API_KEY')
  assert.equal(route.api, undefined)
  assert.equal(route.baseURL, undefined)
  assert.equal(route.displayName, 'OpenCode Zen', 'API 枠の表示名はサービス名だけ')
})
