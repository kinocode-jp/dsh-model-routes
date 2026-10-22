import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuthService } from '../lib/auth-service.js'
import { createModelsService } from '../lib/models-service.js'
import { TYPERT } from '../lib/typert.host.js'

// 本物の DSH ランタイム(認証サービス・資格情報ストア・Typert ゲートウェイ)での検証。
// DSH_RUNTIME_ROOT=インストール済み DSH のディレクトリ。無ければ skip する(DSH_REQUIRE_RUNTIME=1 で必須)。
const runtime = process.env.DSH_RUNTIME_ROOT || '/tmp/dshx/dsh'
let mod
try {
  const require = createRequire(path.join(runtime, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const [cordis, registry, gateway, credentials, authorization, loader] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-api-gateway'),
    load('@deepseek-ai/dsh-credentials-local'), load('@deepseek-ai/dsh-authorization'), load('@deepseek-ai/dsh-typert-loader'),
  ])
  mod = { cordis, registry, gateway, credentials, authorization, loader }
} catch (error) {
  if (process.env.DSH_RUNTIME_ROOT) throw error
}
if (!mod && process.env.DSH_REQUIRE_RUNTIME === '1') throw new Error('DSH_REQUIRE_RUNTIME=1 ですがDSHランタイムを解決できません')

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await tick(20) }
  throw new Error('待機がタイムアウトしました: ' + label)
}

test('本物の認証サービス・資格情報ストアで、ログインからログアウトまで通る', { skip: !mod && 'DSH ランタイムが無いため skip' }, async t => {
  const { Context } = mod.cordis
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-routes-auth-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await fs.rm(dir, { recursive: true, force: true }) })
  await ctx.plugin(mod.credentials.default, { path: path.join(dir, '.credentials.yaml') })
  await ctx.plugin(mod.authorization.default)

  // llm-pi-ai と同じ形のフロー: 認証URLを知らせ、コードを求め、記録を保存する。
  const key = 'llm-pi-ai/anthropic'
  ctx.authorization.registerFlow({
    key, label: 'Claude', methods: [{ id: 'oauth', label: 'OAuth' }, { id: 'api-key', label: 'API key' }],
    async run(session) {
      // Anthropic と同じく、先にログイン方法を選ばせる。選択肢は { id, label }。
      const method = await session.prompt({ kind: 'select', message: 'Select login method:', options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'copy_code', label: 'Copy code login' }] })
      if (method !== 'browser' && method !== 'copy_code') throw new Error('Unknown login method: ' + method)
      session.notify({ message: 'ブラウザで開いてください', url: 'https://claude.ai/oauth/authorize?state=1' })
      const code = await session.prompt({ kind: 'text', message: 'コードを貼ってください' })
      if (code !== 'good-code') throw new Error('invalid_grant: bad code')
      await session.commit({ kind: 'grant', payload: { type: 'oauth', access: 'SECRET-ACCESS', refresh: 'SECRET-REFRESH', expires: Date.now() + 3600_000 } })
    },
  })

  const service = createAuthService({
    authorization: () => ctx.authorization, credentials: () => ctx.credentials,
    targets: () => [{ providerId: 'claude', routeId: 'anthropic', label: 'Claude' }],
  })
  let state = await service.getAuthState()
  assert.deepEqual(state.routes[0], { providerId: 'claude', routeId: 'anthropic', label: 'Claude', registered: false, credentialType: null, canLogin: true })

  // 間違ったコード: エラーになり、保存されない
  await service.startLogin('anthropic')
  let attempt = await until(async () => { const a = await service.getAttempt(); return a?.phase === 'prompt' ? a : null }, 'ログイン方法の選択待ち')
  assert.equal(attempt.prompt.kind, 'select')
  assert.deepEqual(attempt.prompt.options.map(o => o.id), ['browser', 'copy_code'])
  await service.answerPrompt(attempt.prompt.id, 'browser')
  attempt = await until(async () => { const a = await service.getAttempt(); return a?.phase === 'prompt' && a.prompt.kind === 'text' ? a : null }, 'コード入力待ち')
  assert.equal(attempt.notices[0].url, 'https://claude.ai/oauth/authorize?state=1')
  await service.answerPrompt(attempt.prompt.id, 'wrong')
  attempt = await until(async () => { const a = await service.getAttempt(); return a?.phase === 'error' ? a : null }, 'エラー')
  assert.match(attempt.error, /invalid_grant/)
  assert.equal((await ctx.credentials.describeRecord(key)).configured, false)

  // 正しいコード: 登録され、イベントが発火する
  const updated = []
  ctx.on('credentials/record-updated', k => { updated.push(k) })
  await service.startLogin('anthropic')
  attempt = await until(async () => { const a = await service.getAttempt(); return a?.phase === 'prompt' && a.prompt.kind === 'select' ? a : null }, '選択待ち2')
  await service.answerPrompt(attempt.prompt.id, attempt.prompt.options[0].id)
  attempt = await until(async () => { const a = await service.getAttempt(); return a?.phase === 'prompt' && a.prompt.kind === 'text' ? a : null }, 'コード入力待ち2')
  await service.answerPrompt(attempt.prompt.id, 'good-code')
  await until(async () => (await service.getAttempt())?.phase === 'done', '完了')
  state = await service.getAuthState()
  assert.equal(state.routes[0].registered, true)
  assert.equal(state.routes[0].credentialType, 'oauth')
  assert.ok(updated.includes(key), 'credentials/record-updated が発火する')
  assert.ok(!JSON.stringify(state).includes('SECRET'), '秘密情報を状態へ出さない')

  // ログアウト
  state = await service.logout('anthropic')
  assert.equal(state.routes[0].registered, false)

  // 取り消し
  await service.startLogin('anthropic')
  await until(async () => (await service.getAttempt())?.phase === 'prompt', 'コード入力待ち3')
  const cancelled = await service.cancelLogin()
  assert.equal(cancelled.phase, 'cancelled')
  await until(async () => !(ctx.authorization.list().find(f => f.key === key)?.inFlight), '取り消し完了')
  assert.equal((await ctx.credentials.describeRecord(key)).configured, false)
  service.dispose()
})

