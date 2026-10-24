// メディア生成(画像・音声・動画)を、ベンダーの HTTP API で直接呼ぶ。
// 対象は API キーの枠(openai-api / google-api / xai-api とその追加アカウント)だけ。
// 通信は fetchImpl で差し替えられ、設定の読み書きや画面には触れない。

export const MEDIA_VENDORS = {
  openai: { routeId: 'openai-api', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1' },
  google: { routeId: 'google-api', apiKeyEnv: 'GEMINI_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  xai: { routeId: 'xai-api', apiKeyEnv: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1' },
}

/** コードで分けて扱う失敗。code: NOT_CONFIGURED | UNSUPPORTED | MISSING_CREDENTIAL | HTTP | TIMEOUT | FAILED */
export class MediaError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MediaError'
    this.code = code
  }
}

// ルートIDから(ベンダー, 追加アカウント番号)を読む。例: openai-api-2 → openai, 2
function vendorOf(provider) {
  const id = typeof provider === 'string' ? provider : ''
  for (const [vendor, { routeId }] of Object.entries(MEDIA_VENDORS)) {
    if (id === routeId) return { vendor, n: 1 }
    const suffix = id.slice(routeId.length + 1)
    if (id.startsWith(routeId + '-') && /^\d+$/.test(suffix) && Number(suffix) >= 2) return { vendor, n: Number(suffix) }
  }
  return null
}

/** チェーンのステップ { provider, model } から、呼び出し先の情報を作る。 */
export function mediaTarget(step) {
  if (!step) throw new MediaError('NOT_CONFIGURED', 'メディア生成の接続先が設定されていません')
  if (!step.model) throw new MediaError('NOT_CONFIGURED', `${step.provider ?? ''} のモデルが設定されていません`)
  const found = vendorOf(step.provider)
  if (!found) {
    throw new MediaError('UNSUPPORTED', `「${step.provider}」は未対応のサービスです。メディア生成に使えるのは OpenAI・Gemini・Grok の API キーの枠(openai-api / google-api / xai-api)だけです`)
  }
  const info = MEDIA_VENDORS[found.vendor]
  // 追加アカウントの鍵名は BASE_KEY_N(例: OPENAI_API_KEY_2)。
  const apiKeyEnv = found.n === 1 ? info.apiKeyEnv : info.apiKeyEnv + '_' + found.n
  return { vendor: found.vendor, provider: step.provider, model: step.model, apiKeyEnv, baseURL: info.baseURL }
}

// 認証ヘッダ。鍵が無ければ、どの鍵名が未登録かを伝える。
function authFor(target, apiKey) {
  if (!apiKey) throw new MediaError('MISSING_CREDENTIAL', `「${target.apiKeyEnv}」のAPIキーが登録されていません`)
  return target.vendor === 'google' ? { 'x-goog-api-key': apiKey } : { authorization: 'Bearer ' + apiKey }
}

const unsupported = (target, what) => new MediaError('UNSUPPORTED', `「${target.provider}」は${what}に対応していません`)
const noOutput = (what, text) => new MediaError('FAILED', `モデルが${what}を返しませんでした` + (text ? ': ' + String(text).slice(0, 300) : ''))

// 失敗した応答から、ベンダーのエラーメッセージを取り出す。
async function httpError(response) {
  const text = await response.text().catch(() => '')
  let message = ''
  try {
    const error = JSON.parse(text)?.error
    message = typeof error === 'string' ? error : error?.message ?? ''
  } catch {}
  if (!message) message = text || response.statusText || ''
  return new MediaError('HTTP', `${response.status}: ${String(message).slice(0, 300)}`)
}

async function request(fetchImpl, url, init, signal) {
  const response = await fetchImpl(url, { ...init, signal })
  if (!response.ok) throw await httpError(response)
  return response
}

const postJson = (fetchImpl, url, headers, body, signal) => request(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, signal)
const getJson = async (fetchImpl, url, headers, signal) => (await request(fetchImpl, url, { headers }, signal)).json()
const bytesOf = async response => new Uint8Array(await response.arrayBuffer())
const b64ToBytes = value => new Uint8Array(Buffer.from(String(value), 'base64'))
const bytesToB64 = bytes => Buffer.from(bytes).toString('base64')
const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length))

// 画像の種類を、先頭のバイト列から調べる。分からなければ null。
function sniffImage(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
  return null
}

// Gemini の応答から、部品(parts)と、その中の音声・画像(inlineData)を取り出す。
const partsOf = json => (json?.candidates ?? []).flatMap(candidate => candidate?.content?.parts ?? [])
const inlineOf = part => {
  const inline = part?.inlineData ?? part?.inline_data
  return inline?.data ? { data: inline.data, mimeType: inline.mimeType ?? inline.mime_type } : null
}
const textOf = parts => parts.map(part => part?.text ?? '').join('').trim()

