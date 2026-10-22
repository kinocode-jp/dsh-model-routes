import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, findLlmpiAi } from '../lib/index.js'
// 起動時のモデル一覧取得(外部への問い合わせ)をテストでは行わない。
process.env.DSH_MODEL_ROUTES_NO_DISCOVERY = '1'

// すべてのテストを一時ディレクトリに隔離し、実際の ~/.dsh を読まない。
const TEST_HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'model-routes-home-'))
process.env.DSH_HOME = TEST_HOME
after(() => { fsSync.rmSync(TEST_HOME, { recursive: true, force: true }) })

function fakeContext() {
  const updates = []
  const entry = { options: { config: { providers: { existing: { displayName: 'Existing', models: [] } } } }, update: async options => { updates.push(options); entry.options = { ...entry.options, ...options } } }
  const events = {}
  const provided = {}
  return {
    updates, entry, events, provided,
    ctx: { loader: { store: { 'llm-pi-ai': entry } }, on: (name, fn) => { events[name] = fn }, get: () => undefined, provide: (name, service) => { provided[name] = service }, logger: { info() {}, error() {} } },
  }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('設定どおりに購読/APIルートを登録する', async () => {
  const { ctx, entry, updates, provided } = fakeContext()
  apply(ctx, { providers: {
    claude: { subscription: { visibleModels: ['claude-sonnet-5-5'] }, api: { enabled: false } },
    commandcode: { api: { enabled: false } },
  } })
  await flush()
  assert.equal(updates.length, 1)
  assert.deepEqual(Object.keys(updates[0]), ['config'], 'Entry.update には新しい config だけを渡す')
  const providers = entry.options.config.providers
  assert.deepEqual(providers.anthropic.models.map(m => m.id), ['claude-sonnet-5-5'])
  // オフの API 枠はモデル0件のルートとして残す(設定画面のカードを残し、オフのまま表示するため)
  assert.deepEqual(providers['anthropic-api'].models, [])
  assert.equal(providers['anthropic-api'].apiKeyEnv, 'ANTHROPIC_API_KEY', 'キー名は残す')
  assert.deepEqual(providers['commandcode-api'].models, [])
  assert.ok(providers['openai-codex'])
  assert.ok(providers['google-api'])
  assert.equal(providers.existing.displayName, 'Existing')
  const state = provided.modelRoutes.snapshot()
  assert.deepEqual(state.routes.claude.subscription, { enabled: true, routeId: 'anthropic', modelCount: 1, registered: true })
  assert.equal(state.routes.claude.label, 'Claude')
  assert.equal(state.routes.claude.api.enabled, false)
  assert.equal(state.routes.openai.subscription.enabled, true)
  assert.equal(state.routes.commandcode.api.enabled, false)
})

test('カスタムプロバイダを追加できる', async () => {
  const { ctx, entry, provided } = fakeContext()
  apply(ctx, { customProviders: { local: { displayName: 'Local', baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen', name: 'Qwen' }] } } })
  await flush()
  const local = entry.options.config.providers.local
  assert.equal(local.displayName, 'Local')
  assert.equal(local.baseURL, 'http://127.0.0.1:11434/v1')
  assert.deepEqual(local.models.map(m => m.id), ['qwen'])
})

test('llm-pi-ai が無い場合は何もしない', async () => {
  const events = {}
  apply({ loader: { store: {} }, on: (n, f) => { events[n] = f }, get: () => undefined, provide() {}, logger: {} }, {})
  await flush()
  assert.ok(events.ready)
})

test('画面からの枠の切り替えを保存し、再起動後も適用する', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-routes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await fs.rm(dir, { recursive: true, force: true })
  })
  const first = fakeContext()
  apply(first.ctx, {})
  await flush()
  assert.ok(first.entry.options.config.providers.anthropic)
  assert.equal(first.provided.modelRoutes.snapshot().routes.claude.subscription.enabled, true)

  const state = await first.provided.modelRoutes.setRouteEnabled('claude', 'subscription', false)
  assert.equal(state.routes.claude.subscription.enabled, false)
  assert.equal(first.entry.options.config.providers.anthropic, undefined)
  const file = path.join(dir, 'storages', 'model-routes', 'overrides.json')
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.deepEqual(saved.providers.claude, { subscription: false })
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)

  const second = fakeContext()
  apply(second.ctx, {})
  await flush()
  assert.equal(second.provided.modelRoutes.snapshot().routes.claude.subscription.enabled, false)
  assert.equal(second.entry.options.config.providers.anthropic, undefined)

  await first.provided.modelRoutes.setRouteEnabled('claude', 'subscription', true)
  assert.ok(first.entry.options.config.providers.anthropic)
  for (const [id, kind, enabled] of [['', 'api', true], ['claude', 'bad', true], ['claude', 'api', 'yes'], ['unknown', 'api', true], ['commandcode', 'subscription', true]]) {
    await assert.rejects(first.provided.modelRoutes.setRouteEnabled(id, kind, enabled))
  }
})

test('カスタムプロバイダも画面から切り替えられる', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-routes-custom-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await fs.rm(dir, { recursive: true, force: true })
  })
  const { ctx, entry, provided } = fakeContext()
  apply(ctx, { customProviders: { local: { displayName: 'Local', baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen', name: 'Qwen' }] } } })
  await flush()
  assert.ok(entry.options.config.providers.local)
  const state = await provided.modelRoutes.setRouteEnabled('local', 'api', false)
  assert.equal(state.routes.local.api.enabled, false)
  assert.equal(state.routes.local.label, 'Local')
  assert.deepEqual(entry.options.config.providers.local.models, [], 'カードを残すため、モデル0件で残す')
  await assert.rejects(provided.modelRoutes.setRouteEnabled('local', 'subscription', true), /api/)
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'storages', 'model-routes', 'overrides.json'), 'utf8'))
  assert.deepEqual(saved.customProviders.local, { enabled: false })
})

