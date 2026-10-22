import test from 'node:test'
import assert from 'node:assert/strict'
import { activeKey, createOauthAccounts, normalizeOauth, slotKey } from '../lib/oauth-accounts.js'
import { CHAIN_PROVIDER, createChainAdapter } from '../lib/chains.js'

// DSH の資格情報サービスの代役(記録の読み書きだけ)。
function fakeCredentials(initial = {}) {
  const records = new Map(Object.entries(initial))
  let writes = 0
  return {
    records, get writes() { return writes },
    async readRecord(key) { return records.has(key) ? structuredClone(records.get(key)) : undefined },
    async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next) { records.set(key, structuredClone(next)); writes++ } return next },
    async deleteRecord(key) { records.delete(key) },
  }
}
const grant = token => ({ kind: 'grant', payload: { type: 'oauth', access: token, refresh: 'r-' + token, expires: 1 } })
function bundle(initial) {
  const credentials = fakeCredentials(initial)
  let saved = {}
  const accounts = createOauthAccounts({ credentials: () => credentials, get: () => saved, save: async next => { saved = next } })
  return { credentials, accounts, saved: () => saved }
}

test('設定の検査: 番号と名前を整え、使用中が無ければ先頭にする', () => {
  assert.deepEqual(normalizeOauth({ anthropic: { active: 5, accounts: [2, 1, 1, 10], labels: { 1: ' 仕事 ', 9: 'x' } }, other: { accounts: [1] } }, id => id === 'anthropic'),
    { anthropic: { active: 1, accounts: [1, 2], labels: { 1: '仕事' } } })
})

test('追加: 今のログインを「アカウント 1」として保管し、新しいアカウントを使用中(未ログイン)にする', async () => {
  const { credentials, accounts, saved } = bundle({ [activeKey('anthropic')]: grant('A') })
  assert.equal(await accounts.add('anthropic'), 2)
  assert.deepEqual(saved().anthropic, { active: 2, accounts: [1, 2], labels: {} })
  assert.equal(credentials.records.get(slotKey('anthropic', 1)).payload.access, 'A', '今のログインを保管した')
  assert.equal(credentials.records.has(activeKey('anthropic')), false, '新しいアカウントは未ログイン')
  // 画面からログインすると DSH が使用中の記録を書く。その内容を保管先へ写す。
  credentials.records.set(activeKey('anthropic'), grant('B'))
  await accounts.syncAll()
  assert.equal(credentials.records.get(slotKey('anthropic', 2)).payload.access, 'B')
  const view = await accounts.describe('anthropic')
  assert.deepEqual(view.accounts.map(a => [a.n, a.active, a.signedIn]), [[1, false, true], [2, true, true]])
})

test('切り替え: 使用中を保管してから入れ替え、自動更新されたトークンも失わない', async () => {
  const { credentials, accounts, saved } = bundle({ [activeKey('anthropic')]: grant('A') })
  await accounts.add('anthropic')
  credentials.records.set(activeKey('anthropic'), grant('B'))
  await accounts.syncAll()
  credentials.records.set(activeKey('anthropic'), grant('B-refreshed'))
  assert.equal(await accounts.switchTo('anthropic', 1), true)
  assert.equal(credentials.records.get(activeKey('anthropic')).payload.access, 'A')
  assert.equal(credentials.records.get(slotKey('anthropic', 2)).payload.access, 'B-refreshed', '切り替える前に、更新後のトークンを保管した')
  assert.equal(saved().anthropic.active, 1)
  assert.deepEqual(await accounts.others('anthropic'), [2])
  assert.equal(await accounts.switchTo('anthropic', 1), false, '同じアカウントなら何もしない')
})

test('同期は、内容が同じなら書かない(更新通知の繰り返しで止まらなくならないように)', async () => {
  const { credentials, accounts } = bundle({ [activeKey('anthropic')]: grant('A') })
  await accounts.add('anthropic')
  credentials.records.set(activeKey('anthropic'), grant('B'))
  await accounts.syncAll()
  const before = credentials.writes
  await accounts.syncAll()
  await accounts.syncAll()
  assert.equal(credentials.writes, before)
})

test('外す: 使用中なら残りのアカウントへ切り替え、最後の1つなら束をやめる', async () => {
  const { credentials, accounts, saved } = bundle({ [activeKey('anthropic')]: grant('A') })
  await accounts.add('anthropic')
  credentials.records.set(activeKey('anthropic'), grant('B'))
  await accounts.syncAll()
  await accounts.remove('anthropic', 2)
  assert.equal(credentials.records.get(activeKey('anthropic')).payload.access, 'A')
  assert.equal(credentials.records.has(slotKey('anthropic', 2)), false)
  assert.deepEqual(saved().anthropic.accounts, [1])
  await accounts.remove('anthropic', 1)
  assert.equal(saved().anthropic, undefined)
  assert.equal(credentials.records.has(activeKey('anthropic')), false)
})

test('代替チェーン: サブスクが失敗したら、ほかのログイン済みアカウントへ切り替えて同じモデルで試す', async () => {
  let active = 1
  const switched = []
  const llm = {
    async *stream(options) {
      if (options.provider === 'anthropic' && active === 1) yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'limit' } } }
      else { yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    },
  }
  const setup = { chains: [{ id: 'main', name: 'メイン', steps: [{ provider: 'anthropic', model: 'opus' }, { provider: 'openai-codex', model: 'gpt' }], accounts: true }], accounts: {} }
  const results = []
  const adapter = createChainAdapter(class {}, {
    llm, setup: () => setup, onResult: (id, result) => results.push(result),
    oauthOthers: async provider => provider === 'anthropic' ? [2] : [],
    switchAccount: async (provider, n) => { switched.push([provider, n]); active = n },
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: CHAIN_PROVIDER, model: 'main', messages: [] })) chunks.push(chunk)
  assert.deepEqual(switched, [['anthropic', 2]])
  assert.equal(chunks[0].text, 'ok')
  assert.deepEqual([results[0].provider, results[0].account], ['anthropic', 2], 'セカンダリへ行く前に、同じサービスの別アカウントで答えた')
  assert.deepEqual(results[0].tried.map(item => item.code), ['RATE_LIMIT'])
})