// 待つ(取り消しに応じて途中で止まる)。
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('取り消されました'))
    if (signal?.aborted) return abort()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); abort() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// 生成が終わるまで状態を見続ける。
async function pollJob(start, { next, isDone, fail, label, pollMs, deadline, signal, onProgress }) {
  let job = start
  while (!isDone(job)) {
    fail?.(job)
    if (Date.now() > deadline) throw new MediaError('TIMEOUT', '動画の生成が時間内に終わりませんでした')
    onProgress?.(label(job))
    await sleep(pollMs, signal)
    job = await next()
  }
  return job
}

/** 画像を作る。戻り値 { data, mediaType }。 */
export async function generateImage(target, { prompt, size } = {}, { apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
  const headers = authFor(target, apiKey)
  const base = target.baseURL
  if (target.vendor === 'google') {
    if (target.model.startsWith('imagen')) {
      const json = await postJson(fetchImpl, `${base}/models/${target.model}:predict`, headers, { instances: [{ prompt }], parameters: { sampleCount: 1 } }, signal).then(r => r.json())
      const prediction = json.predictions?.[0]
      if (!prediction?.bytesBase64Encoded) throw noOutput('画像')
      const data = b64ToBytes(prediction.bytesBase64Encoded)
      return { data, mediaType: sniffImage(data) ?? prediction.mimeType ?? 'image/png' }
    }
    const json = await postJson(fetchImpl, `${base}/models/${target.model}:generateContent`, headers, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }, signal).then(r => r.json())
    const parts = partsOf(json)
    const inline = parts.map(inlineOf).find(Boolean)
    if (!inline) throw noOutput('画像', textOf(parts))
    const data = b64ToBytes(inline.data)
    return { data, mediaType: sniffImage(data) ?? inline.mimeType ?? 'image/png' }
  }
  // OpenAI / xAI(どちらも images/generations)。b64 が無ければ URL から取る。
  const body = target.vendor === 'xai'
    ? { model: target.model, prompt, n: 1, response_format: 'b64_json' }
    : { model: target.model, prompt, n: 1, ...(size ? { size } : {}) }
  const json = await postJson(fetchImpl, `${base}/images/generations`, headers, body, signal).then(r => r.json())
  const item = json.data?.[0]
  let data = null
  if (item?.b64_json) data = b64ToBytes(item.b64_json)
  else if (item?.url) data = await bytesOf(await request(fetchImpl, item.url, { redirect: 'follow' }, signal))
  if (!data) throw noOutput('画像')
  return { data, mediaType: sniffImage(data) ?? (target.vendor === 'xai' ? 'image/jpeg' : 'image/png') }
}

// PCM(16bit)に WAV の見出しを付ける。
export function wavFromPcm16(pcm, sampleRate = 24000, channels = 1) {
  const blockAlign = channels * 2
  const out = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(out.buffer)
  const write = (at, text) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i) }
  write(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // 16bit
  write(36, 'data'); view.setUint32(40, pcm.byteLength, true)
  out.set(pcm, 44)
  return out
}

/** PCM の WAV の長さ(秒)。読めなければ 0。 */
export function wavSeconds(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    if (u8.byteLength < 12 || ascii(u8, 0, 4) !== 'RIFF' || ascii(u8, 8, 4) !== 'WAVE') return 0
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    let pos = 12
    let format = null
    let dataSize = null
    while (pos + 8 <= u8.byteLength && !(format && dataSize !== null)) {
      const id = ascii(u8, pos, 4)
      const size = view.getUint32(pos + 4, true)
      const body = pos + 8
      if (id === 'fmt ') format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) }
      else if (id === 'data') dataSize = Math.min(size, u8.byteLength - body)
      pos = body + size + (size & 1)
    }
    if (!format?.channels || !format.sampleRate || !format.bits || dataSize === null) return 0
    return dataSize / (format.sampleRate * format.channels * format.bits / 8)
  } catch {
    return 0
  }
}

/** 音声を作る。戻り値 { data, mediaType, extension }。 */
export async function textToSpeech(target, { text, voice } = {}, { apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
  if (target.vendor === 'xai') throw unsupported(target, '音声合成')
  const headers = authFor(target, apiKey)
  if (target.vendor === 'openai') {
    const response = await postJson(fetchImpl, `${target.baseURL}/audio/speech`, headers, { model: target.model, input: text, voice: voice || 'alloy', response_format: 'mp3' }, signal)
    return { data: await bytesOf(response), mediaType: 'audio/mpeg', extension: 'mp3' }
  }
  const json = await postJson(fetchImpl, `${target.baseURL}/models/${target.model}:generateContent`, headers, {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } },
  }, signal).then(r => r.json())
  const parts = partsOf(json)
  const inline = parts.map(inlineOf).find(Boolean)
  if (!inline) throw noOutput('音声', textOf(parts))
  // 例: audio/L16;codec=pcm;rate=24000。レートが読めなければ 24000。
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || 24000
  return { data: wavFromPcm16(b64ToBytes(inline.data), rate, 1), mediaType: 'audio/wav', extension: 'wav' }
}