test('手動設定のルートは上書きせず、切り替えも拒否する', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-routes-manual-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await fs.rm(dir, { recursive: true, force: true })
  })
  const custom = { displayName: 'Claude (サブスク)', models: [{ id: 'x', name: 'X' }], apiKey: 'secret', headers: { authorization: 'secret' } }
  const updates = []
  const entry = { options: { config: { providers: { anthropic: custom } } }, update: async options => { updates.push(options); entry.options = { ...entry.options, ...options } } }
  const events = {}
  const provided = {}
  const ctx = { loader: { store: { 'llm-pi-ai': entry } }, on: (name, fn) => { events[name] = fn }, get: () => undefined, provide: (name, service) => { provided[name] = service }, logger: { info() {}, error() {}, warn() {} } }
  apply(ctx, {})
  await flush()
  assert.deepEqual(entry.options.config.providers.anthropic, custom, '既存の手動ルートを上書きしない')
  assert.deepEqual(updates[0].config.providers.anthropic, custom)
  await assert.rejects(provided.modelRoutes.setRouteEnabled('claude', 'subscription', false), /手動設定/)
  assert.deepEqual(entry.options.config.providers.anthropic, custom)
})

test('差分が無いときは llm-pi-ai を再更新しない', async () => {
  const { ctx, updates, events } = fakeContext()
  apply(ctx, {})
  await flush()
  const count = updates.length
  await events.ready()
  assert.equal(updates.length, count)
})

test('プロファイルの include 配下にある llm-pi-ai を見つける', async () => {
  const updates = []
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } }, update: async options => { updates.push(options); entry.options = { ...entry.options, ...options } } }
  const loader = { store: { include: { options: { id: 'include' } } }, entries: function* () { yield entry } }
  assert.equal(findLlmpiAi(loader), entry)
  const ctx = { loader, on() {}, get: () => undefined, provide() {}, logger: { info() {}, error() {}, warn() {} } }
  apply(ctx, { providers: { commandcode: { api: { enabled: false } } } })
  await flush()
  assert.equal(updates.length, 1)
  assert.ok(entry.options.config.providers['openai-codex'])
  assert.deepEqual(entry.options.config.providers['commandcode-api'].models, [])
})

