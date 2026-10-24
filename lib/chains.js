// 代替チェーン(プライマリ → 別アカウント → セカンダリ …)と、用途別モデル・追加アカウントの設定。
// 設定は ~/.dsh/storages/model-routes/setup.json に保存する(プロファイルの設定ファイルは書き換えない)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** 代替チェーンを出す仮想プロバイダの ID。モデル選択では「代替チェーン › <チェーン名>」になる。 */
export const CHAIN_PROVIDER = 'model-routes'

/** 用途別モデルの種類。画面のタブと保存の鍵。 */
export const MEDIA_KINDS = ['image', 'stt', 'tts', 'video']

const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const CHAIN_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const setupPath = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'model-routes', 'setup.json')

const stepOf = value => isObject(value) && ROUTE_ID.test(value.provider ?? '') && MODEL_ID.test(value.model ?? '') ? { provider: value.provider, model: value.model } : null

/** 画面から来たチェーンを検査して、保存できる形にする。不正なものは捨てる。 */
export function normalizeChains(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const chains = []
  for (const item of value.slice(0, 20)) {
    if (!isObject(item) || !CHAIN_ID.test(item.id ?? '') || seen.has(item.id)) continue
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 40) : item.id
    const steps = (Array.isArray(item.steps) ? item.steps : []).map(stepOf).filter(Boolean).slice(0, 8)
    seen.add(item.id)
    chains.push({ id: item.id, name, steps, accounts: item.accounts !== false })
  }
  return chains
}

/** 追加アカウント: { API 枠のルートID: [2, 3, …] }。番号は 2〜9。 */
export function normalizeAccounts(value, allowed = () => true) {
  const result = {}
  if (!isObject(value)) return result
  for (const [routeId, numbers] of Object.entries(value)) {
    if (!ROUTE_ID.test(routeId) || !allowed(routeId) || !Array.isArray(numbers)) continue
    const list = [...new Set(numbers.filter(n => Number.isInteger(n) && n >= 2 && n <= 9))].sort((a, b) => a - b)
    if (list.length) result[routeId] = list
  }
  return result
}

/**
 * 用途別モデル: { image: { provider, model, enabled }, … }。enabled が無いものは defaultEnabled にする。
 * 画面から保存するときは既定で無効(新しく選んだ用途は、スイッチを入れるまで道具にならない)。保存済みの
 * 設定ファイルに enabled が無いのは、スイッチができる前に選んだ用途なので有効として読む。
 * @param {unknown} value
 * @param {boolean} [defaultEnabled]
 */
export function normalizeMedia(value, defaultEnabled = false) {
  const result = {}
  if (!isObject(value)) return result
  for (const kind of MEDIA_KINDS) {
    const step = stepOf(value[kind])
    if (step) result[kind] = { ...step, enabled: typeof value[kind].enabled === 'boolean' ? value[kind].enabled : defaultEnabled }
  }
  return result
}

/** 有効な用途だけ(道具・文字起こしの提供元に渡す形 { provider, model })。 */
export function activeMedia(media) {
  const result = {}
  for (const kind of MEDIA_KINDS) if (media?.[kind]?.enabled) result[kind] = { provider: media[kind].provider, model: media[kind].model }
  return result
}

export function readSetup() {
  try {
    const raw = JSON.parse(fs.readFileSync(setupPath(), 'utf8'))
    // oauth(サブスクの複数アカウント)は、読む側が対象のルートで絞って検査する(oauth-accounts.js の normalizeOauth)。
    return { chains: normalizeChains(raw?.chains), accounts: normalizeAccounts(raw?.accounts), media: normalizeMedia(raw?.media, true), oauth: isObject(raw?.oauth) ? raw.oauth : {}, agy: isObject(raw?.agy) ? raw.agy : {} }
  } catch {
    return { chains: [], accounts: {}, media: {}, oauth: {}, agy: {} }
  }
}

export function writeSetup(setup) {
  const file = setupPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(setup, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  } finally {
    try { fs.unlinkSync(tmp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

/** 追加アカウントのルートID。例: anthropic-api と 2 → anthropic-api-2 */
export const accountRouteId = (routeId, n) => routeId + '-' + n
/** 追加アカウントのキー名。例: ANTHROPIC_API_KEY と 2 → ANTHROPIC_API_KEY_2 */
export const accountKeyEnv = (apiKeyEnv, n) => apiKeyEnv + '_' + n

/**
 * チェーンの試す順番。各段で、そのプロバイダ → その追加アカウント(チェーンの accounts が有効なとき)。
 * 同じ組み合わせは2回試さない。
 */
export function expandChain(chain, accounts = {}) {
  const order = []
  const seen = new Set()
  const push = (provider, model) => { const key = provider + '\n' + model; if (!seen.has(key)) { seen.add(key); order.push({ provider, model }) } }
  for (const step of chain?.steps || []) {
    push(step.provider, step.model)
    if (chain.accounts !== false) for (const n of accounts[step.provider] || []) push(accountRouteId(step.provider, n), step.model)
  }
  return order
}

/**
 * DSH の LlmAdapter(@deepseek-ai/dsh-llm)と同じ既定の動きを持つ基底。
 * プラグインの置き場所から DSH 内部のパッケージを読み込めないときに使う(登録側は型を確かめない)。
 */
export class AdapterBase {
  providerInfo(provider) { return { id: provider, name: provider } }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }
  imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes } }
  listModels() { return Promise.resolve([]) }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async prepareCall(provider, model, signal) { return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) } }
}