// 音声の形式から拡張子を決める。
const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/wav': 'wav', 'audio/x-wav': 'wav' }
const extensionOf = type => AUDIO_EXT[String(type).split(';')[0].trim()] ?? 'wav'

/** 音声を文字に起こす。戻り値 { text }。 */
export async function transcribe(target, { audio, mediaType = 'audio/wav', language } = {}, { apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
  if (target.vendor === 'xai') throw unsupported(target, '文字起こし')
  const headers = authFor(target, apiKey)
  if (target.vendor === 'openai') {
    const form = new FormData()
    form.append('file', new Blob([audio], { type: mediaType }), 'audio.' + extensionOf(mediaType))
    form.append('model', target.model)
    if (language && language !== 'auto') form.append('language', language)
    // Content-Type は FormData が境界つきで決めるので、手で付けない。
    const json = await request(fetchImpl, `${target.baseURL}/audio/transcriptions`, { method: 'POST', headers, body: form }, signal).then(r => r.json())
    return { text: json.text ?? '' }
  }
  let instruction = 'この音声を文字起こししてください。話された言葉だけを、そのまま出力してください。'
  if (language && language !== 'auto') instruction += '\n言語: ' + language
  const json = await postJson(fetchImpl, `${target.baseURL}/models/${target.model}:generateContent`, headers, {
    contents: [{ parts: [{ inlineData: { mimeType: mediaType, data: bytesToB64(audio) } }, { text: instruction }] }],
  }, signal).then(r => r.json())
  return { text: textOf(partsOf(json)) }
}

// 転送(リダイレクト)を自分でたどる。API キーは最初と同じホストへだけ送り、保存用の別ホストなどへは送らない。
async function fetchKeepingKeyOnHost(fetchImpl, uri, headers, signal) {
  const host = new URL(uri).host
  let url = uri
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetchImpl(url, { headers: new URL(url).host === host ? headers : {}, redirect: 'manual', signal })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (!location) {
      if (!response.ok) throw await httpError(response)
      return response
    }
    url = new URL(location, url).toString()
  }
  throw new MediaError('FAILED', '動画の取得で転送が多すぎます')
}

/** 動画を作る。完了まで待つ。戻り値 { data, mediaType: 'video/mp4' }。 */
export async function generateVideo(target, { prompt, seconds, aspectRatio } = {}, { apiKey, fetchImpl = globalThis.fetch, signal, pollMs = 5000, timeoutMs = 600000, onProgress } = {}) {
  const headers = authFor(target, apiKey)
  const base = target.baseURL
  const timing = { pollMs, deadline: Date.now() + timeoutMs, signal, onProgress }
  const failed = (message = '動画の生成に失敗しました') => new MediaError('FAILED', message)

  if (target.vendor === 'openai') {
    const body = { model: target.model, prompt }
    if (seconds) body.seconds = String(seconds)
    const size = { '16:9': '1280x720', '9:16': '720x1280' }[aspectRatio]
    if (size) body.size = size
    const created = await postJson(fetchImpl, `${base}/videos`, headers, body, signal).then(r => r.json())
    await pollJob(created, {
      ...timing,
      next: () => getJson(fetchImpl, `${base}/videos/${created.id}`, headers, signal),
      isDone: j => j.status === 'completed',
      fail: j => { if (j.status === 'failed') throw failed(j.error?.message) },
      label: j => j.status,
    })
    const data = await bytesOf(await request(fetchImpl, `${base}/videos/${created.id}/content`, { headers }, signal))
    return { data, mediaType: 'video/mp4' }
  }

  if (target.vendor === 'google') {
    const parameters = {}
    if (aspectRatio) parameters.aspectRatio = aspectRatio
    if (seconds) parameters.durationSeconds = Number(seconds)
    const started = await postJson(fetchImpl, `${base}/models/${target.model}:predictLongRunning`, headers, { instances: [{ prompt }], parameters }, signal).then(r => r.json())
    const op = await pollJob(started, {
      ...timing,
      next: () => getJson(fetchImpl, `${base}/${started.name}`, headers, signal),
      isDone: j => j.done === true,
      label: () => 'running',
    })
    if (op.error) throw failed(op.error.message)
    const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ?? op.response?.generatedVideos?.[0]?.video?.uri
    if (!uri) throw failed('動画が返りませんでした')
    const data = await bytesOf(await fetchKeepingKeyOnHost(fetchImpl, uri, headers, signal))
    return { data, mediaType: 'video/mp4' }
  }

  // xAI
  const body = { model: target.model, prompt }
  if (seconds) body.duration = Number(seconds)
  if (aspectRatio) body.aspect_ratio = aspectRatio
  const created = await postJson(fetchImpl, `${base}/videos/generations`, headers, body, signal).then(r => r.json())
  const job = await pollJob(created, {
    ...timing,
    next: () => getJson(fetchImpl, `${base}/videos/${created.request_id}`, headers, signal),
    isDone: j => !!j.video?.url || j.status === 'done',
    fail: j => { if (j.status === 'failed' || j.status === 'expired') throw failed() },
    label: j => j.status ?? 'running',
  })
  const url = job.video?.url
  if (!url) throw failed('動画が返りませんでした')
  // 動画の URL は認証なしで取る。
  const data = await bytesOf(await request(fetchImpl, url, { redirect: 'follow' }, signal))
  return { data, mediaType: 'video/mp4' }
}

