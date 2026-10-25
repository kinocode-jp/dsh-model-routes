import test from 'node:test'
import assert from 'node:assert/strict'
import { agyRecordKey, createAntigravity, normalizeAgy } from '../lib/agy/index.mjs'
import { AdapterBase } from '../lib/chains.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const first = 'claude-opus-5-5-high', second = 'gemini-3.8-flash-tiered'
const response = id => Response.json({ models: { [id]: { displayName: id, quotaInfo: { remainingFraction: 0.5 } } } })
function setup(fetchImpl, initial = {}) {
  let meta = normalizeAgy({ accounts: [1, 2], active: 1, ...initial })
  const records = new Map([1, 2].map(n => [agyRecordKey(n), { kind: 'grant', payload: { access: 'synthetic-' + n, refresh: 'unused', expires: Date.now() + 3_600_000, projectId: 'p' + n } }]))
  const agy = createAntigravity({ credentials: () => ({ async readRecord(k) { return records.get(k) }, async modifyRecord(k, fn) { records.set(k, await fn(records.get(k))) }, async deleteRecord(k) { records.delete(k) } }), getMeta: () => meta, saveMeta: async next => { meta = normalizeAgy(next) }, fetchImpl })
  return { agy, meta: () => meta }
}
for (const fails of [false, true]) test(`models: late old-account ${fails ? 'failure' : 'success'} converges on current account`, async () => {
  const old = deferred(), started = deferred(); let calls = 0, currentCalls = 0
  const { agy, meta } = setup(async (_url, init) => {
    calls++
    if (init.headers.Authorization === 'Bearer synthetic-1') { started.resolve(); return old.promise }
    currentCalls++
    return response(second)
  })
  const beforeSwitch = agy.models.all(); await started.promise
  await agy.accounts.switchTo(2)
  const current = await agy.models.all()
  if (fails) old.reject(new Error('old API failed')); else old.resolve(response(first))
  assert.strictEqual(await beforeSwitch, current)
  assert.strictEqual(await agy.models.all(), current)
  assert.deepEqual(current.map(m => m.id), [second]); assert.equal(meta().active, 2); assert.equal(currentCalls, 1)
  // The vendor may retry a failed old request against several endpoints; it must not refetch B.
  if (!fails) assert.equal(calls, 2)
})
test('models: same-generation readers share one fetch and reset invalidation excludes an old in-flight result', async () => {
  const old = deferred(), started = deferred(); let calls = 0
  const { agy } = setup(async () => { calls++; if (calls === 1) { started.resolve(); return old.promise }; return response(second) })
  const a = agy.models.all(), b = agy.models.all(); await started.promise
  assert.equal(calls, 1)
  await agy.accounts.resetUnusable()
  const current = await agy.models.all()
  old.resolve(response(first))
  assert.strictEqual(await a, current); assert.strictEqual(await b, current)
  assert.equal(calls, 2); assert.deepEqual(current.map(m => m.id), [second])
})
test('models: visibility toggles preserve an in-flight catalog request', async () => {
  const gate = deferred(), started = deferred(); let calls = 0
  const { agy } = setup(async () => { calls++; started.resolve(); return gate.promise })
  const pending = agy.models.all(); await started.promise
  await agy.accounts.setHidden(first, true); await agy.accounts.setEnabled(false); await agy.accounts.setEnabled(true)
  gate.resolve(response(first)); const list = await pending
  assert.strictEqual(await agy.models.all(), list); assert.equal(calls, 1)
})
test('quota: OFF while a request is pending cannot return or cache the old ON snapshot', async () => {
  const gate = deferred(), started = deferred(); let calls = 0
  const { agy } = setup(async () => { calls++; if (calls === 1) { started.resolve(); return gate.promise }; return response(second) })
  const pending = agy.quota(); await started.promise
  await agy.accounts.setEnabled(false); gate.resolve(response(first))
  assert.equal((await pending).status, 'disabled'); assert.equal((await agy.quota()).status, 'disabled'); assert.equal(calls, 1)
  await agy.accounts.setEnabled(true)
  assert.deepEqual((await agy.quota()).bars.map(b => b.model), [second]); assert.equal(calls, 2)
})
test('quota: late old-account response cannot replace current account or hidden-model projection', async () => {
  const old = deferred(), started = deferred(); let calls = 0
  const { agy } = setup(async (_url, init) => { calls++; if (init.headers.Authorization === 'Bearer synthetic-1') { started.resolve(); return old.promise }; return response(second) })
  const pending = agy.quota(); await started.promise
  await agy.accounts.switchTo(2); const current = await agy.quota()
  old.resolve(response(first)); assert.strictEqual(await pending, current); assert.strictEqual(await agy.quota(), current)
  assert.equal(current.account, 2); assert.equal(calls, 2)
  await agy.accounts.setHidden(second, true)
  assert.equal((await agy.quota()).bars.length, 0)
})
test('adapter listModels: OFF and hidden flags are projected after the catalog await', async () => {
  for (const turnOff of [false, true]) {
    const gate = deferred(), started = deferred()
    const { agy } = setup(async () => { started.resolve(); return gate.promise })
    const listing = agy.createAdapter(AdapterBase).listModels(); await started.promise
    if (turnOff) await agy.accounts.setEnabled(false); else await agy.accounts.setHidden(first, true)
    gate.resolve(response(first))
    assert.deepEqual(await listing, [])
  }
})
test('models/quota: disposal makes old completions inert without refetching', async () => {
  for (const kind of ['models', 'quota']) {
    const gate = deferred(), started = deferred(); let calls = 0
    const { agy } = setup(async () => { calls++; started.resolve(); return gate.promise })
    const pending = kind === 'models' ? agy.models.all() : agy.quota(); await started.promise
    agy.accounts.dispose(); gate.resolve(response(first))
    const value = await pending
    if (kind === 'models') { assert.deepEqual(value, []); assert.equal(agy.models.cache, null) } else assert.equal(value.status, 'off')
    assert.equal(calls, 1)
  }
})
