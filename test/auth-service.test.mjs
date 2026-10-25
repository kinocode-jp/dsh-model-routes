import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthService } from '../lib/auth-service.js'
import { activeKey, slotKey, createOauthAccounts } from '../lib/oauth-accounts.js'

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

// 模擬の認証サービス。DSH の AuthorizationService と同じ begin/cancel/describe の形。
function fakeEnv({ flow } = {}) {
  const records = new Map()
  const log = []
  const running = new Map()
  const credentials = {
    describeRecord: async key => ({ configured: records.has(key) }),
    readRecord: async key => records.get(key),
    deleteRecord: async key => { records.delete(key); log.push(['delete', key]) },
  }
  const authorization = {
    describe: key => key === 'llm-pi-ai/anthropic' || key === 'llm-pi-ai/xai' ? { key, label: 'x', methods: [{ id: 'oauth' }, { id: 'api-key' }] } : key === 'llm-pi-ai/openai-codex' ? { key, label: 'x', methods: [{ id: 'oauth' }] } : undefined,
    cancel: key => { running.get(key)?.abort() },
    async begin({ key, method, signal, interaction }) {
      log.push(['begin', key, method])
      const controller = new AbortController()
      running.set(key, controller)
      signal.addEventListener('abort', () => controller.abort(), { once: true })
      try {
        const outcome = await (flow ?? defaultFlow)({ key, interaction, signal: controller.signal, records })
        return outcome
      } finally { running.delete(key) }
    },
  }
  const targets = () => [
    { providerId: 'claude', routeId: 'anthropic', label: 'Claude' },
    { providerId: 'openai', routeId: 'openai-codex', label: 'OpenAI' },
    { providerId: 'xai', routeId: 'xai', label: 'xAI Grok' },
  ]
  return { records, log, service: createAuthService({ authorization: () => authorization, credentials: () => credentials, targets, logger: { warn: m => log.push(['warn', m]) } }) }
}