// 用途ごとのモデル名の目安(提供元の一覧から候補を選ぶため)。
const KIND_PATTERNS = {
  image: /(^|[-/])(gpt-image|chatgpt-image|dall-e|imagen|grok-[\w.-]*image)|-image(-|$)/,
  tts: /tts|-speech/,
  stt: /transcribe|whisper/,
  video: /^(sora|veo)|grok-[\w.-]*video/,
}
const NOT_FILE_API = /realtime|live|diarize|audio-preview|-\d{4}-\d{2}-\d{2}$|-\d{8}$/

/** 提供元のモデル一覧(/models)から、用途ごとの候補を作る。戻り値 { image: [id…], tts, stt, video }。 */
export async function listMediaModels(target, { apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
  const headers = authFor(target, apiKey)
  /** @type {Map<string, number|undefined>} id -> release time (seconds), when the provider gives one */
  const entries = new Map()
  if (target.vendor === 'google') {
    const json = await getJson(fetchImpl, `${target.baseURL}/models?pageSize=1000`, headers, signal)
    for (const model of json.models ?? []) entries.set(String(model.name ?? '').replace(/^models\//, ''), undefined)
  } else {
    const json = await getJson(fetchImpl, `${target.baseURL}/models`, headers, signal)
    for (const model of json.data ?? json.models ?? []) entries.set(String(model.id ?? ''), Number.isFinite(model.created) ? model.created : undefined)
  }
  entries.delete('')
  const ids = newestFirst([...entries.keys()].filter(id => !NOT_FILE_API.test(id)), entries)
  const result = {}
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) {
    const list = ids.filter(id => pattern.test(id))
    // Grok は読み上げ・文字起こしに対応しない。Gemini の読み上げは名前に tts を含むものだけ。
    result[kind] = target.vendor === 'xai' && (kind === 'tts' || kind === 'stt') ? [] : list
  }
  if (target.vendor === 'google') result.stt = ids.filter(id => /^gemini-[\d.]+-(flash|pro)(-lite)?$/.test(id))
  return result
}

// モデル ID の版番号(gpt-image-1.5 → [1,5]、gemini-2.5-flash-image → [2,5]、gpt-4o-mini-tts → [4])。
const versionOf = id => {
  const version = []
  for (const token of String(id).toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)) {
    const match = /^[a-z]*(\d+(?:\.\d+)*)[a-z]?$/.exec(token)
    if (match) { version.push(...match[1].split('.').map(Number)); continue }
    if (version.length) break
  }
  while (version.length > 1 && version.at(-1) === 0) version.pop() // 3.0 と 3 は同じ版
  return version
}
/**
 * 新しい順: 提供元が公開日時(created)を返すもの(OpenAI・Grok)はその新しい順、返さないもの(Gemini)は
 * 版番号の大きい順。版番号の無いものは後ろ。
 * @param {string[]} ids
 * @param {Map<string, number|undefined>} created
 */
export function newestFirst(ids, created = new Map()) {
  const byVersion = (a, b) => {
    const x = versionOf(a), y = versionOf(b)
    if (!x.length || !y.length) return y.length - x.length
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === undefined) return 1
      if (y[i] === undefined) return -1
      if (x[i] !== y[i]) return y[i] - x[i]
    }
    return 0
  }
  return [...ids].sort((a, b) => {
    const ca = created.get(a), cb = created.get(b)
    if (ca !== undefined && cb !== undefined && ca !== cb) return cb - ca
    if ((ca === undefined) !== (cb === undefined)) return ca === undefined ? 1 : -1
    return byVersion(a, b) || a.localeCompare(b)
  })
}