test('本物の Typert ゲートウェイで、ログイン7+モデル表示・ルート4の厳格なメソッドが呼べる', { skip: !mod && 'DSH ランタイムが無いため skip' }, async t => {
  const { Context } = mod.cordis
  mod.loader.validateTypertManifest(TYPERT.package, TYPERT)
  const ctx = new Context()
  const records = new Set()
  const service = createAuthService({
    authorization: () => ({
      describe: () => ({ methods: [{ id: 'oauth' }] }), cancel() {},
      begin: async ({ interaction }) => { interaction.notify({ message: 'open', url: 'https://example.com/auth' }); await interaction.prompt({ kind: 'text', message: 'code' }); records.add('llm-pi-ai/anthropic'); return { status: 'authorized' } },
    }),
    credentials: () => ({ describeRecord: async k => ({ configured: records.has(k) }), readRecord: async k => records.has(k) ? { payload: { type: 'oauth' } } : undefined, deleteRecord: async k => { records.delete(k) } }),
    targets: () => [{ providerId: 'claude', routeId: 'anthropic', label: 'Claude' }],
  })
  t.after(async () => { service.dispose(); await ctx.fiber.dispose() })
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'test-denial' }) })
  await ctx.plugin(mod.registry.TypertRegistry)
  ctx.provide('modelRoutesAuth', service)
  // モデルごとの表示トグル(模擬の状態)
  const group = { providerId: 'claude', kind: 'api', routeId: 'anthropic-api', service: 'Claude', label: 'Claude', enabled: true, lastLocked: false, models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', visible: true, default: true }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', visible: true, default: true }] }
  const modelsService = createModelsService({
    state: () => ({ locale: 'ja', groups: [group] }),
    setRoute: async (providerId, kind, enabled) => { assert.equal(providerId, 'claude'); assert.equal(kind, 'api'); group.enabled = enabled },
    setFlag: async (routeId, modelId, visible) => { group.models.find(m => m.id === modelId).visible = visible },
    reset: async () => { for (const m of group.models) m.visible = m.default },
  })
  ctx.provide('modelRoutesModels', modelsService)
  await ctx.plugin(mod.gateway.TypertGatewayService, { websocketHeartbeatIntervalMs: 30000, streamInboxBytes: 1048576 })
  // パッケージの ./typert export そのものを登録する(別の登録物ではなく)。
  const exported = await import('@kinocode/dsh-model-routes/typert')
  assert.equal(exported.TYPERT, TYPERT)
  ctx.typert.register(exported.TYPERT)
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
  const call = (method, args = {}) => ctx.typertGateway.dispatchRpc('modelRoutesAuth/' + method, { args }, undefined, peer)
  const call2 = (method, args = {}) => ctx.typertGateway.dispatchRpc('modelRoutesModels/' + method, { args }, undefined, peer)

  let reply = await call('getAuthState')
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.routes[0].routeId, 'anthropic')
  reply = await call('startLogin', { routeId: 'anthropic' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.phase, 'prompt')
  const promptId = reply.value.prompt.id
  reply = await call('getAttempt')
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.notices[0].url, 'https://example.com/auth')
  reply = await call('answerPrompt', { promptId, value: 'good' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  await tick(10)
  reply = await call('getAttempt')
  assert.equal(reply.value.phase, 'done')
  reply = await call('dismissAttempt')
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.attempt, null)
  assert.equal((await call('getAttempt')).value, null)
  reply = await call('logout', { routeId: 'anthropic' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.routes[0].registered, false)
  reply = await call('cancelLogin')
  assert.equal(reply.ok, true, JSON.stringify(reply))
  // モデルごとの表示トグル
  reply = await call2('getModels')
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.groups[0].routeId, 'anthropic-api')
  reply = await call2('setModelVisible', { routeId: 'anthropic-api', modelId: 'claude-opus-5-5', visible: false })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.groups[0].models.find(m => m.id === 'claude-opus-5-5').visible, false)
  reply = await call2('resetModels', { routeId: 'anthropic-api' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(reply.value.groups[0].models.find(m => m.id === 'claude-opus-5-5').visible, true)
  for (const [method, args] of [['setModelVisible', { routeId: 'anthropic-api', modelId: '../x', visible: true }], ['setModelVisible', { routeId: 'anthropic-api', modelId: 'a', visible: 'yes' }], ['setModelVisible', { routeId: 'BAD', modelId: 'a', visible: true }], ['resetModels', { routeId: '' }]]) {
    reply = await call2(method, args)
    assert.equal(reply.ok, false, method + ' ' + JSON.stringify(args))
  }
  reply = await call2('setRouteEnabled', { routeId: 'anthropic-api', enabled: false })
   assert.equal(reply.ok, true, JSON.stringify(reply))
   assert.equal(reply.value.groups[0].enabled, false)
   reply = await call2('setRouteEnabled', { routeId: 'anthropic-api', enabled: true })
   assert.equal(reply.value.groups[0].enabled, true)
   for (const args of [{ routeId: 'anthropic-api', enabled: 'yes' }, { routeId: '../bad', enabled: true }, { routeId: 'missing', enabled: true }]) assert.equal((await call2('setRouteEnabled', args)).ok, false)
   // 存在しないモデルは、サービスが拒否する
  reply = await call2('setModelVisible', { routeId: 'anthropic-api', modelId: 'nope', visible: true })
  assert.equal(reply.ok, false)
  // 不正な引数は、サービスに届く前に拒否される
  for (const [method, args] of [['startLogin', { routeId: '../x' }], ['startLogin', { routeId: 5 }], ['answerPrompt', { promptId: 'p 1', value: 'x' }], ['answerPrompt', { promptId: 'p1', value: '' }], ['logout', { routeId: '' }]]) {
    reply = await call(method, args)
    assert.equal(reply.ok, false, method + ' ' + JSON.stringify(args))
  }
})
