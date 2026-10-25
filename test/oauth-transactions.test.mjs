import test from 'node:test'
import assert from 'node:assert/strict'
import { activeKey, slotKey, createOauthAccounts } from '../lib/oauth-accounts.js'
import { createAuthService } from '../lib/auth-service.js'

const grant = access => ({ kind: 'grant', payload: { access } })
const entry = () => ({ active: 1, accounts: [1, 2], labels: {} })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Match credentials: invoke record-updated callbacks synchronously, WITHOUT awaiting
// their async work. All records here are synthetic; no host service is contacted.
function fixture(routes = ['anthropic'], options = {}) {
  let meta = Object.fromEntries(routes.map(route => [route, entry()]))
  const records = new Map(routes.flatMap(route => [[activeKey(route), grant(route + '-A')], [slotKey(route, 1), grant(route + '-A')], [slotKey(route, 2), grant(route + '-B')]]))
  const pending = new Set(), errors = [], calls = []
  let api
  const emit = () => {
    const task = api.syncAll()
    pending.add(task)
    task.then(() => pending.delete(task), error => { pending.delete(task); errors.push(error) })
  }
  const credentials = {
    async readRecord(key) {
      calls.push(['read', key])
      await options.read?.(key)
      return structuredClone(records.get(key))
    },
    async modifyRecord(key, fn) {
      calls.push(['write', key])
      const next = await fn(records.get(key))
      await options.write?.(key, next, 'before')
      records.set(key, structuredClone(next)); emit()
      await options.write?.(key, next, 'after')
      return next
    },
    async deleteRecord(key) {
      calls.push(['delete', key])
      await options.write?.(key, undefined, 'before')
      records.delete(key); emit()
      await options.write?.(key, undefined, 'after')
    },
  }
  api = createOauthAccounts({ credentials: () => credentials, get: () => meta, isLoginActive: options.isLoginActive, save: async next => {
    await options.beforeSave?.(next)
    // Deliberately publish BEFORE a possible failure, like the real save callback.
    meta = next
    await options.save?.(next)
  } })
  return { api, credentials, records, calls, errors, emit, meta: () => meta,
    async drain() {
      for (let i = 0; i < 100; i++) {
        await tick()
        if (!pending.size) return
        await Promise.allSettled([...pending])
      }
      assert.fail('record-update sync failed to settle')
    },
  }
}
const token = (f, key) => f.records.get(key)?.payload.access
function assertOriginal(f, route = 'anthropic') {
  assert.deepEqual(f.meta()[route], entry())
  assert.equal(token(f, activeKey(route)), route + '-A')
  assert.equal(token(f, slotKey(route, 1)), route + '-A')
  assert.equal(token(f, slotKey(route, 2)), route + '-B')
}

test('record-updated callbacks preserve A -> B -> A and refreshed active grants', { timeout: 3000 }, async () => {
  const f = fixture()
  await f.api.switchTo('anthropic', 2)
  await f.drain()
  assert.equal(token(f, slotKey('anthropic', 1)), 'anthropic-A')
  f.records.set(activeKey('anthropic'), grant('B-refreshed')); f.emit()
  await f.drain()
  await f.api.switchTo('anthropic', 1)
  await f.drain()
  assert.equal(token(f, activeKey('anthropic')), 'anthropic-A')
  assert.equal(token(f, slotKey('anthropic', 2)), 'B-refreshed')
  assert.deepEqual(f.errors, [])
})

test('rapid switches, adds and renames serialize using metadata at execution time', { timeout: 3000 }, async () => {
  const f = fixture()
  await Promise.all([f.api.switchTo('anthropic', 2), f.api.switchTo('anthropic', 1), f.api.rename('anthropic', 1, 'work')])
  assert.equal(f.meta().anthropic.active, 1)
  assert.equal(token(f, activeKey('anthropic')), 'anthropic-A')
  assert.deepEqual(await Promise.all([f.api.add('anthropic'), f.api.add('anthropic')]), [3, 4])
  await f.drain()
  assert.deepEqual(f.meta().anthropic, { active: 4, accounts: [1, 2, 3, 4], labels: { 1: 'work' } })
  assert.equal(token(f, slotKey('anthropic', 1)), 'anthropic-A')
  assert.equal(token(f, slotKey('anthropic', 2)), 'anthropic-B')
  assert.deepEqual(f.errors, [])
})

test('cross-route asynchronous saves merge after prior save completes', { timeout: 3000 }, async () => {
  const started = deferred(), gate = deferred()
  let first = true
  const f = fixture(['anthropic', 'xai'], { beforeSave: async () => { if (first) { first = false; started.resolve(); await gate.promise } } })
  const a = f.api.rename('anthropic', 1, 'A-work')
  await started.promise
  const b = f.api.rename('xai', 1, 'X-work')
  await tick() // Give the second route time to reach the shared save lock.
  gate.resolve()
  await Promise.all([a, b]); await f.drain()
  assert.equal(f.meta().anthropic.labels[1], 'A-work')
  assert.equal(f.meta().xai.labels[1], 'X-work')
})

