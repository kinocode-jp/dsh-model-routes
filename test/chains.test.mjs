import test from 'node:test'
import assert from 'node:assert/strict'
import { createChainAdapter, expandChain, normalizeAccounts, normalizeChains, normalizeMedia, activeMedia, CHAIN_PROVIDER } from '../lib/chains.js'

// DSH の LlmAdapter の代役(stream だけを子クラスが実装する)。
class FakeAdapter {}
const collect = async iterable => { const out = []; for await (const chunk of iterable) out.push(chunk); return out }
const failure = code => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: code + ' message' } } })
const answer = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }]

function fakeLlm(script) {
  const calls = []
  return {
    calls,
    async *stream(options) { calls.push(options.provider + '/' + options.model); yield* (script[options.provider + '/' + options.model] || [failure('MISSING')]) },
    async resolveModelInfo(provider, model) { if (!script[provider + '/' + model]) throw new Error('unknown'); return { provider, id: model, name: model, context: { contextWindow: 1000 } } },
    async listModels(provider) { return [{ provider, id: 'm', name: 'M', inputModalities: ['text', 'image'] }] },
  }
}

test('設定の検査: 不正なチェーン・番号・用途を捨てる', () => {
  assert.deepEqual(normalizeChains([{ id: 'main', name: ' メイン ', steps: [{ provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: '', model: '' }, { provider: 'Bad Id', model: 'x' }] }, { id: 'main' }, { id: 'BAD' }]),
    [{ id: 'main', name: 'メイン', steps: [{ provider: 'anthropic', model: 'claude-opus-5-5' }], accounts: true }])
  assert.deepEqual(normalizeAccounts({ 'anthropic-api': [3, 2, 2, 1, 10], 'x-api': [2] }, id => id === 'anthropic-api'), { 'anthropic-api': [2, 3] })
  assert.deepEqual(normalizeMedia({ image: { provider: 'openai-api', model: 'gpt-image-1' }, tts: { provider: '', model: '' }, other: { provider: 'a', model: 'b' } }), { image: { provider: 'openai-api', model: 'gpt-image-1', enabled: false } })
})

test('用途別: 新しく選んだ用途は無効、保存済みで enabled が無いもの(スイッチ導入前)は有効として読む', () => {
  const picked = { image: { provider: 'openai-api', model: 'gpt-image-2' }, tts: { provider: 'openai-api', model: 'tts-1', enabled: true }, stt: { provider: 'openai-api', model: 'whisper-1', enabled: false } }
  assert.deepEqual(normalizeMedia(picked), {
    image: { provider: 'openai-api', model: 'gpt-image-2', enabled: false },
    tts: { provider: 'openai-api', model: 'tts-1', enabled: true },
    stt: { provider: 'openai-api', model: 'whisper-1', enabled: false },
  })
  assert.equal(normalizeMedia(picked, true).image.enabled, true, 'saved before the switch existed')
  assert.equal(normalizeMedia(picked, true).stt.enabled, false, 'an explicit choice is kept')
  assert.deepEqual(activeMedia(normalizeMedia(picked)), { tts: { provider: 'openai-api', model: 'tts-1' } }, 'only enabled purposes reach the tools')
  assert.deepEqual(activeMedia(undefined), {})
})

test('試す順番: プライマリ → その別アカウント → セカンダリ → その別アカウント', () => {
  const chain = { id: 'main', steps: [{ provider: 'anthropic-api', model: 'opus' }, { provider: 'openai-api', model: 'gpt' }], accounts: true }
  const accounts = { 'anthropic-api': [2, 3], 'openai-api': [2] }
  assert.deepEqual(expandChain(chain, accounts).map(c => c.provider), ['anthropic-api', 'anthropic-api-2', 'anthropic-api-3', 'openai-api', 'openai-api-2'])
  assert.deepEqual(expandChain({ ...chain, accounts: false }, accounts).map(c => c.provider), ['anthropic-api', 'openai-api'], '別アカウントを試さない設定')
})

test('切り替え: 失敗したら次の候補へ、本文が出たらその候補で確定する', async () => {
  const setup = { chains: [{ id: 'main', name: 'メイン', steps: [{ provider: 'anthropic-api', model: 'opus' }, { provider: 'openai-api', model: 'gpt' }], accounts: true }], accounts: { 'anthropic-api': [2] } }
  const llm = fakeLlm({ 'anthropic-api/opus': [{ type: 'block-start', index: 0, blockType: 'text' }, failure('RATE_LIMIT')], 'anthropic-api-2/opus': [failure('QUOTA')], 'openai-api/gpt': answer('こんにちは') })
  const results = []
  const adapter = createChainAdapter(FakeAdapter, { llm, setup: () => setup, onResult: (id, result) => results.push([id, result]) })
  const chunks = await collect(adapter.stream({ provider: CHAIN_PROVIDER, model: 'main', messages: [] }))
  assert.deepEqual(llm.calls, ['anthropic-api/opus', 'anthropic-api-2/opus', 'openai-api/gpt'])
  assert.deepEqual(chunks, answer('こんにちは'), '失敗した候補の途中の出力(block-start)は捨てる')
  assert.equal(results[0][1].provider, 'openai-api')
  assert.deepEqual(results[0][1].tried.map(item => item.code), ['RATE_LIMIT', 'QUOTA'])
})

test('全滅: 最後の失敗の種類を残し、試した順と理由を文面に並べる', async () => {
  const setup = { chains: [{ id: 'main', name: 'メイン', steps: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], accounts: true }], accounts: {} }
  const adapter = createChainAdapter(FakeAdapter, { llm: fakeLlm({ 'a/x': [failure('AUTH')], 'b/y': [failure('SERVER')] }), setup: () => setup })
  const chunks = await collect(adapter.stream({ provider: CHAIN_PROVIDER, model: 'main', messages: [] }))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'SERVER')
  assert.match(chunks[0].reason.failure.message, /a\/x: AUTH.*→ b\/y: SERVER/)
})

test('一覧と解決: チェーンをモデルとして出し、文脈の長さは最初に解決できた候補から', async () => {
  const setup = { chains: [{ id: 'main', name: 'メイン', steps: [{ provider: 'gone', model: 'x' }, { provider: 'b', model: 'y' }], accounts: true }, { id: 'empty', name: '空', steps: [], accounts: true }], accounts: {} }
  const adapter = createChainAdapter(FakeAdapter, { llm: fakeLlm({ 'b/y': answer('ok') }), setup: () => setup })
  assert.deepEqual((await adapter.listModels(CHAIN_PROVIDER)).map(m => [m.provider, m.id, m.name]), [[CHAIN_PROVIDER, 'main', 'メイン']], '空のチェーンは出さない')
  const info = await adapter.resolveModel(CHAIN_PROVIDER, 'main')
  assert.deepEqual([info.provider, info.id, info.context.contextWindow], [CHAIN_PROVIDER, 'main', 1000])
  assert.deepEqual(adapter.providerInfo(CHAIN_PROVIDER), { id: CHAIN_PROVIDER, name: '代替チェーン' })
})
