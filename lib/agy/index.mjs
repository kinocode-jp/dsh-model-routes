// Antigravity(Google Cloud Code Assist 内部 API)を、他のプラグインに頼らずに使う。
// 送受信の形式(リクエストの組み立て・SSE の読み取り・モデル一覧)は dsh-agy 0.4.6(MIT)から移植した vendor/ を使う。
// ここは、アカウント(複数)・ログイン・トークン更新・接続処理(DSH の LlmAdapter 相当)を受け持つ。
// 識別情報は固定の1種類だけを送る。アカウントごとの偽装・乱数化、枠を使い切らせるための並べ替えはしない。
// 失敗(制限・枠切れ・認証切れ)したら、ログイン済みの次のアカウントへ切り替えて試す(切り替えたまま使い続ける)。
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { AGY_CLIENT_ID, AGY_CLIENT_SECRET, AGY_SCOPES, AGY_REQUEST_HEADERS, AGY_CLIENT_METADATA, OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL, OAUTH_USERINFO_URL, AGY_ENDPOINT_FALLBACKS, getAgyBootstrapUserAgent, fetchAgyFirstOk } from './constants.mjs'
import { t as toAgyRequestBody, r as resolveMultimodalFiles, i as setThoughtSignature } from './vendor/translate.mjs'
import { r as parseAgySse } from './vendor/parse.mjs'
import { n as listAgyModels, i as resolveAgyModel, t as catalogModelList } from './vendor/models.mjs'
import { i as generateAntigravityRequestId, r as deriveAntigravitySessionId } from './vendor/identity.mjs'

export const AGY_PROVIDER = 'antigravity'
export const agyRecordKey = n => 'model-routes/agy-' + n

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

/** 保存する設定: { active: 番号, accounts: [番号…], hidden: [モデルID…], shownBeforeOff?: [モデルID…] } */
export function normalizeAgy(value) {
  if (!isObject(value)) return { active: null, accounts: [], hidden: [] }
  const ids = list => [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && MODEL_ID.test(id)))]
  const accounts = [...new Set((Array.isArray(value.accounts) ? value.accounts : []).filter(n => Number.isInteger(n) && n >= 1 && n <= 20))].sort((a, b) => a - b)
  const result = { active: accounts.includes(value.active) ? value.active : accounts[0] ?? null, accounts, hidden: ids(value.hidden) }
  if (Array.isArray(value.shownBeforeOff)) result.shownBeforeOff = ids(value.shownBeforeOff)
  return result
}

/** DSH が失敗の種類として読むエラー(自前の code と failure を持つ)。 */
export class AgyError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.code = code
    this.failure = { message, code, ...extra }
  }
}
// この種類の失敗なら、次のアカウントで試す。
const SWITCHABLE = new Set(['RATE_LIMIT', 'QUOTA', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])

function classifyHttp(status, bodyText = '') {
  const text = String(bodyText).slice(0, 500)
  if (status === 429) return /quota|RESOURCE_EXHAUSTED|individual/i.test(text) ? ['QUOTA', 'Antigravity の利用枠を使い切りました'] : ['RATE_LIMIT', 'Antigravity の利用制限に当たりました']
  if (status === 401) return ['INVALID_CREDENTIAL', 'Antigravity のログインが切れています。設定の「モデルルート」で再ログインしてください']
  if (status === 403) return [/verif|appeal/i.test(text) ? 'RATE_LIMIT' : 'INVALID_CREDENTIAL', 'Antigravity に拒否されました']
  if (status >= 500) return ['SERVER', 'Antigravity 側のエラーです']
  // 一覧に出ていても、アカウント(プラン)によっては会話に使えないモデルがある(段階付きの -low / -medium / -high など)。
  if (status === 404) return ['INVALID_REQUEST', 'このモデルは、今のアカウントでは Antigravity で使えません。別のモデル(例: 〜-tiered)を選んでください']
  const detail = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1]
  return ['INVALID_REQUEST', 'Antigravity が要求を受け付けませんでした' + (detail ? ': ' + detail : '')]
}

const form = values => new URLSearchParams(values).toString()
async function postToken(values, fetchImpl) {
  const response = await fetchImpl(OAUTH_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: AGY_CLIENT_ID, client_secret: AGY_CLIENT_SECRET, ...values }) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new AgyError(`Google のトークン発行に失敗しました (${response.status}${body.error ? ': ' + body.error : ''})`, response.status === 400 || response.status === 401 ? 'INVALID_CREDENTIAL' : 'SERVER')
  return body
}

