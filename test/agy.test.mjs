import test from 'node:test'
import assert from 'node:assert/strict'
import { AGY_PROVIDER, AgyError, agyRecordKey, createAntigravity, normalizeAgy, usableAgyModels } from '../lib/agy/index.mjs'
import { AdapterBase } from '../lib/chains.js'
import { sortModelsNewestFirst } from '../lib/index.js'

function fakeCredentials(initial = {}) {
  const records = new Map(Object.entries(initial))
  return {
    records,
    async readRecord(key) { return records.has(key) ? structuredClone(records.get(key)) : undefined },
    async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next) records.set(key, structuredClone(next)); return next },
    async deleteRecord(key) { records.delete(key) },
  }
}
const account = (email, extra = {}) => ({ kind: 'grant', payload: { access: 'a-' + email, refresh: 'r-' + email, expires: Date.now() + 3_600_000, email, projectId: 'p-' + email, ...extra } })
const sse = text => new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })

function setup({ records = {}, meta = {}, respond, onSave = () => {}, sort }) {
  const credentials = fakeCredentials(records)
  let saved = normalizeAgy(meta)
  const calls = []
  const fetchImpl = async (url, init = {}) => { calls.push([String(url), init.headers?.authorization]); return respond(String(url), init) }
  const agy = createAntigravity({ credentials: () => credentials, getMeta: () => saved, saveMeta: async next => { onSave(); saved = normalizeAgy(next) }, fetchImpl, sort })
  return { agy, credentials, calls, meta: () => saved }
}
const collect = async iterable => { const out = []; for await (const chunk of iterable) out.push(chunk); return out }

test('設定の検査: 番号・使用中・非表示のモデルを整える', () => {
  assert.deepEqual(normalizeAgy({ active: 9, accounts: [2, 1, 1, 0], hidden: ['ok-model', '../bad'], shownBeforeOff: ['x'] }), { active: 1, accounts: [1, 2], hidden: ['ok-model'], shownBeforeOff: ['x'], disabled: true })
  assert.deepEqual(normalizeAgy(null), { active: null, accounts: [], hidden: [] })
})

