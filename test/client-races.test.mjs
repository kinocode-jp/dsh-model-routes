import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const ok = value => ({ ok: true, value })
function load(extra = {}) {
  let loaded
  const window = { __ModuleLoader__: { load: value => { loaded = value } }, ...extra }
  new Function('window', 'setInterval', 'clearInterval', 'setTimeout', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window, () => 0, () => {}, () => 0)
  const react = { createElement() {}, useState() {}, useEffect() {}, useRef() {} }
  const mod = loaded.factory(name => name === 'react' ? react : {})
  return { ...mod.__test, apply: mod.apply }
}
const specs = [
  { name: 'modelsStore', read: 'getModels', write: 'setRouteEnabled', act: s => s.act('setRouteEnabled', 'route', false) },
  { name: 'agyStore', read: 'agyState', write: 'agyAction', act: s => s.act({ action: 'hide', modelId: 'model' }) },
  { name: 'setupStore', read: 'getSetup', write: 'saveMedia', act: s => s.act('saveMedia', 'saved', {}) },
  { name: 'authStore', read: 'getAuthState', write: 'logout', act: s => s.act('logout', 'route') },
]
for (const spec of specs) {
  test(`${spec.name}: old service reads cannot replace rebound state or error`, async () => {
    for (const failed of [false, true]) {
      const store = load()[spec.name], old = deferred()
      store.bind({ [spec.read]: () => old.promise })
      const reading = store.refresh()
      store.bind({ [spec.read]: async () => ok({ tag: 'new' }) })
      await store.refresh()
      if (failed) old.reject(new Error('old error')); else old.resolve(ok({ tag: 'old' }))
      await reading
      assert.equal(store.state.tag, 'new'); assert.equal(store.error, null); assert.equal(store.busy, false)
    }
  })
  test(`${spec.name}: mutation invalidates older polling and blocks new polling until settled`, async () => {
    const store = load()[spec.name], poll = deferred(), mutation = deferred()
    let reads = 0
    store.bind({ [spec.read]: () => ++reads === 1 ? poll.promise : Promise.resolve(ok({ tag: 'saved' })), [spec.write]: () => mutation.promise })
    const reading = store.refresh(), saving = spec.act(store)
    assert.equal(store.busy, true)
    await store.refresh(); assert.equal(reads, 1, 'do not start reads while the write is pending')
    mutation.resolve(ok({ tag: 'saved' })); await saving
    poll.resolve(ok({ tag: 'before-write' })); await reading
    assert.equal(store.state.tag, 'saved'); assert.equal(store.error, null); assert.equal(store.busy, false)
  })
  test(`${spec.name}: stale mutation cannot finish a replacement mutation`, async () => {
    for (const failed of [false, true]) {
      const store = load()[spec.name], old = deferred(), latest = deferred()
      store.bind({ [spec.write]: () => old.promise, [spec.read]: async () => ok({ tag: 'old' }) })
      const previous = spec.act(store)
      store.bind({ [spec.write]: () => latest.promise, [spec.read]: async () => ok({ tag: 'new' }) })
      const current = spec.act(store)
      if (failed) old.reject(new Error('old save error')); else old.resolve(ok({ tag: 'old' }))
      await previous
      assert.equal(store.busy, true); assert.equal(store.state, null); assert.equal(store.error, null)
      latest.resolve(ok({ tag: 'new' })); await current
      assert.equal(store.busy, false); assert.equal(store.state.tag, 'new'); assert.equal(store.error, null)
    }
  })
  test(`${spec.name}: slow polling coalesces without starvation; unbound writes do not resurrect state`, async () => {
    const store = load()[spec.name], first = deferred(), save = deferred()
    let reads = 0
    store.bind({ [spec.read]: () => { reads++; return first.promise }, [spec.write]: () => save.promise })
    const a = store.refresh(), polls = Array.from({ length: 10 }, () => store.refresh())
    assert.equal(reads, 1, 'poll ticks share a pending read even when latency exceeds the interval')
    first.resolve(ok({ tag: 'first' })); await Promise.all([a, ...polls])
    assert.equal(store.state.tag, 'first')
    const writing = spec.act(store)
    store.bind(null); save.resolve(ok({ tag: 'resurrected' })); await writing
    assert.equal(store.state, null); assert.equal(store.busy, false)
  })
}
test('late RPC mounting is unmounted without binding stores after disposal', async () => {
  const { apply, authStore, modelsStore, setupStore, agyStore } = load()
  const mounted = deferred(), cleanups = []; let unmounted = 0, gets = 0
  const applying = apply({ remote: { $mount: () => mounted.promise }, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) }, get() { gets++; return undefined } })
  for (const off of cleanups.reverse()) off()
  const before = gets
  mounted.resolve(() => { unmounted++ }); await applying
  assert.equal(unmounted, 1); assert.equal(gets, before, 'inactive context is not queried')
  for (const store of [authStore, modelsStore, setupStore, agyStore]) assert.equal(store.service, null)
})
test('Antigravity login closes its provisional tab and never opens old URLs after rebind', async () => {
  const gate = deferred(), opened = []
  const tab = { location: { href: '' }, closed: false, close() { this.closed = true } }
  const store = load({ open: (...args) => { opened.push(args); return tab } }).agyStore
  store.bind({ agyAction: () => gate.promise })
  const login = store.login()
  store.bind({ agyState: async () => ok({ login: null }) })
  gate.resolve(ok({ login: { url: 'https://example.invalid/old' } })); await login
  assert.equal(tab.closed, true); assert.equal(tab.location.href, ''); assert.equal(opened.length, 1)
})