/** プロジェクト ID を得る(無ければ利用開始の手続きをしてから)。 */
async function discoverProject(accessToken, fetchImpl) {
  const headers = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'User-Agent': getAgyBootstrapUserAgent() }
  const load = async () => {
    for (const base of AGY_ENDPOINT_FALLBACKS) {
      try {
        const response = await fetchImpl(base + '/v1internal:loadCodeAssist', { method: 'POST', headers, body: JSON.stringify({ metadata: AGY_CLIENT_METADATA }) })
        if (!response.ok) continue
        const data = await response.json()
        const project = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id
        const tier = data.subscriptionInfo?.paidTier?.id || data.subscriptionInfo?.currentTier?.id || (data.subscriptionInfo?.allowedTiers || []).find(item => item.isDefault)?.id || 'legacy-tier'
        return { projectId: project || '', tierId: tier }
      } catch {}
    }
    return { projectId: '', tierId: 'legacy-tier' }
  }
  const first = await load()
  if (first.projectId) return first.projectId
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const base of AGY_ENDPOINT_FALLBACKS) {
      try {
        const response = await fetchImpl(base + '/v1internal:onboardUser', { method: 'POST', headers, body: JSON.stringify({ tier_id: first.tierId, metadata: AGY_CLIENT_METADATA }) })
        if (response.ok && (await response.json()).done === true) { const again = await load(); if (again.projectId) return again.projectId }
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  return ''
}

/**
 * @param deps.credentials () => DSH の資格情報サービス
 * @param deps.getMeta     () => normalizeAgy の形の設定
 * @param deps.saveMeta    (next) => 設定を保存する
 * @param deps.attachments () => DSH の添付ファイルサービス(画像を送るとき)
 * @param deps.fetchImpl   通信(テストで差し替え)
 * @param deps.sort        モデルの並べ替え(ほかのサービスと同じ「系列ごとに新しい版から」)
 */
export function createAntigravity({ credentials, getMeta, saveMeta, attachments = () => undefined, fetchImpl = (...args) => fetch(...args), logger, sort = list => list }) {
  const store = () => {
    const service = credentials()
    if (!service?.readRecord || !service?.modifyRecord) throw new AgyError('DSH の資格情報サービスに接続できません', 'MISSING_CREDENTIAL')
    return service
  }
  const readAccount = async n => { try { const record = await store().readRecord(agyRecordKey(n)); return record?.kind === 'grant' && isObject(record.payload) ? record.payload : null } catch { return null } }
  const writeAccount = async (n, payload) => { if (payload) await store().modifyRecord(agyRecordKey(n), async () => ({ kind: 'grant', payload })); else await store().deleteRecord?.(agyRecordKey(n)) }

  // 有効なアクセストークン(期限が近ければ更新)とプロジェクト ID。
  async function session(n) {
    const account = await readAccount(n)
    if (!account?.refresh) throw new AgyError(`Antigravity のアカウント ${n} はログインしていません`, 'MISSING_CREDENTIAL')
    let next = account
    if (!account.access || !(account.expires > Date.now() + 60_000)) {
      let token
      try { token = await postToken({ grant_type: 'refresh_token', refresh_token: account.refresh }, fetchImpl) } catch (error) {
        // 更新を拒まれたら、画面で「再ログインが必要」と分かるよう印を付ける(ログインし直すと消える)。
        if (error instanceof AgyError && error.code === 'INVALID_CREDENTIAL' && !account.invalid) await writeAccount(n, { ...account, invalid: true })
        throw error
      }
      next = { ...next, access: token.access_token, refresh: token.refresh_token || account.refresh, expires: Date.now() + (Number(token.expires_in) || 3600) * 1000 }
      delete next.invalid
    }
    if (!next.projectId) next = { ...next, projectId: await discoverProject(next.access, fetchImpl) }
    if (next !== account) await writeAccount(n, next)
    return { n, ...next }
  }

  // ── ログイン(ブラウザ → この機械の一時的な受け口へ戻る) ──
  let attempt = null
  let server = null
  const closeServer = () => { try { server?.close() } catch {} server = null }
  async function finishLogin(code, verifier, redirectUri) {
    const token = await postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, fetchImpl)
    if (!token.refresh_token) throw new AgyError('Google から更新用トークンが返りませんでした。もう一度ログインしてください', 'INVALID_CREDENTIAL')
    let email = null
    try { const info = await fetchImpl(OAUTH_USERINFO_URL, { headers: { Authorization: 'Bearer ' + token.access_token } }); if (info.ok) email = (await info.json()).email ?? null } catch {}
    const meta = getMeta()
    // 同じメールのアカウントがあれば、それを更新する(重複させない)。
    let n = null
    for (const existing of meta.accounts) if (email && (await readAccount(existing))?.email === email) n = existing
    if (n === null) n = [...Array(20).keys()].map(i => i + 1).find(value => !meta.accounts.includes(value))
    const payload = { access: token.access_token, refresh: token.refresh_token, expires: Date.now() + (Number(token.expires_in) || 3600) * 1000, email, projectId: await discoverProject(token.access_token, fetchImpl) }
    await writeAccount(n, payload)
    await saveMeta({ ...meta, accounts: [...new Set([...meta.accounts, n])].sort((a, b) => a - b), active: meta.active ?? n })
    // ログイン前は控えの一覧(どのアカウントでも出す既定の一覧)を出していたので、実際の一覧に読み直す。
    models.cache = null
    return { n, email }
  }

  const accounts = {
    async list() {
      const meta = getMeta()
      const rows = []
      for (const n of meta.accounts) { const account = await readAccount(n); rows.push({ n, email: account?.email ?? null, active: n === meta.active, signedIn: !!account?.refresh && !account?.invalid, needsLogin: !!account?.invalid, hasProject: !!account?.projectId }) }
      return rows
    },
    async switchTo(n) { const meta = getMeta(); if (!meta.accounts.includes(n)) throw new TypeError('そのアカウントはありません'); await saveMeta({ ...meta, active: n }); models.cache = null },
    async remove(n) {
      const meta = getMeta()
      if (!meta.accounts.includes(n)) throw new TypeError('そのアカウントはありません')
      await writeAccount(n, undefined)
      const rest = meta.accounts.filter(value => value !== n)
      await saveMeta({ ...meta, accounts: rest, active: meta.active === n ? rest[0] ?? null : meta.active })
      models.cache = null
    },
    async setHidden(modelId, hidden) {
      const meta = getMeta()
      const set = new Set(meta.hidden)
      if (hidden) set.add(modelId); else set.delete(modelId)
      await saveMeta({ ...meta, hidden: [...set] })
      models.cache = null
    },
    // オフ = 全モデルを非表示。オンに戻すと、オフにする前に出していたモデルに戻す。
    async setEnabled(enabled) {
      const meta = getMeta()
      const all = (await models.all()).map(model => model.id)
      if (!enabled) {
        const { shownBeforeOff, ...rest } = meta
        await saveMeta({ ...rest, hidden: all, shownBeforeOff: all.filter(id => !meta.hidden.includes(id)) })
      } else {
        const shown = new Set(meta.shownBeforeOff ?? all)
        const { shownBeforeOff, ...rest } = meta
        await saveMeta({ ...rest, hidden: all.filter(id => !shown.has(id)) })
      }
      models.cache = null
    },
    // ログインを始める。戻り値の url をブラウザで開く。完了は loginState() で見る。
    async startLogin() {
      if (attempt?.phase === 'waiting') return { ...attempt }
      closeServer()
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const state = randomBytes(16).toString('base64url')
      server = http.createServer()
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const redirectUri = `http://localhost:${server.address().port}/oauth-callback`
      const url = OAUTH_AUTHORIZE_URL + '?' + new URLSearchParams({ client_id: AGY_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: AGY_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state })
      attempt = { id: state.slice(0, 8), phase: 'waiting', url, email: null, error: null }
      const current = attempt
      const timer = setTimeout(() => { if (current.phase === 'waiting') { current.phase = 'error'; current.error = 'ログインの待ち時間を過ぎました'; closeServer() } }, 5 * 60_000)
      timer.unref?.()
      server.on('request', async (req, res) => {
        const reqUrl = new URL(req.url || '/', redirectUri)
        if (reqUrl.pathname !== '/oauth-callback') { res.writeHead(404); res.end(); return }
        const ok = reqUrl.searchParams.get('state') === state && reqUrl.searchParams.get('code')
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><meta charset="utf-8"><title>Antigravity</title><p style="font:16px sans-serif;margin:40px">${ok ? 'ログインを受け付けました。DeepSeek Harness に戻ってください。' : 'ログインに失敗しました。もう一度お試しください。'}</p>`)
        clearTimeout(timer)
        closeServer()
        if (!ok) { current.phase = 'error'; current.error = reqUrl.searchParams.get('error') || 'ログインが取り消されました'; return }
        try { const result = await finishLogin(reqUrl.searchParams.get('code'), verifier, redirectUri); current.phase = 'done'; current.email = result.email } catch (error) { current.phase = 'error'; current.error = error?.message ?? String(error) }
      })
      return { ...attempt }
    },
    loginState() { return attempt ? { ...attempt } : null },
    cancelLogin() { if (attempt?.phase === 'waiting') { attempt.phase = 'cancelled'; closeServer() } return accounts.loginState() },
    dispose() { closeServer() },
  }

  // ── モデル一覧(10 分間は控えを使う) ──
  const models = {
    cache: null,
    async all() {
      if (models.cache && Date.now() - models.cache.at < 600_000) return models.cache.list
      const meta = getMeta()
      let list
      try { const active = meta.active ? await session(meta.active) : null; list = await listAgyModels(active?.access, active?.projectId, fetchImpl) } catch { list = catalogModelList() }
      list = sort(list.map(model => ({ ...model, provider: AGY_PROVIDER })))
      // アカウントが無い(控えの一覧)ときは、ログイン直後に実際の一覧へ切り替わるよう短く持つ。
      models.cache = { at: meta.active ? Date.now() : Date.now() - 590_000, list }
      return list
    },
  }

  async function imagesFor(options) {
    const refs = []
    for (const message of options.messages || []) if (message.role === 'user') for (const block of message.content || []) if (block.type === 'image') refs.push(block.attachment)
    const images = new Map()
    if (!refs.length) return images
    const service = attachments()
    if (!service?.readImage) throw new AgyError('画像を読み込むための DSH の添付ファイルサービスがありません', 'UNSUPPORTED_CONTENT')
    for (const ref of refs) { const stored = await service.readImage(ref); images.set(ref.attachmentId, { mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') }) }
    return images
  }

  // 1つのアカウントで送り、DSH の形の断片を返す。失敗は AgyError で投げる(本文が出る前だけ)。
  async function* sendWith(sessionInfo, options, images, files) {
    const body = toAgyRequestBody(options, {
      projectId: sessionInfo.projectId,
      requestId: generateAntigravityRequestId(),
      sessionId: deriveAntigravitySessionId(sessionInfo.email ?? String(sessionInfo.n), options.sessionId === undefined ? undefined : String(options.sessionId), 0) ?? undefined,
      ...images.size ? { images } : {},
      ...files.size ? { multimodalFiles: files } : {},
    })
    let response
    try {
      response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + sessionInfo.access, 'content-type': 'application/json', accept: 'text/event-stream', ...AGY_REQUEST_HEADERS },
        body: JSON.stringify(body), signal: options.signal,
      }, fetchImpl)
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new AgyError('Antigravity に接続できません: ' + (error?.message ?? error), 'TRANSPORT')
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const [code, message] = classifyHttp(response.status, text)
      throw new AgyError(`${message} (${response.status})`, code, { status: response.status })
    }
    if (!response.body) throw new AgyError('Antigravity から応答の本文がありません', 'SERVER')
    // 思考の署名は、本文が出るまで確定させない(dsh-agy と同じ)。
    const pending = []
    const commit = () => { for (const [id, signature] of pending) setThoughtSignature(id, signature); pending.length = 0 }
    for await (const chunk of parseAgySse(response.body, { signal: options.signal, onToolSignature: (id, signature) => pending.push([id, signature]) })) {
      if (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') commit()
      yield chunk
    }
    commit()
  }

  // ── DSH の LlmAdapter 相当 ──
  function createAdapter(Base) {
    return new (class AntigravityAdapter extends Base {
      providerInfo() { return { id: AGY_PROVIDER, name: 'Antigravity' } }
      async listModels() { const hidden = new Set(getMeta().hidden); return (await models.all()).filter(model => !hidden.has(model.id)).map(({ provider, id, name, inputModalities }) => ({ provider, id, name, ...(inputModalities ? { inputModalities } : {}) })) }
      async resolveModel(provider, model) { return { ...resolveAgyModel(AGY_PROVIDER, model) } }
      async *stream(options) {
        const meta = getMeta()
        if (!meta.accounts.length) throw new AgyError('Antigravity のアカウントがありません。設定の「モデルルート」→「アカウント」でログインしてください', 'MISSING_CREDENTIAL')
        const start = Math.max(0, meta.accounts.indexOf(meta.active))
        const order = [...meta.accounts.slice(start), ...meta.accounts.slice(0, start)]
        const images = await imagesFor(options)
        const files = await resolveMultimodalFiles(options, { maxBytes: 20 * 1024 * 1024 })
        let lastError
        for (const n of order) {
          if (options.signal?.aborted) break
          let started = false
          try {
            const info = await session(n)
            for await (const chunk of sendWith(info, options, images, files)) { started = true; yield chunk }
            // 自動で切り替えたアカウントを、使用中として残す。モデル一覧もそのアカウントで読み直す。
            if (n !== getMeta().active) { await saveMeta({ ...getMeta(), active: n }); models.cache = null }
            return
          } catch (error) {
            if (started || options.signal?.aborted || !(error instanceof AgyError) || !SWITCHABLE.has(error.code)) throw error
            lastError = error
            logger?.info?.(`dsh-model-routes: Antigravity のアカウント ${n} が使えません(${error.code})。次のアカウントで試します`)
          }
        }
        throw lastError || new AgyError('取り消されました', 'ABORTED')
      }
    })()
  }

  return { accounts, models, session, createAdapter }
}