test('sync already in flight finishes before a switch changes the active record', { timeout: 3000 }, async () => {
  const started = deferred(), gate = deferred()
  let pause = true
  const f = fixture(undefined, { read: async key => {
    if (pause && key === activeKey('anthropic')) { pause = false; started.resolve(); await gate.promise }
  } })
  f.records.set(activeKey('anthropic'), grant('A-refreshed'))
  const syncing = f.api.syncActive('anthropic')
  await started.promise
  const switching = f.api.switchTo('anthropic', 2)
  gate.resolve()
  await Promise.all([syncing, switching]); await f.drain()
  assert.equal(token(f, slotKey('anthropic', 1)), 'A-refreshed')
  assert.equal(token(f, slotKey('anthropic', 2)), 'anthropic-B')
  assert.equal(f.meta().anthropic.active, 2)
})

test('failed cross-route save restores only its route and preserves the other queued edit', { timeout: 3000 }, async () => {
  const started = deferred(), gate = deferred()
  let fail = true
  const f = fixture(['anthropic', 'xai'], { save: async () => {
    if (fail) { fail = false; started.resolve(); await gate.promise; throw new Error('disk failed') }
  } })
  const a = assert.rejects(f.api.switchTo('anthropic', 2), /disk failed/)
  await started.promise
  const b = f.api.rename('xai', 1, 'X-work')
  await tick(); gate.resolve()
  await Promise.all([a, b]); await f.drain()
  assertOriginal(f)
  assert.equal(f.meta().xai.labels[1], 'X-work')
  assert.deepEqual(f.errors, [])
})

for (const action of ['switch', 'add', 'remove', 'last-remove', 'rename', 'ensure']) {
  test(`failed metadata save rolls back ${action}, including queued notifications`, { timeout: 3000 }, async () => {
    let fail = true
    const f = fixture(undefined, { save: async () => { if (fail) { fail = false; throw new Error('disk failed') } } })
    let run
    if (action === 'switch') run = () => f.api.switchTo('anthropic', 2)
    if (action === 'add') run = () => f.api.add('anthropic')
    if (action === 'remove') run = () => f.api.remove('anthropic', 1)
    if (action === 'rename') run = () => f.api.rename('anthropic', 1, 'changed')
    if (action === 'last-remove') {
      f.meta().anthropic.accounts = [1]
      run = () => f.api.remove('anthropic', 1)
    }
    if (action === 'ensure') {
      delete f.meta().anthropic
      f.records.delete(slotKey('anthropic', 1)); f.records.delete(slotKey('anthropic', 2))
      run = () => f.api.add('anthropic')
    }
    const beforeMeta = structuredClone(f.meta()), beforeRecords = structuredClone(f.records)
    await assert.rejects(run(), /disk failed/)
    await f.drain()
    assert.deepEqual(f.meta(), beforeMeta)
    assert.deepEqual(f.records, beforeRecords)
    assert.deepEqual(f.errors, [])
    // A failed operation must not poison its route queue.
    await f.api.rename('anthropic', 1, 'retry')
    assert.equal(f.meta().anthropic.labels[1], 'retry')
  })
}

for (const phase of ['before', 'after']) {
  test(`credential write rejection ${phase} mutation restores records and metadata`, { timeout: 3000 }, async () => {
    let fail = true
    const f = fixture(undefined, { write(key, _record, at) { if (fail && key === activeKey('anthropic') && at === phase) { fail = false; throw new Error('write failed') } } })
    await assert.rejects(f.api.switchTo('anthropic', 2), /write failed/)
    await f.drain(); assertOriginal(f)
    await f.api.switchTo('anthropic', 2); await f.drain()
    assert.equal(token(f, slotKey('anthropic', 1)), 'anthropic-A')
  })
}

test('remove slot deletion failure restores both active record and deleted slot', { timeout: 3000 }, async () => {
  let fail = true
  const f = fixture(undefined, { write(key, record, phase) {
    if (fail && key === slotKey('anthropic', 1) && record === undefined && phase === 'after') { fail = false; throw new Error('delete failed') }
  } })
  await assert.rejects(f.api.remove('anthropic', 1), /delete failed/)
  await f.drain(); assertOriginal(f)
})

for (const badKey of [activeKey('anthropic'), slotKey('anthropic', 1), slotKey('anthropic', 2)]) {
  test(`read failure at ${badKey} rejects without destructive deletion`, { timeout: 3000 }, async () => {
    const f = fixture(undefined, { read(key) { if (key === badKey) throw new Error('read failed') } })
    await assert.rejects(f.api.switchTo('anthropic', 2), /read failed/)
    assertOriginal(f)
    assert.equal(f.calls.filter(([op]) => op === 'delete').length, 0)
  })
}