// 認証URLを知らせ、コードを求め、受け取ったら記録を保存する。
async function defaultFlow({ key, interaction, signal, records }) {
  interaction.notify({ message: 'ブラウザで開いてください', url: 'https://claude.ai/oauth/authorize?x=1' })
  const code = await new Promise((resolve, reject) => {
    interaction.prompt({ kind: 'text', message: 'コードを貼ってください', placeholder: 'code#state' }).then(resolve, reject)
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  if (signal.aborted) return { status: 'cancelled' }
  records.set(key, { kind: 'grant', payload: { type: 'oauth', access: 'SECRET-ACCESS', refresh: 'SECRET-REFRESH', code } })
  return { status: 'authorized' }
}

test('状態: サブスク枠ごとの登録とログイン可否を返し、秘密情報は含めない', async () => {
  const { service, records } = fakeEnv()
  records.set('llm-pi-ai/anthropic', { kind: 'grant', payload: { type: 'oauth', access: 'SECRET-ACCESS', refresh: 'SECRET-REFRESH' } })
  const state = await service.getAuthState()
  assert.deepEqual(state.routes.map(r => [r.routeId, r.registered, r.credentialType, r.canLogin]), [
    ['anthropic', true, 'oauth', true], ['openai-codex', false, null, true], ['xai', false, null, true],
  ])
  assert.equal(state.attempt, null)
  assert.ok(!JSON.stringify(state).includes('SECRET'))
})

test('ログイン: 認証URLが見え、コードを渡すと登録される', async () => {
  const { service, records, log } = fakeEnv()
  let attempt = await service.startLogin('anthropic')
  assert.equal(attempt.routeId, 'anthropic')
  await tick(5)
  attempt = await service.getAttempt()
  assert.equal(attempt.phase, 'prompt')
  assert.equal(attempt.notices[0].url, 'https://claude.ai/oauth/authorize?x=1')
  assert.equal(attempt.prompt.kind, 'text')
  assert.deepEqual(log[0], ['begin', 'llm-pi-ai/anthropic', 'oauth'])
  attempt = await service.answerPrompt(attempt.prompt.id, 'abc#def')
  await tick(5)
  attempt = await service.getAttempt()
  assert.equal(attempt.phase, 'done')
  assert.equal(attempt.prompt, null)
  assert.ok(records.has('llm-pi-ai/anthropic'))
  const state = await service.getAuthState()
  assert.equal(state.routes[0].registered, true)
  assert.ok(!JSON.stringify(state).includes('SECRET'))
  assert.ok(!JSON.stringify(attempt).includes('abc#def'), '入力したコードを状態に残さない')
  // 終了後は表示を消せる
  const after = await service.dismissAttempt()
  assert.equal(after.attempt, null)
})

test('ログイン: 取り消すと cancelled になり、保存されない', async () => {
  const { service, records } = fakeEnv()
  await service.startLogin('anthropic')
  await tick(5)
  const cancelled = await service.cancelLogin()
  assert.equal(cancelled.phase, 'cancelled')
  await tick(5)
  assert.equal((await service.getAttempt()).phase, 'cancelled')
  assert.equal(records.has('llm-pi-ai/anthropic'), false)
  // 取り消し後は、新しいログインを始められる
  const next = await service.startLogin('anthropic')
  assert.ok(['running', 'prompt'].includes(next.phase), next.phase)
  await service.cancelLogin()
})

test('ログイン: 進行中は2つ目を始められない', async () => {
  const { service } = fakeEnv()
  await service.startLogin('anthropic')
  await tick(5)
  await assert.rejects(service.startLogin('xai'), /進行中/)
  await service.cancelLogin()
})

test('ログイン: 失敗するとエラー内容が見える', async () => {
  const { service, log } = fakeEnv({ flow: async () => { throw new Error('invalid_grant: token endpoint rejected') } })
  await service.startLogin('anthropic')
  await tick(5)
  const attempt = await service.getAttempt()
  assert.equal(attempt.phase, 'error')
  assert.match(attempt.error, /invalid_grant/)
  assert.ok(log.some(entry => entry[0] === 'warn'))
})

test('入力: 期限切れ・別のIDは受け付けない', async () => {
  const { service } = fakeEnv()
  await assert.rejects(service.answerPrompt('p1', 'x'), /受け付けていません/)
  await service.startLogin('anthropic')
  await tick(5)
  await assert.rejects(service.answerPrompt('p999', 'x'), /受け付けていません/)
  await service.cancelLogin()
})

test('通知のURLは http(s) だけを通す', async () => {
  const { service } = fakeEnv({ flow: async ({ interaction }) => {
    interaction.notify({ message: 'a', url: 'javascript:alert(1)' })
    interaction.notify({ message: 'b', url: 'https://example.com/x' })
    interaction.notify({ message: 'c', code: 'ABCD-1234', url: 'https://example.com/device' })
    return { status: 'authorized' }
  } })
  await service.startLogin('xai')
  await tick(5)
  const attempt = await service.getAttempt()
  assert.equal(attempt.notices[0].url, undefined)
  assert.equal(attempt.notices[1].url, 'https://example.com/x')
  assert.equal(attempt.notices[2].code, 'ABCD-1234')
})

test('対象外のルート・OAuthのないサービスは拒否する', async () => {
  const { service } = fakeEnv()
  await assert.rejects(service.startLogin('anthropic-api'), /未知/)
  await assert.rejects(service.startLogin('../etc'), /未知/)
  await assert.rejects(service.logout('anthropic-api'), /未知/)
})

test('ログアウト: 保存済みのログインを削除する(ログイン中は拒否)', async () => {
  const { service, records, log } = fakeEnv()
  records.set('llm-pi-ai/xai', { kind: 'grant', payload: { type: 'oauth' } })
  const state = await service.logout('xai')
  assert.equal(state.routes.find(r => r.routeId === 'xai').registered, false)
  assert.deepEqual(log.at(-1), ['delete', 'llm-pi-ai/xai'])
  await service.startLogin('xai')
  await tick(5)
  await assert.rejects(service.logout('xai'), /ログイン中/)
  await service.cancelLogin()
})

test('認証サービスが無いときは、分かりやすいエラーにする', async () => {
  const service = createAuthService({ authorization: () => undefined, credentials: () => undefined, targets: () => [{ providerId: 'claude', routeId: 'anthropic', label: 'Claude' }] })
  await assert.rejects(service.startLogin('anthropic'), /認証サービス/)
  const state = await service.getAuthState()
  assert.equal(state.routes[0].canLogin, false)
  assert.equal(state.routes[0].registered, false)
})

// Anthropic のログインと同じ流れ: 先にログイン方法を選ばせ、その id で分岐する(pi-ai の実装どおり)。
async function anthropicLikeFlow({ key, interaction, signal, records }) {
  const method = await interaction.prompt({
    kind: 'select', message: 'Select Anthropic login method:',
    options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'copy_code', label: 'Copy code login (headless)' }],
  })
  if (method !== 'browser' && method !== 'copy_code') throw new Error(`Unknown Anthropic login method: ${method}`)
  interaction.notify({ message: 'Complete login in your browser.', url: 'https://claude.ai/oauth/authorize?x=1' })
  records.set(key, { kind: 'grant', payload: { type: 'oauth', method } })
  return { status: 'authorized' }
}

