// モデル登録のログイン用ホストサービス。
// サブスク(OAuth)枠のログインを、DSH の認証サービス(ctx.authorization)で実行する。
// 進行中のログイン(認証URL・コード入力)の状態を持ち、画面からは短い間隔で読み取る。
import { plainJson } from './auth-contracts.js'
import { createMessages } from './auth-messages.js'

const MAX_NOTICES = 10
const safeUrl = value => {
  if (typeof value !== 'string') return undefined
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined } catch { return undefined }
}
const clip = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : ''
const errorText = error => clip(error?.message || String(error), 500)

/**
 * @param deps.authorization  () => ctx.authorization 相当(begin/cancel/describe)
 * @param deps.credentials    () => ctx.credentials 相当(describeRecord/readRecord/deleteRecord)
 * @param deps.targets        () => サブスク枠の一覧 [{ providerId, routeId, label }]
 * @param deps.messages       (key, params) => 画面に出す文言。既定は ja
 */
export function createAuthService({ authorization, credentials, targets, logger, messages = createMessages() }) {
  let current = null
  let counter = 0
  let disposed = false

  const keyOf = routeId => 'llm-pi-ai/' + routeId
  const targetOf = routeId => {
    const target = targets().find(item => item.routeId === routeId)
    if (!target) throw new TypeError(messages('unknownRoute'))
    return target
  }
  const view = attempt => attempt === null ? null : plainJson({
    id: attempt.id, routeId: attempt.routeId, label: attempt.label, phase: attempt.phase,
    notices: attempt.notices, prompt: attempt.prompt, error: attempt.error ?? null,
  })

  async function recordType(key) {
    try {
      const record = await credentials()?.readRecord?.(key)
      const type = record?.payload?.type
      return type === 'oauth' || type === 'api_key' ? type : null
    } catch { return null }
  }

  async function routeState(target) {
    const creds = credentials()
    const auth = authorization()
    const key = keyOf(target.routeId)
    let registered = false
    try { registered = (await creds?.describeRecord?.(key))?.configured === true } catch {}
    const flow = auth?.describe?.(key)
    return {
      providerId: target.providerId, routeId: target.routeId, label: target.label,
      registered, credentialType: registered ? await recordType(key) : null,
      canLogin: Array.isArray(flow?.methods) && flow.methods.some(method => method.id === 'oauth'),
    }
  }

  const api = {
    async getAuthState() {
      const routes = []
      for (const target of targets()) routes.push(await routeState(target))
      return plainJson({ routes, attempt: view(current) })
    },

    async startLogin(routeId) {
      if (disposed) throw new Error(messages('stopped'))
      const target = targetOf(routeId)
      const auth = authorization()
      if (typeof auth?.begin !== 'function') throw new Error(messages('noAuthService'))
      const key = keyOf(routeId)
      const flow = auth.describe?.(key)
      if (!flow || !flow.methods?.some(method => method.id === 'oauth')) throw new Error(messages('noOauth'))
      if (current && (current.phase === 'running' || current.phase === 'prompt')) throw new Error(messages('busy'))

      const attempt = { id: 'a' + (++counter), routeId, key, label: target.label, phase: 'running', notices: [], prompt: null, error: null, pending: null, controller: new AbortController() }
      current = attempt
      const interaction = {
        notify: notice => {
          const next = { message: clip(notice?.message) }
          const url = safeUrl(notice?.url)
          if (url) next.url = url
          if (typeof notice?.code === 'string') next.code = clip(notice.code, 200)
          attempt.notices = [...attempt.notices, next].slice(-MAX_NOTICES)
        },
        prompt: prompt => new Promise((resolve, reject) => {
          if (attempt.pending) attempt.pending.reject(new Error(messages('promptSuperseded')))
          const id = 'p' + (++counter)
          const clear = () => { if (attempt.pending?.id === id) { attempt.pending = null; attempt.prompt = null; if (attempt.phase === 'prompt') attempt.phase = 'running' } }
          attempt.pending = { id, resolve: value => { clear(); resolve(value) }, reject: error => { clear(); reject(error) } }
          const shown = { id, kind: ['text', 'secret', 'select'].includes(prompt?.kind) ? prompt.kind : 'text', message: clip(prompt?.message) }
          if (typeof prompt?.placeholder === 'string') shown.placeholder = clip(prompt.placeholder, 200)
          // 選択肢は { id, label }。答えには id を返すので、表示名だけにしない。
          if (Array.isArray(prompt?.options)) shown.options = prompt.options.slice(0, 50).map(option => {
            const id = typeof option === 'string' ? option : option?.id ?? option?.value
            return { id: clip(String(id), 200), label: clip(String(typeof option === 'string' ? option : option?.label ?? id), 200) }
          })
          attempt.prompt = shown
          attempt.phase = 'prompt'
          const signal = prompt?.signal
          if (signal) {
            const onAbort = () => attempt.pending?.id === id && attempt.pending.reject(new Error(messages('promptNotNeeded')))
            if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
          }
        }),
      }
      auth.begin({ key, method: 'oauth', signal: attempt.controller.signal, interaction }).then(outcome => {
        attempt.phase = outcome?.status === 'authorized' ? 'done' : 'cancelled'
      }, error => {
        attempt.phase = attempt.phase === 'cancelled' ? 'cancelled' : 'error'
        if (attempt.phase === 'error') attempt.error = errorText(error)
        logger?.warn?.('dsh-model-routes: ' + messages('loginFailed', { message: errorText(error) }))
      }).finally(() => { attempt.pending = null; attempt.prompt = null })
      return view(attempt)
    },

    async getAttempt() { return view(current) },

    async answerPrompt(promptId, value) {
      const attempt = current
      if (!attempt?.pending || attempt.pending.id !== promptId) throw new Error(messages('promptRejected'))
      attempt.pending.resolve(value)
      return view(attempt)
    },

    async cancelLogin() {
      const attempt = current
      if (!attempt || (attempt.phase !== 'running' && attempt.phase !== 'prompt')) return view(attempt)
      attempt.phase = 'cancelled'
      attempt.pending?.reject(new Error(messages('cancelled')))
      try { authorization()?.cancel?.(attempt.key) } catch {}
      attempt.controller.abort()
      return view(attempt)
    },

    async dismissAttempt() {
      if (current && current.phase !== 'running' && current.phase !== 'prompt') current = null
      return api.getAuthState()
    },

    async logout(routeId) {
      const target = targetOf(routeId)
      if (current && current.routeId === routeId && (current.phase === 'running' || current.phase === 'prompt')) throw new Error(messages('logoutBusy'))
      const creds = credentials()
      if (typeof creds?.deleteRecord !== 'function') throw new Error(messages('noCredentials'))
      await creds.deleteRecord(keyOf(target.routeId))
      return api.getAuthState()
    },

    dispose() { disposed = true; if (current && (current.phase === 'running' || current.phase === 'prompt')) { try { api.cancelLogin() } catch {} } current = null },
  }
  Object.defineProperty(api, 'typertRemote', { value: { service: api, serviceKey: 'modelRoutesAuth', namespace: 'modelRoutesAuth' } })
  return api
}