test('所有ルートを手動で書き換えたら検出し、以後上書きしない', async () => {
  const { ctx, entry, events, provided } = fakeContext()
  apply(ctx, {})
  await flush()
  assert.ok(entry.options.config.providers.anthropic)
  const edited = { displayName: 'Edited Claude', models: [{ id: 'edited', name: 'Edited' }] }
  entry.options = { ...entry.options, config: { ...entry.options.config, providers: { ...entry.options.config.providers, anthropic: edited } } }
  await events.ready()
  assert.deepEqual(entry.options.config.providers.anthropic, edited, '手動変更を上書きしない')
  const saved = JSON.parse(await fs.readFile(path.join(process.env.DSH_HOME, 'storages', 'model-routes', 'overrides.json'), 'utf8'))
  assert.equal(saved.manual.anthropic, true)
  await assert.rejects(provided.modelRoutes.setRouteEnabled('claude', 'subscription', false), /手動設定/)
  const again = { displayName: 'Again', models: [{ id: 'again', name: 'Again' }] }
  entry.options = { ...entry.options, config: { ...entry.options.config, providers: { ...entry.options.config.providers, anthropic: again } } }
  await events.ready()
  assert.deepEqual(entry.options.config.providers.anthropic, again)
})

test('llm-pi-ai が後から現れても再試行で適用する', async () => {
  const updates = []
  const entry = { options: { config: { providers: {} } }, update: async options => { updates.push(options); entry.options = { ...entry.options, ...options } } }
  const loader = { store: {}, entries: () => [] }
  const ctx = { loader, on() {}, get: () => undefined, provide() {}, effect() {}, logger: { info() {}, error() {}, warn() {} } }
  apply(ctx, {})
  loader.store['llm-pi-ai'] = entry
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(updates.length > 0)
  assert.ok(entry.options.config.providers['openai-codex'])
})

test('カタログから外れた旧ルートは、自作のままなら外し、書き換え済みなら残す', async () => {
  const { ctx, entry, provided } = fakeContext()
  // 旧版が作った opencode-api ルート(記録と内容が一致) と、利用者が書き換えた google-api 風の旧ルート。
  const legacy = { displayName: 'OpenCode (API)', models: [{ id: 'opencode-code-latest', name: 'x' }] }
  const edited = { displayName: '手で直した旧ルート', models: [] }
  const { createHash } = await import('node:crypto')
  const fp = route => createHash('sha1').update(JSON.stringify(route)).digest('hex')
  entry.options = { config: { providers: { 'opencode-api': legacy, 'legacy-edited': edited } } }
  fsSync.mkdirSync(path.join(TEST_HOME, 'storages', 'model-routes'), { recursive: true })
  fsSync.writeFileSync(path.join(TEST_HOME, 'storages', 'model-routes', 'overrides.json'), JSON.stringify({
    providers: {}, customProviders: {}, owned: { 'opencode-api': fp(legacy), 'legacy-edited': 'deadbeef' }, manual: {},
  }))
  apply(ctx, {})
  await flush()
  const providers = entry.options.config.providers
  assert.equal(providers['opencode-api'], undefined, '自作のままの旧ルートは外す')
  assert.ok(providers['legacy-edited'], '書き換え済みの旧ルートには触らない')
  assert.ok(providers.opencode, '新しい OpenCode Zen ルートを登録する')
  assert.equal(providers.opencode.apiKeyEnv, 'OPENCODE_API_KEY')
  assert.equal(providers.google, undefined)
  const state = provided.modelRoutes.snapshot()
  assert.equal(state.routes.google.subscription, null)
  assert.equal(state.routes.opencode.subscription, null)
  assert.equal(state.routes.opencode.api.routeId, 'opencode')
  const saved = JSON.parse(fsSync.readFileSync(path.join(TEST_HOME, 'storages', 'model-routes', 'overrides.json'), 'utf8'))
  assert.equal(saved.owned['opencode-api'], undefined)
  assert.equal(saved.owned['legacy-edited'], undefined)
})