test('選択肢: id と表示名を両方残し、id で答えるとログインできる', async () => {
  const { service, records } = fakeEnv({ flow: anthropicLikeFlow })
  await service.startLogin('anthropic')
  await tick(5)
  let attempt = await service.getAttempt()
  assert.equal(attempt.phase, 'prompt')
  assert.equal(attempt.prompt.kind, 'select')
  assert.deepEqual(attempt.prompt.options, [{ id: 'browser', label: 'Browser login (default)' }, { id: 'copy_code', label: 'Copy code login (headless)' }])
  await service.answerPrompt(attempt.prompt.id, attempt.prompt.options[0].id)
  await tick(5)
  attempt = await service.getAttempt()
  assert.equal(attempt.phase, 'done')
  assert.equal(attempt.notices[0].url, 'https://claude.ai/oauth/authorize?x=1')
  assert.equal(records.get('llm-pi-ai/anthropic').payload.method, 'browser')
})

test('選択肢: 表示名で答えると、pi-ai と同じ「Unknown Anthropic login method」になる(回帰の確認)', async () => {
  const { service } = fakeEnv({ flow: anthropicLikeFlow })
  await service.startLogin('anthropic')
  await tick(5)
  const attempt = await service.getAttempt()
  await service.answerPrompt(attempt.prompt.id, 'Browser login (default)')
  await tick(5)
  const failed = await service.getAttempt()
  assert.equal(failed.phase, 'error')
  assert.match(failed.error, /Unknown Anthropic login method: Browser login \(default\)/)
})

test('選択肢: 文字列だけの選択肢も id と表示名にそろえる', async () => {
  const { service } = fakeEnv({ flow: async ({ interaction }) => { await interaction.prompt({ kind: 'select', message: 'm', options: ['a', 'b'] }); return { status: 'authorized' } } })
  await service.startLogin('xai')
  await tick(5)
  assert.deepEqual((await service.getAttempt()).prompt.options, [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }])
  await service.cancelLogin()
})

test('メッセージ: ホストの言語(ja/en/zh)でエラーを返し、未知の言語は ja', async () => {
  const { createMessages } = await import('../lib/auth-messages.js')
  const make = locale => createAuthService({ authorization: () => undefined, credentials: () => undefined, targets: () => [{ providerId: 'claude', routeId: 'anthropic', label: 'Claude' }], messages: createMessages(() => locale) })
  await assert.rejects(make('ja').startLogin('anthropic'), /認証サービス/)
  await assert.rejects(make('en').startLogin('anthropic'), /authorization service was not found/)
  await assert.rejects(make('zh').startLogin('anthropic'), /授权服务/)
  await assert.rejects(make('fr').startLogin('anthropic'), /認証サービス/)
  await assert.rejects(make('en').startLogin('nope'), /Unknown subscription route/)
})

