import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { agyRecordKey } from '../lib/agy/index.mjs'
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
for (const action of [{ action: 'setEnabled', enabled: false }, { action: 'hide', modelId: 'claude-opus-5-5-high' }]) {
  test(`host agyState returns one current visibility generation after pending ${action.action}`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-state-'))
    const oldHome = process.env.DSH_HOME, oldDiscovery = process.env.DSH_MODEL_ROUTES_NO_DISCOVERY, oldFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = oldFetch; if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; if (oldDiscovery === undefined) delete process.env.DSH_MODEL_ROUTES_NO_DISCOVERY; else process.env.DSH_MODEL_ROUTES_NO_DISCOVERY = oldDiscovery; fs.rmSync(home, { recursive: true, force: true }) })
    process.env.DSH_HOME = home; process.env.DSH_MODEL_ROUTES_NO_DISCOVERY = '1'
    const storage = path.join(home, 'storages', 'model-routes'); fs.mkdirSync(storage, { recursive: true })
    fs.writeFileSync(path.join(storage, 'setup.json'), JSON.stringify({ agy: { active: 1, accounts: [1], hidden: [] } }))
    const provided = {}, started = deferred(), fetchGate = deferred()
    globalThis.fetch = async url => { assert.ok(String(url).includes('fetchAvailableModels'), `unexpected request ${url}`); started.resolve(); return fetchGate.promise }
    const credentials = {
      async readRecord(key) { return key === agyRecordKey(1) ? { kind: 'grant', payload: { access: 'synthetic', refresh: 'unused', expires: Date.now() + 3_600_000, projectId: 'synthetic-project' } } : undefined },
      async modifyRecord() {}, async describeRecord() { return { configured: false } },
    }
    const entry = { options: { config: { providers: {} } }, async update(next) { this.options = { ...this.options, ...next } } }
    apply({ loader: { store: { 'llm-pi-ai': entry } }, on() {}, provide(name, value) { provided[name] = value }, get: name => name === 'credentials' ? credentials : undefined, logger: { info() {}, error() {}, warn() {} } }, { registeredOnly: false })
    await tick()
    const service = provided.modelRoutesSetup
    const before = service.agyState(); await started.promise
    const toggling = service.agyAction(action); await tick()
    fetchGate.resolve(Response.json({ models: { 'claude-opus-5-5-high': { displayName: 'synthetic' } } }))
    const states = await Promise.all([before, toggling])
    for (const state of states) { assert.equal(state.disabled, action.action === 'setEnabled'); assert.ok(state.models.length); assert.equal(state.models[0].hidden, true) }
  })
}