// ── 認証を登録した枠だけをモデル一覧に出す ──
function fakeCredentials({ records = {}, refs = {} } = {}) {
  return {
    describeRecord: async key => ({ configured: key in records }),
    describe: async ref => ({ configured: ref in refs }),
  }
}
function contextWith(credentials) {
  const base = fakeContext()
  base.ctx.get = name => name === 'credentials' ? credentials : undefined
  return base
}

test('ログイン済みのサブスク枠だけを出し、API枠は常に設定へ残す', async () => {
  // Claude: サブスクにログイン済み、API キーは未登録。OpenAI: API キーだけ登録。
  const credentials = fakeCredentials({ records: { 'llm-pi-ai/anthropic': true }, refs: { OPENAI_API_KEY: true } })
  const { ctx, entry, provided } = contextWith(credentials)
  apply(ctx, {})
  await flush()
  const providers = entry.options.config.providers
  assert.ok(providers.anthropic, 'ログイン済みのサブスク枠は出る')
  assert.equal(providers['openai-codex'], undefined, '未ログインのサブスク枠は出ない')
  // API枠は未登録でも設定に残す(設定画面でキーを入力できるように)。モデルの非表示は DSH が行う。
  assert.ok(providers['anthropic-api'], 'キー未登録のAPI枠も設定には残る')
  assert.ok(providers['openai-api'])
  assert.ok(providers.opencode)
  const state = provided.modelRoutes.snapshot()
  assert.equal(state.routes.claude.subscription.registered, true)
  assert.equal(state.routes.claude.api.registered, false)
  assert.equal(state.routes.openai.subscription.registered, false)
  assert.equal(state.routes.openai.api.registered, true)
})

test('ログインのイベントで、サブスク枠が一覧へ追加され、ログアウトで外れる', async () => {
  const records = {}, refs = {}
  const { ctx, entry, events } = contextWith(fakeCredentials({ records, refs }))
  apply(ctx, {})
  await flush()
  assert.equal(entry.options.config.providers.anthropic, undefined)
  refs.ANTHROPIC_API_KEY = true
  await events['credentials/reference-updated']()
  assert.equal(entry.options.config.providers.anthropic, undefined, 'キー登録ではサブスク枠は出ない')
  assert.ok(entry.options.config.providers['anthropic-api'])
  records['llm-pi-ai/anthropic'] = true
  await events['credentials/record-updated']()
  assert.ok(entry.options.config.providers.anthropic, 'ログイン後に追加される')
  delete records['llm-pi-ai/anthropic']
  await events['credentials/record-updated']()
  assert.equal(entry.options.config.providers.anthropic, undefined, 'ログアウト後は外れる')
  assert.ok(entry.options.config.providers['anthropic-api'])
})

const resetStorage = () => { fsSync.rmSync(path.join(TEST_HOME, 'storages'), { recursive: true, force: true }); fsSync.mkdirSync(path.join(TEST_HOME, 'storages', 'model-routes'), { recursive: true }) }
const writeOverridesFile = value => fsSync.writeFileSync(path.join(TEST_HOME, 'storages', 'model-routes', 'overrides.json'), JSON.stringify(value))
const readOverridesFile = () => JSON.parse(fsSync.readFileSync(path.join(TEST_HOME, 'storages', 'model-routes', 'overrides.json'), 'utf8'))