for (const next of ['login', 'switch']) test(`logout deletion serializes with subsequent ${next}`, async () => {
  const route = 'anthropic', grant = access => ({ kind: 'grant', payload: { access } })
  let meta = { [route]: { active: 1, accounts: [1, 2], labels: {} } }, auth, release, entered
  const gate = new Promise(resolve => { release = resolve })
  const deleting = new Promise(resolve => { entered = resolve })
  const records = new Map([[activeKey(route), grant('A')], [slotKey(route, 1), grant('A')], [slotKey(route, 2), grant('B')]])
  let began = false, activeWrites = 0
  const credentials = {
    readRecord: async key => records.get(key),
    describeRecord: async key => ({ configured: records.has(key) }),
    modifyRecord: async (key, fn) => { if (key === activeKey(route)) activeWrites++; records.set(key, await fn(records.get(key))) },
    deleteRecord: async key => { entered(); await gate; records.delete(key) },
  }
  const oauth = createOauthAccounts({ credentials: () => credentials, get: () => meta, save: async value => { meta = value }, isLoginActive: id => auth.isLoginActive(id) })
  auth = createAuthService({
    credentials: () => credentials, targets: () => [{ providerId: 'synthetic', routeId: route, label: 'synthetic' }],
    withAccountLock: (id, run) => oauth.withRoute(id, run),
    authorization: () => ({ describe: () => ({ methods: [{ id: 'oauth' }] }), async begin() {
      began = true; await credentials.modifyRecord(activeKey(route), async () => grant('new-login')); return { status: 'authorized' }
    } }),
  })
  const loggingOut = auth.logout(route)
  await deleting
  const following = next === 'login' ? auth.startLogin(route) : oauth.switchTo(route, 2)
  await tick()
  assert.equal(began, false); assert.equal(activeWrites, 0)
  release(); await Promise.all([loggingOut, following]); await tick()
  assert.equal(records.get(activeKey(route)).payload.access, next === 'login' ? 'new-login' : 'B')
  assert.equal(meta[route].active, next === 'login' ? 1 : 2)
})

test('logout respects rejection from the account coordinator before deleting credentials', async () => {
  let deletes = 0
  const auth = createAuthService({
    credentials: () => ({ deleteRecord: async () => { deletes++ } }),
    targets: () => [{ routeId: 'anthropic', label: 'synthetic' }],
    withAccountLock: async () => { throw new Error('route quarantined') },
  })
  await assert.rejects(auth.logout('anthropic'), /route quarantined/)
  assert.equal(deletes, 0)
})

test('認証開始の同期例外でもルートの所有権を解放する', async () => {
  const service = createAuthService({
    credentials: () => ({}), targets: () => [{ routeId: 'anthropic', label: 'synthetic' }],
    authorization: () => ({ describe: () => ({ methods: [{ id: 'oauth' }] }), begin() { throw new Error('synthetic start failure') } }),
  })
  await assert.rejects(service.startLogin('anthropic'), /synthetic start failure/)
  assert.equal(service.isLoginActive('anthropic'), false)
  assert.equal((await service.getAttempt()).phase, 'error')
  await assert.rejects(service.startLogin('anthropic'), /synthetic start failure/)
})

test('認証失敗でもルートの所有権を解放する', async () => {
  const { service } = fakeEnv({ flow: async () => { throw new Error('synthetic failure') } })
  await service.startLogin('anthropic'); await tick()
  assert.equal(service.isLoginActive('anthropic'), false)
  assert.equal((await service.getAttempt()).phase, 'error')
})

test('メッセージ: 3言語の辞書は同じキーと置換語を持つ', async () => {
  const { AUTH_MESSAGES } = await import('../lib/auth-messages.js')
  const params = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
  assert.deepEqual(Object.keys(AUTH_MESSAGES.en).sort(), Object.keys(AUTH_MESSAGES.ja).sort())
  assert.deepEqual(Object.keys(AUTH_MESSAGES.zh).sort(), Object.keys(AUTH_MESSAGES.ja).sort())
  for (const key of Object.keys(AUTH_MESSAGES.ja)) for (const lang of ['en', 'zh']) assert.deepEqual(params(AUTH_MESSAGES[lang][key]), params(AUTH_MESSAGES.ja[key]), key)
})