// 本文が出始めたら、もう別のモデルに切り替えない(書きかけの返答を引き継げないため)。
const CONTENT_CHUNKS = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'])

/**
 * チェーンを1つの「モデル」として DSH に出す接続処理(LlmAdapter)を作る。
 * LlmAdapter は DSH の @deepseek-ai/dsh-llm から渡す(テストでは代役を渡す)。
 * @param deps.llm       DSH の llm サービス(stream / resolveModelInfo / listModels)
 * @param deps.setup     () => 現在の設定 { chains, accounts }
 * @param deps.onResult  (chainId, { provider, model, tried: [{ provider, model, code, message }] }) 応答した候補の記録
 * @param deps.oauthOthers   (provider) => Promise<番号[]> サブスクの、使用中以外でログイン済みのアカウント(無ければ [])
 * @param deps.switchAccount (provider, n) => Promise サブスクの使用中アカウントを切り替える
 */
export function createChainAdapter(LlmAdapter, { llm, setup, onResult = () => {}, label = '代替チェーン', oauthOthers = async () => [], switchAccount = async () => {} }) {
  const chainOf = id => setup().chains.find(chain => chain.id === id)
  return new (class ChainAdapter extends LlmAdapter {
    providerInfo() { return { id: CHAIN_PROVIDER, name: label } }

    // 画像を送るときの大きさ・料金は、1段目のモデルのものを使う。
    imageRequestTarget(provider, model, image) {
      const first = chainOf(model)?.steps[0]
      try { if (first && llm.imageRequestTarget) return llm.imageRequestTarget(first.provider, first.model, image) } catch {}
      return super.imageRequestTarget(provider, model, image)
    }
    imageRequestPricing(provider, model) {
      const first = chainOf(model)?.steps[0]
      try { if (first && llm.imageRequestPricing) return llm.imageRequestPricing(first.provider, first.model) } catch {}
      return super.imageRequestPricing(provider, model)
    }

    async listModels() {
      const models = []
      for (const chain of setup().chains) {
        if (!chain.steps.length) continue
        let inputModalities
        try {
          const first = chain.steps[0]
          inputModalities = (await llm.listModels(first.provider)).find(model => model.id === first.model)?.inputModalities
        } catch {}
        models.push({ provider: CHAIN_PROVIDER, id: chain.id, name: chain.name, ...(inputModalities ? { inputModalities } : {}) })
      }
      return models
    }

    // 文脈の長さや推論の段階は、最初に解決できた候補のものを使う。
    async resolveModel(provider, model, signal) {
      const chain = chainOf(model)
      if (!chain) throw new Error(`代替チェーン「${model}」がありません`)
      let lastError
      for (const step of expandChain(chain, setup().accounts)) {
        try {
          const info = await llm.resolveModelInfo(step.provider, step.model, signal)
          return { ...info, provider: CHAIN_PROVIDER, id: chain.id, name: chain.name }
        } catch (error) { lastError = error }
      }
      throw lastError || new Error(`代替チェーン「${chain.name}」に使えるモデルがありません`)
    }

    async *stream(options) {
      const chain = chainOf(options.model)
      if (!chain) throw new Error(`代替チェーン「${options.model}」がありません`)
      // API の追加アカウント(別ルート)に加えて、サブスクは同じルートのまま使用中アカウントを入れ替えて試す。
      const candidates = []
      for (const candidate of expandChain(chain, setup().accounts)) {
        candidates.push(candidate)
        if (chain.accounts !== false) {
          let others = []
          try { others = await oauthOthers(candidate.provider) } catch {}
          for (const n of others) candidates.push({ ...candidate, account: n })
        }
      }
      if (!candidates.length) throw new Error(`代替チェーン「${chain.name}」にモデルがありません。設定の「モデルルート」で追加してください`)
      const tried = []
      let lastFailure = null
      for (const candidate of candidates) {
        if (options.signal?.aborted) break
        if (candidate.account !== undefined) {
          try { await switchAccount(candidate.provider, candidate.account) } catch (error) {
            tried.push({ ...candidate, code: 'SWITCH_FAILED', message: error?.message ?? String(error) })
            continue
          }
        }
        const buffered = []
        let committed = false
        let failure = null
        for await (const chunk of llm.stream({ ...options, provider: candidate.provider, model: candidate.model })) {
          if (committed) { yield chunk; continue }
          if (chunk.type === 'finish' && chunk.reason?.kind === 'error' && !options.signal?.aborted) { failure = chunk; break }
          buffered.push(chunk)
          if (chunk.type === 'finish' || CONTENT_CHUNKS.has(chunk.type)) {
            for (const item of buffered) yield item
            buffered.length = 0
            committed = true
          }
        }
        if (committed) { onResult(chain.id, { ...candidate, tried }); return }
        const reason = failure?.reason?.failure
        tried.push({ ...candidate, code: reason?.code ?? null, message: reason?.message ?? null })
        lastFailure = failure
      }
      onResult(chain.id, { provider: null, model: null, tried })
      if (lastFailure) {
        // 最後の失敗の種類(code)はそのまま残し、文面に試した順と理由を並べる。
        const summary = tried.map(item => `${item.provider}/${item.model}: ${item.code ?? '?'}${item.message ? ' ' + item.message : ''}`).join(' → ')
        const failure = { ...lastFailure.reason.failure, message: `代替チェーン「${chain.name}」の候補がすべて失敗しました: ${summary}` }
        yield { ...lastFailure, reason: { ...lastFailure.reason, failure } }
        return
      }
      throw new Error('取り消されました')
    }
  })()
}