test('独自設定の手書きルート(headers など)は、未登録でも触らない', async () => {
  const { ctx, entry } = contextWith(fakeCredentials())
  const custom = { displayName: 'Claude (API)', apiKeyEnv: 'ANTHROPIC_API_KEY', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', headers: { 'x-team': 'a' }, models: [{ id: 'claude-sonnet-5-5', name: '手書き' }] }
  entry.options = { config: { providers: { 'anthropic-api': custom } } }
  resetStorage()
  writeOverridesFile({ providers: {}, customProviders: {}, owned: {}, manual: { 'anthropic-api': true } })
  apply(ctx, {})
  await flush()
  assert.deepEqual(entry.options.config.providers['anthropic-api'], custom)
})

test('標準的な手書きルートは引き継ぎ、新しい表示名にする(モデルの絞り込みは表示トグルへ)', async () => {
  const { ctx, entry, events } = contextWith(fakeCredentials({ refs: { ANTHROPIC_API_KEY: true }, records: { 'llm-pi-ai/anthropic': true } }))
  // 旧版・手書きの典型: 旧名、カタログと同じ api/baseURL/apiKeyEnv、モデルは3つだけ(名前や上限は手で付けた)
  const apiRoute = { displayName: 'Claude (API)', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (API)', contextWindow: 1000000 }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (API)' }, { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (API)' }] }
  const subRoute = { displayName: 'Claude (サブスク)', models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] }
  entry.options = { config: { providers: { 'anthropic-api': apiRoute, anthropic: subRoute } } }
  resetStorage()
  writeOverridesFile({ providers: {}, customProviders: {}, owned: {}, manual: { anthropic: true, 'anthropic-api': true } })
  apply(ctx, {})
  await flush()
  const providers = entry.options.config.providers
  assert.equal(providers['anthropic-api'].displayName, 'Claude', 'API 枠はサービス名だけ')
  assert.equal(providers.anthropic.displayName, 'Claude (OAuth)', 'OAuth 枠は「(OAuth)」付き')
  assert.deepEqual(providers['anthropic-api'].models.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'], '絞り込みを引き継ぐ(並びは新しい版から、同じ版は名前順)')
  assert.deepEqual(providers.anthropic.models.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  const saved = readOverridesFile()
  assert.equal(saved.models['anthropic-api']['claude-sonnet-4-5'], false, '旧ルートに無かった既定表示のモデルは非表示')
  assert.equal(saved.models['anthropic-api']['claude-haiku-4-5'], undefined, '旧ルートにあり既定表示のものは、フラグ不要')
  assert.equal(saved.manual.anthropic, undefined, '手書き扱いを解除する')
  assert.ok(saved.owned['anthropic-api'] && saved.owned.anthropic)
  // 設定を読み直しても結果は同じで、保存内容も変わらない
  const before = JSON.stringify(readOverridesFile())
  await events['app-boot/config-reload']()
  assert.equal(JSON.stringify(readOverridesFile()), before)
  assert.deepEqual(entry.options.config.providers['anthropic-api'].models.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'])
})

test('引き継いだあと DSH が手書きの内容に戻しても、手動扱いにせず引き継ぎ直す', async () => {
  const { ctx, entry, events } = contextWith(fakeCredentials({ refs: { ANTHROPIC_API_KEY: true }, records: { 'llm-pi-ai/anthropic': true } }))
  const apiRoute = { displayName: 'Claude (API)', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (API)' }] }
  const file = () => ({ config: { providers: { 'anthropic-api': structuredClone(apiRoute) } } })
  entry.options = file()
  resetStorage()
  apply(ctx, {})
  await flush()
  assert.equal(entry.options.config.providers['anthropic-api'].displayName, 'Claude')
  // プロファイルの編集や起動直後の読み直しで、DSH が手書きの内容を当て直す
  entry.options = file()
  await events['app-boot/config-reload']()
  assert.equal(entry.options.config.providers['anthropic-api'].displayName, 'Claude', '引き継ぎ直す')
  const saved = readOverridesFile()
  assert.equal(saved.manual['anthropic-api'], undefined, '手動扱いにしない')
  assert.ok(saved.owned['anthropic-api'])
})

test('標準的な手書きルートが未ログインのサブスク枠なら、引き継いだうえで設定から外す', async () => {
  const { ctx, entry } = contextWith(fakeCredentials())
  entry.options = { config: { providers: { anthropic: { displayName: 'Claude (サブスク)', models: [{ id: 'claude-sonnet-5-5' }] } } } }
  resetStorage()
  writeOverridesFile({ providers: {}, customProviders: {}, owned: {}, manual: { anthropic: true } })
  apply(ctx, {})
  await flush()
  assert.equal(entry.options.config.providers.anthropic, undefined)
})

test('資格情報サービスが無い・読めないときは従来どおり全部出す', async () => {
  fsSync.rmSync(path.join(TEST_HOME, 'storages'), { recursive: true, force: true })
  for (const credentials of [undefined, { describeRecord: async () => { throw new Error('boom') }, describe: async () => { throw new Error('boom') } }]) {
    const { ctx, entry } = contextWith(credentials)
    apply(ctx, {})
    await flush()
    const providers = entry.options.config.providers
    assert.ok(providers.anthropic && providers['anthropic-api'] && providers['openai-codex'] && providers.opencode)
  }
})

test('registeredOnly: false で従来どおり全部出す', async () => {
  fsSync.rmSync(path.join(TEST_HOME, 'storages'), { recursive: true, force: true })
  const { ctx, entry } = contextWith(fakeCredentials())
  apply(ctx, { registeredOnly: false })
  await flush()
  const providers = entry.options.config.providers
  assert.ok(providers.anthropic && providers['anthropic-api'] && providers.opencode)
})

test('カスタム枠はキーの有無にかかわらず設定に残す', async () => {
  fsSync.rmSync(path.join(TEST_HOME, 'storages'), { recursive: true, force: true })
  const { ctx, entry } = contextWith(fakeCredentials())
  apply(ctx, { customProviders: {
    ollama: { displayName: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'q', name: 'Q' }] },
    cloud: { displayName: 'Cloud', baseURL: 'https://x.example/v1', apiKeyEnv: 'CLOUD_API_KEY', models: [{ id: 'm', name: 'M' }] },
  } })
  await flush()
  assert.ok(entry.options.config.providers.ollama)
  assert.ok(entry.options.config.providers.cloud)
})

test('用途別の候補: API キーの通知(reference-updated)でその枠だけ取り直し、トークン更新(record-updated)では取り直さない', async t => {
  const { ctx, events, provided } = fakeContext()
  const credentials = {
    async describe(ref) { return { configured: ref === 'OPENAI_API_KEY' } },
    async resolve(ref) { return ref === 'OPENAI_API_KEY' ? { value: 'k' } : undefined },
    async readRecord() { return undefined }, async modifyRecord() {}, async deleteRecord() {},
  }
  ctx.get = name => name === 'credentials' ? credentials : undefined
  const realFetch = globalThis.fetch
  let listed = 0
  globalThis.fetch = async url => { if (String(url).endsWith('/models')) { listed++; return Response.json({ data: [{ id: 'gpt-image-2' }] }) } return new Response('{}', { status: 404 }) }
  t.after(() => { globalThis.fetch = realFetch })
  apply(ctx, {})
  await flush()
  const setup = provided.modelRoutesSetup
  assert.deepEqual((await setup.getSetup()).mediaCatalog.image.map(item => item.provider), ['openai-api'])
  assert.equal(listed, 1)
  await events['credentials/record-updated']('llm-pi-ai/anthropic')
  await setup.getSetup()
  assert.equal(listed, 1, 'トークン更新では控えを使う')
  await events['credentials/reference-updated']('GEMINI_API_KEY')
  await setup.getSetup()
  assert.equal(listed, 1, '別のキーの変更では取り直さない')
  await events['credentials/reference-updated']('OPENAI_API_KEY')
  await setup.getSetup()
  assert.equal(listed, 2, '使っているキーが変わったら取り直す')
})