function delayedLogin(f) {
  const outcome = deferred()
  let began = false
  const auth = createAuthService({
    credentials: () => f.credentials,
    targets: () => [{ providerId: 'synthetic', routeId: 'anthropic', label: 'synthetic' }],
    withAccountLock: (route, run) => f.api.withRoute(route, run),
    authorization: () => ({
      describe: () => ({ methods: [{ id: 'oauth' }] }),
      begin: () => { began = true; return outcome.promise },
      cancel() {}, // Deliberately cannot stop a credential write already in flight.
    }),
  })
  return { auth, began: () => began, async finish(value) {
    await f.credentials.modifyRecord(activeKey('anthropic'), async () => grant(value))
    outcome.resolve({ status: 'authorized' })
    await tick(); await f.drain()
  } }
}

test('login ownership blocks mapping changes until grant settles, including after cancel/dismiss', { timeout: 3000 }, async () => {
  let auth
  const f = fixture(undefined, { isLoginActive: route => auth?.isLoginActive(route) ?? false })
  const login = delayedLogin(f); auth = login.auth
  await auth.startLogin('anthropic')
  assert.equal(auth.isLoginActive('anthropic'), true)
  for (const run of [() => f.api.switchTo('anthropic', 2), () => f.api.add('anthropic'), () => f.api.remove('anthropic', 1)]) {
    await assert.rejects(run(), /ログイン/)
  }
  await f.api.rename('anthropic', 1, 'safe metadata edit')
  await auth.cancelLogin(); await auth.dismissAttempt()
  assert.equal(auth.isLoginActive('anthropic'), true)
  await assert.rejects(f.api.switchTo('anthropic', 2), /ログイン/)
  await assert.rejects(auth.startLogin('anthropic'), /進行中/)
  await assert.rejects(auth.logout('anthropic'), /ログイン中/)
  await login.finish('A-new')
  assert.equal(auth.isLoginActive('anthropic'), false)
  assert.equal(token(f, slotKey('anthropic', 1)), 'A-new')
  assert.equal(token(f, slotKey('anthropic', 2)), 'anthropic-B')
  await f.api.switchTo('anthropic', 2); await f.drain()
  assert.equal(token(f, activeKey('anthropic')), 'anthropic-B')
})

test('login initiation waits behind a running account transaction without deadlocking notifications', { timeout: 3000 }, async () => {
  let auth, first = true
  const started = deferred(), gate = deferred()
  const f = fixture(undefined, {
    isLoginActive: route => auth?.isLoginActive(route) ?? false,
    beforeSave: async () => { if (first) { first = false; started.resolve(); await gate.promise } },
  })
  const login = delayedLogin(f); auth = login.auth
  const switching = f.api.switchTo('anthropic', 2)
  await started.promise
  const starting = auth.startLogin('anthropic')
  await tick(); assert.equal(login.began(), false)
  gate.resolve(); await Promise.all([switching, starting])
  assert.equal(login.began(), true); assert.equal(f.meta().anthropic.active, 2)
  await login.finish('B-new')
  assert.equal(token(f, slotKey('anthropic', 1)), 'anthropic-A')
  assert.equal(token(f, slotKey('anthropic', 2)), 'B-new')
})

test('mapping guard is checked inside the queue after an earlier login initiation', { timeout: 3000 }, async () => {
  let auth
  const f = fixture(undefined, { isLoginActive: route => auth?.isLoginActive(route) ?? false })
  const login = delayedLogin(f); auth = login.auth
  const starting = auth.startLogin('anthropic')
  const switching = assert.rejects(f.api.switchTo('anthropic', 2), /ログイン/)
  await Promise.all([starting, switching])
  await login.finish('A-new')
  assert.equal(f.meta().anthropic.active, 1)
  assert.equal(token(f, slotKey('anthropic', 2)), 'anthropic-B')
})

test('rollback failure quarantines route: later notifications cannot copy B over A', { timeout: 3000 }, async () => {
  let activeWrites = 0
  const f = fixture(undefined, {
    write(key, _record, phase) { if (key === activeKey('anthropic') && phase === 'before' && ++activeWrites > 1) throw new Error('rollback unavailable') },
    save() { throw new Error('disk unavailable') },
  })
  await assert.rejects(f.api.switchTo('anthropic', 2), AggregateError)
  await f.drain()
  await assert.rejects(f.api.syncActive('anthropic'), AggregateError)
  assert.equal(token(f, slotKey('anthropic', 1)), 'anthropic-A')
  assert.equal(token(f, slotKey('anthropic', 2)), 'anthropic-B')
})
