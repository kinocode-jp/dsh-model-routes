import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, buildModelsState, liveRoute, mergeLiveModels, discoverRouteModels, sortModelsNewestFirst, isChatModel, modelVersionOf, filterModels, buildProviderRoute, legacyShape, flagsFromListed, PROVIDER_PRESETS } from '../lib/index.js'
import { createModelsService } from '../lib/models-service.js'
// 起動時のモデル一覧取得(外部への問い合わせ)をテストでは行わない。
process.env.DSH_MODEL_ROUTES_NO_DISCOVERY = '1'

const TEST_HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'model-routes-models-'))
process.env.DSH_HOME = TEST_HOME
after(() => { fsSync.rmSync(TEST_HOME, { recursive: true, force: true }) })
const reset = () => fsSync.rmSync(path.join(TEST_HOME, 'storages'), { recursive: true, force: true })
const readSaved = () => JSON.parse(fsSync.readFileSync(path.join(TEST_HOME, 'storages', 'model-routes', 'overrides.json'), 'utf8'))

function fakeContext(providers = {}) {
  const entry = { options: { config: { providers } }, update: async options => { entry.options = { ...entry.options, ...options } } }
  const events = {}, provided = {}
  const credentials = { describeRecord: async () => ({ configured: true }), describe: async () => ({ configured: true }), readRecord: async () => ({ payload: { type: 'oauth' } }) }
  return { entry, events, provided, ctx: { loader: { store: { 'llm-pi-ai': entry } }, on: (n, f) => { events[n] = f }, get: name => (name === 'credentials' ? credentials : undefined), provide: (n, s) => { provided[n] = s }, logger: { info() {}, error() {} } } }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const idsOf = route => route.models.map(m => m.id)

test('filterModels: 画面で決めた表示/非表示は、設定の絞り込みより優先する', () => {
  const base = [{ id: 'a', defaultVisible: true }, { id: 'b', defaultVisible: false }, { id: 'c', defaultVisible: true }]
  assert.deepEqual(filterModels(base, {}).map(m => m.id), ['a', 'c'])
  assert.deepEqual(filterModels(base, { modelFlags: { a: false, b: true } }).map(m => m.id), ['b', 'c'])
  assert.deepEqual(filterModels(base, { visibleModels: ['a'], modelFlags: { c: true } }).map(m => m.id), ['a', 'c'], '許可リストにないモデルも、画面で出せる')
  assert.deepEqual(filterModels(base, { hiddenModels: ['c'], modelFlags: { c: true } }).map(m => m.id), ['a', 'c'], '非表示リストにあるモデルも、画面で出せる')
  assert.deepEqual(filterModels(base, { modelFlags: 'x' }).map(m => m.id), ['a', 'c'], '不正なフラグは無視')
})

test('buildProviderRoute: API 枠は全部隠しても、1つ残してルートを保つ(キー入力欄のため)', () => {
  const api = PROVIDER_PRESETS.opencode.api
  const flags = Object.fromEntries(api.models.map(m => [m.id, false]))
  const route = buildProviderRoute('api', api, {}, 'ja', flags)
  assert.equal(route.models.length, 1)
  const discovered = { ...api, models: [{ id: 'new-only', name: 'New', defaultVisible: false }] }
  assert.deepEqual(buildProviderRoute('api', discovered).models, [{ id: 'new-only', name: 'New' }], 'newly discovered API-only catalog must keep a valid route without visibility flags')
  const sub = PROVIDER_PRESETS.claude.subscription
  assert.equal(buildProviderRoute('subscription', sub, {}, 'ja', Object.fromEntries(sub.models.map(m => [m.id, false]))), null, 'OAuth 枠は全部隠せば、ルートを作らない')
})

test('buildModelsState: ルートごとのモデルと、いま出るかを返す', () => {
  const state = buildModelsState({ modelFlags: { 'anthropic-api': { 'claude-opus-5-5': false, 'claude-sonnet-5': true } } }, 'ja')
  const api = state.groups.find(g => g.routeId === 'anthropic-api')
  assert.equal(api.kind, 'api'); assert.equal(api.label, 'Claude'); assert.equal(api.service, 'Claude')
  const byId = Object.fromEntries(api.models.map(m => [m.id, m]))
  assert.equal(byId['claude-opus-5-5'].visible, false)
  assert.equal(byId['claude-sonnet-5'].visible, true, '既定で非表示のモデルも、画面で出せる')
  assert.equal(byId['claude-sonnet-5-5'].name, 'Claude Sonnet 5.5', '末尾の (API) は付けない(グループ名で区別する)')
  const oauth = state.groups.find(g => g.routeId === 'anthropic')
  assert.equal(oauth.kind, 'subscription'); assert.equal(oauth.label, 'Claude (OAuth)')
  assert.deepEqual(state.groups.map(g => g.routeId), ['anthropic', 'anthropic-api', 'openai-codex', 'openai-api', 'google-api', 'xai', 'xai-api', 'opencode', 'commandcode-api'])
  const customs = buildModelsState({ customProviders: { local: { displayName: 'Local', models: [{ id: 'q', name: 'Q' }, { id: 'r', name: 'R' }] }, off: { enabled: false, models: [{ id: 'x' }] } } }, 'ja').groups.filter(g => g.providerId === 'local' || g.providerId === 'off')
  assert.deepEqual(customs.map(g => [g.routeId, g.models.map(m => m.visible)]), [['local', [true, true]], ['off', [false]]])
})

test('buildModelsState: API 枠の最後の1つは lastLocked(隠せない目印)', () => {
  const hideAllButOne = Object.fromEntries(PROVIDER_PRESETS.commandcode.api.models.slice(1).map(m => [m.id, false]))
  const state = buildModelsState({ modelFlags: { 'commandcode-api': hideAllButOne } }, 'ja')
  assert.equal(state.groups.find(g => g.routeId === 'commandcode-api').lastLocked, true)
  assert.equal(state.groups.find(g => g.routeId === 'anthropic-api').lastLocked, false)
  assert.equal(state.groups.find(g => g.routeId === 'anthropic').lastLocked, false, 'OAuth 枠は全部隠せる')
})

test('トグル: 表示/非表示が、ルートへ即反映され、保存される', async () => {
  reset()
  const { ctx, entry, provided } = fakeContext()
  apply(ctx, {})
  await flush()
  const service = provided.modelRoutesModels
  assert.ok(idsOf(entry.options.config.providers['anthropic-api']).includes('claude-opus-5-5'))
  let state = await service.setModelVisible('anthropic-api', 'claude-opus-5-5', false)
  assert.ok(!idsOf(entry.options.config.providers['anthropic-api']).includes('claude-opus-5-5'), 'モデル一覧から消える')
  assert.equal(state.groups.find(g => g.routeId === 'anthropic-api').models.find(m => m.id === 'claude-opus-5-5').visible, false)
  assert.deepEqual(readSaved().models, { 'anthropic-api': { 'claude-opus-5-5': false } })
  // 既定で非表示のモデルを出す
  await service.setModelVisible('anthropic-api', 'claude-sonnet-5', true)
  assert.ok(idsOf(entry.options.config.providers['anthropic-api']).includes('claude-sonnet-5'))
  // OAuth 枠も別に決められる
  await service.setModelVisible('anthropic', 'claude-haiku-4-5', false)
  assert.ok(!idsOf(entry.options.config.providers.anthropic).includes('claude-haiku-4-5'))
  assert.ok(idsOf(entry.options.config.providers['anthropic-api']).includes('claude-haiku-4-5'), 'API 枠には影響しない')
  // 既定に戻す
  state = await service.resetModels('anthropic-api')
  assert.ok(idsOf(entry.options.config.providers['anthropic-api']).includes('claude-opus-5-5'))
  assert.ok(!idsOf(entry.options.config.providers['anthropic-api']).includes('claude-sonnet-5'))
  assert.deepEqual(readSaved().models, { anthropic: { 'claude-haiku-4-5': false } }, '戻したルートの設定は消える')
})

test('トグル: 再起動(読み直し)後も、画面で決めた表示が残る', async () => {
  reset()
  const first = fakeContext(); apply(first.ctx, {}); await flush()
  await first.provided.modelRoutesModels.setModelVisible('google-api', 'gemini-3.8-flash', false)
  const second = fakeContext(); apply(second.ctx, {}); await flush()
  assert.deepEqual(idsOf(second.entry.options.config.providers['google-api']), ['gemini-3.1-pro-preview'])
})

test('トグル: API 枠の最後の1つは隠せない。OAuth 枠は全部隠せる', async () => {
  reset()
  const { ctx, entry, provided } = fakeContext(); apply(ctx, {}); await flush()
  const service = provided.modelRoutesModels
  await service.setModelVisible('google-api', 'gemini-3.8-flash', false)
  await assert.rejects(service.setModelVisible('google-api', 'gemini-3.1-pro-preview', false), /少なくとも1つ/)
  assert.deepEqual(idsOf(entry.options.config.providers['google-api']), ['gemini-3.1-pro-preview'])
  for (const model of PROVIDER_PRESETS.claude.subscription.models.filter(m => m.defaultVisible !== false)) await service.setModelVisible('anthropic', model.id, false)
  assert.equal(entry.options.config.providers.anthropic, undefined, '全部隠すと、OAuth 枠のルートは作らない')
  const state = await service.getModels()
  assert.equal(state.groups.find(g => g.routeId === 'anthropic').models.filter(m => m.visible).length, 0, 'でも、トグルの一覧には出る(あとで戻せる)')
})

test('トグル: 未知のルート・モデルは拒否する', async () => {
  reset()
  const { ctx, provided } = fakeContext(); apply(ctx, {}); await flush()
  const service = provided.modelRoutesModels
  await assert.rejects(service.setModelVisible('nope', 'x', true), /未知/)
  await assert.rejects(service.setModelVisible('anthropic-api', 'not-a-model', true), /未知/)
  await assert.rejects(service.resetModels('nope'), /未知/)
})

test('トグル: メッセージは言語(ja/en/zh)で返す', async () => {
  const { createMessages } = await import('../lib/auth-messages.js')
  const make = lang => createModelsService({ state: () => ({ groups: [] }), setFlag: async () => {}, reset: async () => {}, messages: createMessages(() => lang) })
  await assert.rejects(make('en').setModelVisible('x', 'y', true), /Unknown subscription route/)
  await assert.rejects(make('zh').resetModels('x'), /未知/)
})

test('保存ファイル: 壊れた models や不正なID・値は無視する', async () => {
  reset()
  fsSync.mkdirSync(path.join(TEST_HOME, 'storages', 'model-routes'), { recursive: true })
  fsSync.writeFileSync(path.join(TEST_HOME, 'storages', 'model-routes', 'overrides.json'), JSON.stringify({ providers: {}, customProviders: {}, owned: {}, manual: {}, models: { 'anthropic-api': { 'claude-opus-5-5': false, '../x': true, ok: 'yes' }, 'Bad Route': { a: true }, other: 'x' } }))
  const { ctx, entry } = fakeContext(); apply(ctx, {}); await flush()
  assert.ok(!idsOf(entry.options.config.providers['anthropic-api']).includes('claude-opus-5-5'))
})

// ───────── 旧ルートの引き継ぎ ─────────
test('legacyShape: 標準的な手書きルートだけを見分ける', () => {
  const api = PROVIDER_PRESETS.claude.api, sub = PROVIDER_PRESETS.claude.subscription
  assert.deepEqual(legacyShape({ displayName: 'Claude (API)', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-sonnet-5-5', name: 'x', contextWindow: 1 }] }, api), { listed: ['claude-sonnet-5-5'] })
  assert.deepEqual(legacyShape({ displayName: 'Claude (サブスク)', models: [{ id: 'claude-opus-5-5' }] }, sub), { listed: ['claude-opus-5-5'] })
  assert.deepEqual(legacyShape({ models: [] }, sub), { listed: [] })
  assert.deepEqual(legacyShape({}, sub), { listed: null })
  for (const [existing, route, why] of [
    [{ headers: { a: 'b' } }, api, '独自ヘッダー'],
    [{ apiKey: 'sk-x' }, api, '直書きのキー'],
    [{ displayName: '社内用 Claude' }, api, '独自の表示名'],
    [{ baseURL: 'https://proxy.example/v1' }, api, '別のエンドポイント'],
    [{ apiKeyEnv: 'MY_KEY' }, api, '別のキー名'],
    [{ models: [{ id: 'my-private-model' }] }, api, 'カタログにないモデル'],
    [{ compat: {} }, api, '独自の設定項目'],
    [{ api: 'openai-completions' }, sub, 'OAuth 枠に api は不要'],
    [{ apiKeyEnv: 'ANTHROPIC_API_KEY' }, sub, 'OAuth 枠にキー名は不要'],
    [null, api, '空'],
  ]) assert.equal(legacyShape(existing, route), null, why)
})

test('flagsFromListed: 旧ルートの絞り込みを、既定との差だけのフラグにする', () => {
  const sub = PROVIDER_PRESETS.claude.subscription
  assert.equal(flagsFromListed(null, sub), null)
  assert.equal(flagsFromListed([], sub), null, '空の一覧は絞り込みとみなさない')
  const defaults = sub.models.filter(m => m.defaultVisible !== false).map(m => m.id)
  assert.equal(flagsFromListed(defaults, sub), null, '既定と同じなら不要')
  const flags = flagsFromListed(['claude-sonnet-5-5', 'claude-fable-5'], sub)
  assert.equal(flags['claude-fable-5'], true, '既定で非表示のモデルを出していた')
  assert.equal(flags['claude-opus-5-5'], false, '既定で表示のモデルを外していた')
  assert.equal(flags['claude-sonnet-5-5'], undefined)
})


test('Models-owned route RPC recovers disabled API/OAuth/custom routes without changing credentials', async () => {
  reset()
  const { ctx, entry, provided } = fakeContext()
  const config = { providers: { claude: { api: { enabled: false }, subscription: { enabled: false } } }, customProviders: { local: { enabled: false, api: 'openai-completions', baseURL: 'http://localhost:1234/v1', apiKeyEnv: 'LOCAL_KEY', models: [{ id: 'local-model' }] } } }
  apply(ctx, config); await flush()
  const service = provided.modelRoutesModels
  let state = await service.getModels()
  for (const id of ['anthropic-api', 'anthropic', 'local']) {
    assert.equal(state.groups.find(g => g.routeId === id).enabled, false)
    assert.equal(entry.options.config.providers[id], undefined, 'disabled routes must not submit invalid empty models to pi-ai')
    state = await service.setRouteEnabled(id, true)
    assert.equal(state.groups.find(g => g.routeId === id).enabled, true)
    assert.ok(entry.options.config.providers[id].models.length > 0)
  }
  await service.setModelVisible('anthropic-api', 'claude-opus-5-5', false)
  state = await service.setRouteEnabled('anthropic-api', false)
  assert.equal(entry.options.config.providers['anthropic-api'], undefined)
  state = await service.setRouteEnabled('anthropic-api', true)
  assert.equal(entry.options.config.providers['anthropic-api'].apiKeyEnv, 'ANTHROPIC_API_KEY', 'standard key editor metadata restored')
  assert.ok(!idsOf(entry.options.config.providers['anthropic-api']).includes('claude-opus-5-5'), 'model choice preserved')
  await assert.rejects(service.setRouteEnabled('unknown', true), /未知/)
  await assert.rejects(service.setRouteEnabled('local', 'yes'), /Invalid enabled/)
})

test('Models-owned route RPC preserves manual route rejection', async () => {
  reset()
  const { ctx, provided } = fakeContext({ 'anthropic-api': { displayName: 'Private', headers: { 'x-custom': 'not-a-secret' }, models: [{ id: 'private-model' }] } })
  apply(ctx, {}); await flush()
  await assert.rejects(provided.modelRoutesModels.setRouteEnabled('anthropic-api', false), /手動設定/)
})

test('モデル状態: 各ルートの登録状態を返し、判定できないときは null', () => {
  const state = buildModelsState({}, 'ja', { 'anthropic-api': true, anthropic: false })
  const byRoute = Object.fromEntries(state.groups.map(g => [g.routeId, g]))
  assert.equal(byRoute['anthropic-api'].registered, true)
  assert.equal(byRoute.anthropic.registered, false)
  assert.equal(byRoute.opencode.registered, null, '判定結果が無いルート')
  assert.equal(byRoute['xai-api'].service, 'Grok', 'サービス名はカードの表示名と同じ')
})

test('取得したモデル一覧: 控えに重ね、新しいものは既定で非表示、提供終了のものは外す', () => {
  const base = [{ id: 'a', name: 'A', defaultVisible: true }, { id: 'gone', name: 'Gone', defaultVisible: true }]
  const merged = mergeLiveModels(base, [{ id: 'b', name: 'B', contextWindow: 1000, input: ['text'] }, { id: 'a', name: 'A live' }])
  assert.deepEqual(merged, [{ id: 'b', name: 'B', defaultVisible: false, contextWindow: 1000, input: ['text'] }, { id: 'a', name: 'A', defaultVisible: true }], '並びは取得した一覧の順(オン・オフで分けない)')
  assert.equal(mergeLiveModels(base, []), base, '取得できなければ控えのまま')
  assert.equal(mergeLiveModels(base, undefined), base)
  // 状態とルートに反映される
  const state = buildModelsState({ liveModels: { 'commandcode-api': [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'new/model', name: 'New' }] } }, 'ja')
  const group = state.groups.find(g => g.routeId === 'commandcode-api')
  assert.deepEqual(group.models.map(m => [m.id, m.visible]), [['deepseek/deepseek-v4-flash', true], ['new/model', false]])
})

test('取得: openai-list は対応 API で絞り、catalog は DSH の llm サービスに聞く', async () => {
  const body = { data: [{ id: 'x/chat', name: 'Chat', context_length: 5000, supported_endpoints: ['/chat/completions'] }, { id: 'claude-only', supported_endpoints: ['/messages'] }, { id: 'no-field' }] }
  const urls = []
  const fetchImpl = async url => { urls.push(url); return { ok: true, json: async () => body } }
  const listed = await discoverRouteModels(PROVIDER_PRESETS.commandcode.api, { fetchImpl })
  assert.deepEqual(urls, ['https://api.commandcode.ai/provider/v1/models'])
  assert.deepEqual(listed, [{ id: 'x/chat', name: 'Chat', contextWindow: 5000 }, { id: 'no-field' }])
  await assert.rejects(discoverRouteModels(PROVIDER_PRESETS.commandcode.api, { fetchImpl: async () => ({ ok: false, status: 404 }) }), /404/)
  const calls = []
  const llm = { discoverModels: async (ns, request) => { calls.push([ns, request]); return [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 9, inputModalities: ['text', 'image'] }] } }
  assert.deepEqual(await discoverRouteModels(PROVIDER_PRESETS.opencode.api, { llm }), [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 9, input: ['text', 'image'] }])
  assert.deepEqual(calls, [['llm-pi-ai', { provider: 'opencode' }]])
  assert.deepEqual(await discoverRouteModels({ provider: 'custom-route', models: [] }, { fetchImpl }), [], '取得方法の無い枠は空')
})

test('取得: exclude で会話に使えない種類を外し、provider で読むカタログを選ぶ', async () => {
  const calls = []
  const llm = { discoverModels: async (ns, request) => { calls.push(request.provider); return [{ id: 'claude-opus-5-5' }, { id: 'claude-opus-4-5-20251101' }] } }
  assert.deepEqual((await discoverRouteModels(PROVIDER_PRESETS.claude.api, { llm })).map(m => m.id), ['claude-opus-5-5'], '日付付きの別名は外す')
  assert.deepEqual(calls, ['anthropic'], 'API 枠は公式ルートの同梱カタログを読む')
  const google = { discoverModels: async () => [{ id: 'gemini-3.8-flash' }, { id: 'deep-research-preview-04-2026' }, { id: 'gemini-3.1-flash-lite-image' }] }
  assert.deepEqual((await discoverRouteModels(PROVIDER_PRESETS.google.api, { llm: google })).map(m => m.id), ['gemini-3.8-flash'])
  // 足したモデルには、控えと同じ「(API)」を付ける
  const merged = mergeLiveModels(PROVIDER_PRESETS.xai.api.models, [{ id: 'grok-4.7' }, { id: 'grok-9', name: 'Grok 9' }])
  assert.equal(merged.find(m => m.id === 'grok-9').name, 'Grok 9 (API)')
})

test('並び: 系列ごとに新しい版から。日付付きは同じ版の後ろ。会話に使えない種類は外す', () => {
  assert.deepEqual(modelVersionOf('gpt-6.1-sol'), { family: 'gpt', version: [6, 1], date: '' })
  assert.deepEqual(modelVersionOf('claude-opus-4-5-20251101'), { family: 'claude', version: [4, 5], date: '20251101' })
  assert.deepEqual(modelVersionOf('deepseek/deepseek-v4-flash'), { family: 'deepseek', version: [4], date: '' })
  const ids = ['omni-moderation-latest', 'gpt-live-transcribe', 'gpt-5.6-luna', 'gpt-realtime-2', 'gpt-5-search-api', 'gpt-5.5-2026-04-23', 'tts-1', 'gpt-5-mini', 'o3-mini', 'gpt-6.1-sol', 'gpt-5.5', 'o4-mini', 'text-embedding-3-large', 'gpt-image-1']
  const sorted = sortModelsNewestFirst(ids.filter(isChatModel).map(id => ({ id }))).map(m => m.id)
  assert.deepEqual(sorted, ['gpt-6.1-sol', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-2026-04-23', 'gpt-5-mini', 'o4-mini', 'o3-mini'])
})

test('DSH の「利用可能なモデルを取得」: このプラグインのルートだけ並べ替え、外すと元に戻す', async () => {
  reset()
  const raw = [{ id: 'tts-1' }, { id: 'gpt-5.5' }, { id: 'gpt-6.1-sol' }, { id: 'omni-moderation-latest' }]
  const llm = { discoverModels: async () => raw.map(m => ({ ...m })) }
  const original = llm.discoverModels
  const disposers = []
  const { ctx } = fakeContext()
  ctx.get = name => (name === 'llm' ? llm : undefined)
  ctx.effect = fn => { disposers.push(fn()) }
  apply(ctx, {}); await flush()
  assert.deepEqual((await llm.discoverModels('llm-pi-ai', { provider: 'openai-api' })).map(m => m.id), ['gpt-6.1-sol', 'gpt-5.5'])
  assert.deepEqual((await llm.discoverModels('llm-pi-ai', { provider: 'someone-else' })).map(m => m.id), raw.map(m => m.id), '他のルートは触らない')
  for (const dispose of disposers) dispose?.()
  assert.equal(llm.discoverModels, original)
})

test('並び: 取得結果が無いときも、控えを同じ規則で並べる', () => {
  const base = { provider: 'x', models: [{ id: 'gpt-5.5', name: 'A' }, { id: 'gpt-6.1-sol', name: 'B' }, { id: 'gpt-6-astra', name: 'C' }] }
  assert.deepEqual(liveRoute(base, undefined).models.map(m => m.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5'])
  assert.deepEqual(base.models.map(m => m.id), ['gpt-5.5', 'gpt-6.1-sol', 'gpt-6-astra'], '控えそのものは変えない')
})

test('追加アカウント: 番号付きのキー名で別ルートを作り、外すと消す', async () => {
  reset()
  fsSync.mkdirSync(path.join(TEST_HOME, 'storages', 'model-routes'), { recursive: true })
  fsSync.writeFileSync(path.join(TEST_HOME, 'storages', 'model-routes', 'setup.json'), JSON.stringify({ accounts: { 'anthropic-api': [2], opencode: [2] } }))
  const { ctx, entry, provided } = fakeContext(); apply(ctx, {}); await flush()
  const alt = entry.options.config.providers['anthropic-api-2']
  assert.equal(alt.apiKeyEnv, 'ANTHROPIC_API_KEY_2')
  assert.equal(alt.displayName, 'Claude #2')
  assert.deepEqual(alt.models.map(m => m.id), entry.options.config.providers['anthropic-api'].models.map(m => m.id), '表示するモデルは本体と同じ')
  assert.equal(entry.options.config.providers['opencode-2'], undefined, 'OpenCode Zen は追加アカウントを作れない')
  const state = await provided.modelRoutesSetup.removeAccount('anthropic-api-2')
  assert.equal(entry.options.config.providers['anthropic-api-2'], undefined)
  assert.equal(state.accounts.find(a => a.routeId === 'anthropic-api').accounts.length, 1)
  const added = await provided.modelRoutesSetup.addAccount('anthropic-api')
  assert.deepEqual(added.accounts.find(a => a.routeId === 'anthropic-api').accounts.map(a => a.routeId), ['anthropic-api', 'anthropic-api-2'])
  await assert.rejects(provided.modelRoutesSetup.addAccount('opencode'), /作れません/)
})
