// Antigravity(Google の Cloud Code Assist 内部 API)に接続するための定数。
// 値は dsh-agy 0.4.6(MIT, https://github.com/chaos-03x/dsh-agy)の公開ソースと同じ。
// Antigravity アプリに埋め込まれた公開の OAuth クライアントを使う。
// 識別情報は固定の1種類だけを送る(dsh-agy の stable モード相当)。アカウントごとに偽装・乱数化する機能は持たない。

export const AGY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const AGY_CLIENT_SECRET = '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'
export const AGY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]
export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

// 接続先は順に試す(混雑・拒否の応答なら次へ)。
export const AGY_ENDPOINT_FALLBACKS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
]
export const AGY_ENDPOINT_SKIP_STATUSES = new Set([429, 403, 503])

const AGY_VERSION = '1.2.9'
export const currentAgyVersion = () => AGY_VERSION
export const getAgyBootstrapUserAgent = (version = AGY_VERSION) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${version} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`

/** 会話の送信で使う、固定の識別情報。 */
export const AGY_REQUEST_HEADERS = {
  'User-Agent': `antigravity/${AGY_VERSION} darwin/arm64`,
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
}
export const AGY_CLIENT_METADATA = { ideType: 'ANTIGRAVITY', ideVersion: AGY_VERSION, platform: 'DARWIN_ARM64' }

/** 接続先を順に試し、最初に「混雑・拒否以外」を返したものを使う。 */
export async function fetchAgyFirstOk(urlPath, init, fetchImpl = fetch) {
  let lastSkipped = null
  let lastError
  for (const base of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchImpl(base + urlPath, init)
      if (!AGY_ENDPOINT_SKIP_STATUSES.has(response.status)) return response
      lastSkipped = response
    } catch (error) {
      if (init?.signal?.aborted) throw error
      lastError = error
    }
  }
  if (lastSkipped) return lastSkipped
  throw lastError || new Error('Antigravity のすべての接続先に接続できません')
}