test('送信: 使用中のアカウントが制限に当たったら、次のアカウントで答え、そのアカウントを使用中に残す', async () => {
  const { agy, calls, meta } = setup({
    records: { [agyRecordKey(1)]: account('one'), [agyRecordKey(2)]: account('two') },
    meta: { active: 1, accounts: [1, 2] },
    respond: (url, init) => url.includes('streamGenerateContent') ? (init.headers.authorization === 'Bearer a-one' ? new Response('{"error":{"message":"rate"}}', { status: 429 }) : sse('こんにちは')) : new Response('{}', { status: 404 }),
  })
  const adapter = agy.createAdapter(AdapterBase)
  const chunks = await collect(adapter.stream({ provider: AGY_PROVIDER, model: 'gemini-3.8-flash-tiered', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'こんにちは'))
  assert.equal(meta().active, 2, '切り替えたアカウントを使用中に残す')
  const tokens = calls.filter(([url]) => url.includes('streamGenerateContent')).map(([, auth]) => auth)
  assert.deepEqual([...new Set(tokens)], ['Bearer a-one', 'Bearer a-two'])
})

test('送信: 切り替えても直らない失敗(要求の誤りなど)は、次のアカウントへ回さずに返す', async () => {
  const { agy } = setup({
    records: { [agyRecordKey(1)]: account('one'), [agyRecordKey(2)]: account('two') },
    meta: { active: 1, accounts: [1, 2] },
    respond: () => new Response('bad', { status: 400 }),
  })
  await assert.rejects(collect(agy.createAdapter(AdapterBase).stream({ provider: AGY_PROVIDER, model: 'x', messages: [] })), error => error instanceof AgyError && error.code === 'INVALID_REQUEST')
})

test('トークン: 期限が近ければ更新し、資格情報に書き戻す', async () => {
  const { agy, credentials } = setup({
    records: { [agyRecordKey(1)]: account('one', { expires: Date.now() - 1000 }) },
    meta: { active: 1, accounts: [1] },
    respond: url => url.includes('oauth2.googleapis.com/token') ? Response.json({ access_token: 'fresh', expires_in: 3600 }) : new Response('{}', { status: 404 }),
  })
  const session = await agy.session(1)
  assert.equal(session.access, 'fresh')
  assert.equal(credentials.records.get(agyRecordKey(1)).payload.access, 'fresh')
  assert.equal(credentials.records.get(agyRecordKey(1)).payload.refresh, 'r-one', '更新用トークンは返らなければそのまま')
})

test('オフ・オン: オフの印で一覧を空にし、オンでオフ前の表示に戻す。オフ中に1つ戻すとオフ前の表示とそのモデルが出る。アカウントを外すと記録も消す', async () => {
  const { agy, credentials, meta } = setup({ records: { [agyRecordKey(1)]: account('one') }, meta: { active: 1, accounts: [1], hidden: ['gemini-2.5-pro'] }, respond: () => new Response('{}', { status: 500 }) })
  const all = (await agy.models.all()).map(model => model.id)
  const adapter = agy.createAdapter(AdapterBase)
  await agy.accounts.setEnabled(false)
  assert.deepEqual([meta().disabled, meta().hidden, (await adapter.listModels(AGY_PROVIDER)).length], [true, ['gemini-2.5-pro'], 0])
  await agy.accounts.setEnabled(true)
  assert.deepEqual([meta().disabled, meta().hidden], [undefined, ['gemini-2.5-pro']])
  assert.deepEqual((await adapter.listModels(AGY_PROVIDER)).every(model => model.provider === AGY_PROVIDER), true)
  await agy.accounts.setHidden(all[0], true)
  await agy.accounts.setEnabled(false)
  await agy.accounts.setHidden(all[0], false)
  assert.deepEqual([meta().disabled, meta().hidden], [undefined, ['gemini-2.5-pro'].filter(id => id !== all[0])])
  // スイッチを使わずに全部隠した(カードはオフに見える)ときも、スイッチでオンに戻せる
  for (const id of all) await agy.accounts.setHidden(id, true)
  await agy.accounts.setEnabled(true)
  assert.deepEqual(meta().hidden, [])
  // 以前の版のオフ(shownBeforeOff)からもオンに戻せる
  const legacy = setup({ meta: { active: null, accounts: [], hidden: all, shownBeforeOff: [all[1]] }, respond: () => new Response('{}', { status: 500 }) })
  assert.equal(legacy.meta().disabled, true)
  await legacy.agy.accounts.setEnabled(true)
  assert.deepEqual([legacy.meta().disabled, legacy.meta().hidden.includes(all[1]), legacy.meta().hidden.length], [undefined, false, all.length - 1])
  await agy.accounts.remove(1)
  assert.equal(credentials.records.has(agyRecordKey(1)), false)
  assert.deepEqual([meta().accounts, meta().active], [[], null])
})

test('表示切り替え: モデル一覧の順序と控えを保ち、残量と選択可能モデルだけ更新する', async () => {
  let asked = 0
  const ids = ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high', 'gemini-3.5-flash-tiered']
  const { agy, meta } = setup({
    records: { [agyRecordKey(1)]: account('one') }, meta: { active: 1, accounts: [1] }, sort: sortModelsNewestFirst,
    respond: () => {
      asked++
      const order = asked % 2 ? ids : [...ids].reverse()
      return Response.json({ models: Object.fromEntries(order.map(id => [id, { displayName: id, quotaInfo: { remainingFraction: 0.5 } }])) })
    },
  })
  const all = await agy.models.all()
  assert.deepEqual(all.map(m => m.id), ['claude-opus-5-5-high', 'gemini-3.8-flash-tiered', 'gemini-3.5-flash-tiered'])
  const cache = agy.models.cache
  const adapter = agy.createAdapter(AdapterBase)
  const check = async (action, visible) => {
    const before = asked
    await action()
    assert.strictEqual(await agy.models.all(), all)
    assert.strictEqual(agy.models.cache, cache)
    assert.deepEqual((await adapter.listModels()).map(m => m.id), visible)
    assert.equal(asked, before, 'ON/OFF alone must not refetch the model catalog')
  }
  const order = all.map(m => m.id)
  const hidden = ids[0]
  await agy.quota()
  await check(() => agy.accounts.setHidden(hidden, true), order.filter(id => id !== hidden))
  const beforeQuota = asked
  assert.ok(!(await agy.quota()).bars.some(bar => bar.model === hidden))
  assert.equal(asked, beforeQuota + 1, 'visibility changes still invalidate the quota projection')
  await check(() => agy.accounts.setHidden(hidden, false), order)
  await check(() => agy.accounts.setEnabled(false), [])
  assert.equal((await agy.quota()).status, 'disabled')
  await check(() => agy.accounts.setEnabled(true), order)
  await check(() => agy.accounts.setHidden(hidden, true), order.filter(id => id !== hidden))
  await check(() => agy.accounts.setEnabled(false), [])
  await check(() => agy.accounts.setHidden(hidden, false), order)
  assert.equal(meta().disabled, undefined, 'showing one model while disabled still enables the route')
})

test('一覧の更新: API の順序が変わっても並びは固定し、アカウント切り替え時は再取得する', async () => {
  let asked = 0
  const ids = ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high', 'gemini-3.5-flash-tiered']
  const { agy } = setup({
    records: { [agyRecordKey(1)]: account('one'), [agyRecordKey(2)]: account('two') }, meta: { active: 1, accounts: [1, 2] }, sort: sortModelsNewestFirst,
    respond: () => {
      asked++
      return Response.json({ models: Object.fromEntries((asked % 2 ? ids : [...ids].reverse()).map(id => [id, { displayName: id }])) })
    },
  })
  const first = (await agy.models.all()).map(m => m.id)
  agy.models.cache.at = 0
  assert.deepEqual((await agy.models.all()).map(m => m.id), first)
  assert.equal(asked, 2)
  await agy.accounts.switchTo(2)
  assert.equal(agy.models.cache, null)
  assert.deepEqual((await agy.models.all()).map(m => m.id), first)
  assert.equal(asked, 3)
})

test('ログイン切れ: 更新を拒まれたアカウントに印を付け、一覧で「再ログインが必要」と分かるようにする', async () => {
  const { agy, credentials } = setup({
    records: { [agyRecordKey(1)]: account('one', { expires: 0 }) },
    meta: { active: 1, accounts: [1] },
    respond: url => url.includes('oauth2.googleapis.com/token') ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : new Response('{}', { status: 404 }),
  })
  await assert.rejects(agy.session(1), error => error.code === 'INVALID_CREDENTIAL')
  assert.equal(credentials.records.get(agyRecordKey(1)).payload.invalid, true)
  assert.deepEqual((await agy.accounts.list()).map(a => [a.signedIn, a.needsLogin]), [[false, true]])
})

test('一覧: tiered 版がある系統の -low / -medium / -high と、使えないと分かったモデルを外す', () => {
  const list = ['gemini-3.8-flash-tiered', 'gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-extra-low', 'gemini-3.5-flash-extra-low', 'claude-opus-5-5-high', 'gpt-oss-120b-medium'].map(id => ({ id }))
  assert.deepEqual(usableAgyModels(list, { 'gpt-oss-120b-medium': Date.now() }).map(model => model.id), ['gemini-3.8-flash-tiered', 'gemini-3.5-flash-extra-low', 'claude-opus-5-5-high'])
  // 1日以上前に覚えたものは忘れる
  assert.deepEqual(usableAgyModels([{ id: 'a' }], { a: Date.now() - 25 * 3600_000 }).map(model => model.id), ['a'])
})

test('送信: 404(このアカウントでは使えない)のモデルを覚え、アカウントを切り替えると忘れる', async () => {
  const { agy, meta } = setup({
    records: { [agyRecordKey(1)]: account('one'), [agyRecordKey(2)]: account('two') },
    meta: { active: 1, accounts: [1, 2] },
    respond: () => new Response('{"error":{"message":"not found"}}', { status: 404 }),
  })
  await assert.rejects(collect(agy.createAdapter(AdapterBase).stream({ provider: AGY_PROVIDER, model: 'claude-opus-5-5-high', messages: [] })), error => error.code === 'INVALID_REQUEST')
  assert.deepEqual(Object.keys(meta().unusable), ['claude-opus-5-5-high'])
  await agy.accounts.resetUnusable()
  assert.equal(meta().unusable, undefined)
  await assert.rejects(collect(agy.createAdapter(AdapterBase).stream({ provider: AGY_PROVIDER, model: 'claude-opus-5-5-high', messages: [] })))
  await agy.accounts.switchTo(2)
  assert.equal(meta().unusable, undefined)
})

test('残量: 同じアカウントなら 5 分間は問い合わせ直さず、全モデルを隠したときは disabled を返す', async () => {
  let asked = 0
  const { agy } = setup({
    records: { [agyRecordKey(1)]: account('one') },
    meta: { active: 1, accounts: [1] },
    respond: url => {
      if (!url.includes('fetchAvailableModels')) return new Response('{}', { status: 404 })
      asked++
      return Response.json({ models: { 'gemini-3.8-flash-tiered': { displayName: 'G', quotaInfo: { remainingFraction: 0.5 } } } })
    },
  })
  const first = await agy.quota()
  await agy.quota()
  assert.equal(first.status, 'ok')
  const afterList = asked
  await agy.quota()
  assert.equal(asked, afterList, '控えを使う')
  // オフ(全モデル非表示)。控えは別アカウント扱いにならないので、新しい接続で確かめる。
  const quotaBody = { models: { 'gemini-3.8-flash-tiered': { displayName: 'G', quotaInfo: { remainingFraction: 0.5 } } } }
  const { agy: offAgy } = setup({ records: { [agyRecordKey(1)]: account('one') }, meta: { active: 1, accounts: [1] }, respond: url => url.includes('fetchAvailableModels') ? Response.json(quotaBody) : new Response('{}', { status: 404 }) })
  await offAgy.accounts.setEnabled(false)
  assert.equal((await offAgy.quota()).status, 'disabled')
})

test('残量: 失敗も 2 分間は控えを返し(再ログインが必要と分かる)、表示を変えると控えを捨てる', async () => {
  let asked = 0
  const { agy } = setup({
    records: { [agyRecordKey(1)]: account('one', { expires: 0 }) },
    meta: { active: 1, accounts: [1] },
    respond: url => { if (url.includes('oauth2.googleapis.com/token')) { asked++; return Response.json({ error: 'invalid_grant' }, { status: 400 }) } return new Response('{}', { status: 404 }) },
  })
  const first = await agy.quota()
  assert.deepEqual([first.status, first.needsLogin], ['error', true])
  const before = asked
  await agy.quota()
  assert.equal(asked, before, '失敗の控えを使う')
  await agy.accounts.setHidden('gemini-2.5-pro', true)
  await agy.quota()
  assert.ok(asked > before, '表示を変えたら問い合わせ直す')
})

test('残量: 1 回の問い合わせで済ませ、全部使えないときはオフと言わず、失敗は日本語で伝える', async () => {
  let asked = 0
  let status = 200
  const { agy } = setup({
    records: { [agyRecordKey(1)]: account('one') },
    meta: { active: 1, accounts: [1], unusable: { 'gemini-3.8-flash-tiered': Date.now() } },
    respond: url => {
      if (!url.includes('fetchAvailableModels')) return new Response('{}', { status: 404 })
      asked++
      return status === 200 ? Response.json({ models: { 'gemini-3.8-flash-tiered': { displayName: 'G', quotaInfo: { remainingFraction: 0.5 } } } }) : new Response('{}', { status })
    },
  })
  const allUnusable = await agy.quota()
  assert.deepEqual([allUnusable.status, asked], ['error', 1], '使えないモデルだけならエラー(オフではない)、問い合わせは 1 回')
  await agy.accounts.resetUnusable()
  status = 429
  const limited = await agy.quota()
  assert.equal(limited.status, 'error')
  assert.match(limited.error, /利用制限/)
  assert.doesNotMatch(limited.error, /https?:/)
})

test('残量: 画面でオフなら、ログインが切れていてもオフと返し、問い合わせない', async () => {
  let asked = 0
  const { agy } = setup({
    records: { [agyRecordKey(1)]: account('one', { expires: 0 }) },
    meta: { active: 1, accounts: [1], hidden: ['x'], shownBeforeOff: [] },
    respond: () => { asked++; return new Response('{}', { status: 400 }) },
  })
  assert.equal((await agy.quota()).status, 'disabled')
  assert.equal(asked, 0)
})

test('残量: スイッチを使わずに全モデルを隠してもオフ。401 は再ログインの印を付ける', async () => {
  let status = 200
  const body = { models: { 'gemini-3.8-flash-tiered': { displayName: 'G', quotaInfo: { remainingFraction: 0.5 } } } }
  const { agy } = setup({
    records: { [agyRecordKey(1)]: account('one') },
    meta: { active: 1, accounts: [1], hidden: ['gemini-3.8-flash-tiered'] },
    respond: url => !url.includes('fetchAvailableModels') ? new Response('{}', { status: 404 }) : status === 200 ? Response.json(body) : new Response('{}', { status }),
  })
  assert.equal((await agy.quota()).status, 'disabled')
  await agy.accounts.setHidden('gemini-3.8-flash-tiered', false)
  status = 401
  const relogin = await agy.quota()
  assert.deepEqual([relogin.status, relogin.needsLogin], ['error', true])
})

test('送信: オフの間は送らず、チェーンが次の候補へ進めるよう失敗として返す', async () => {
  let sent = 0
  const { agy } = setup({ records: { [agyRecordKey(1)]: account('one') }, meta: { active: 1, accounts: [1], disabled: true }, respond: () => { sent++; return sse('x') } })
  await assert.rejects(collect(agy.createAdapter(AdapterBase).stream({ provider: AGY_PROVIDER, model: 'gemini-3.8-flash-tiered', messages: [] })), error => error instanceof AgyError && /オフ/.test(error.message))
  assert.equal(sent, 0)
})

test('オン: モデル一覧(ログイン状態)に頼らず、保存済みの記録だけで戻し、保存は1回', async () => {
  let saves = 0
  const make = meta => setup({ meta, respond: () => new Response('{}', { status: 500 }), onSave: () => { saves++ } })
  // 以前の版のオフ: オフ前に出していた live-only 以外を隠す(仮の一覧には無い ID でも正しく戻る)
  const legacy = make({ active: null, accounts: [], hidden: ['live-only', 'live-hidden'], shownBeforeOff: ['live-only'] })
  await legacy.agy.accounts.setEnabled(true)
  assert.deepEqual([legacy.meta().disabled, legacy.meta().hidden], [undefined, ['live-hidden']])
  // 手で全部隠していた(印なし)ときにオンにすると、一覧に関係なく全部出す
  const manual = make({ active: null, accounts: [], hidden: ['live-a', 'live-b'] })
  await manual.agy.accounts.setEnabled(true)
  assert.deepEqual(manual.meta().hidden, [])
  // オフ中に1つ戻すと、保存は1回で、オフ前の表示 + そのモデル
  const off = make({ active: null, accounts: [], hidden: ['a', 'b'], disabled: true })
  saves = 0
  await off.agy.accounts.setHidden('a', false)
  assert.deepEqual([off.meta().disabled, off.meta().hidden, saves], [undefined, ['b'], 1])
})
