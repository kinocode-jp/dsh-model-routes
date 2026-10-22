// 用途別モデル(設定「モデルルート」→「用途別」)を、DSH の道具と文字起こしの提供元として登録する。
// - generate_image / text_to_speech / generate_video: 会話の中でモデルが呼ぶ道具。作ったファイルは作業フォルダの generated/ に置く。
// - transcribe_audio: 音声ファイルを文字に起こす道具。
// - 文字起こし: DSH の音声入力(speechToText、試験機能)が有効なら、その提供元「model-routes」にもなる。
// 用途にモデルが選ばれているものだけを登録し、設定を保存し直すたびに登録し直す。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MediaError, generateImage, generateVideo, mediaTarget, textToSpeech, transcribe, wavSeconds } from './media.mjs'

export const STT_PROVIDER_ID = 'model-routes'
const STT_LANGUAGES = ['auto', 'ja', 'en', 'zh', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru']
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const AUDIO_TYPE = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

// ファイル名に付ける日時(この PC の時刻)。例: 20261022-233040
const stamp = (date = new Date()) => {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
const fallbackDir = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'model-routes', 'media')

/**
 * @param {object} deps
 * @param {() => object} deps.media 今の用途別モデル(setup.media)
 * @param {() => object|undefined} deps.credentials DSH の資格情報サービス
 * @param {() => object|undefined} deps.workingDirectory 作業フォルダのサービス
 * @param {() => object|undefined} deps.attachments 添付のサービス
 * @param {() => object|undefined} deps.llm モデルの情報(画像を読めるか)を調べる
 */
export function createMediaTools({ media, credentials, workingDirectory = () => undefined, attachments = () => undefined, llm = () => undefined, fetchImpl, now = stamp }) {
  async function prepare(kind) {
    const target = mediaTarget(media()?.[kind])
    const store = credentials()
    const apiKey = store?.resolve ? (await store.resolve(target.apiKeyEnv))?.value : process.env[target.apiKeyEnv]
    return { target, options: { apiKey, ...(fetchImpl ? { fetchImpl } : {}) } }
  }

  async function workspaceOf(exec) {
    try { if (exec?.agent) return await workingDirectory()?.ensure?.(exec.agent, exec.signal) ?? null } catch {}
    return null
  }

  // 作業フォルダ(会話の外から呼ばれたときは DSH の保存先)の generated/ に書く。
  async function save(exec, base, ext, data) {
    const dir = await workspaceOf(exec)
    const folder = dir ? path.join(dir, 'generated') : fallbackDir()
    await fs.mkdir(folder, { recursive: true })
    // 同じ秒に作ったファイルを上書きしないよう、既にあれば -2, -3 … を付ける。
    const stem = `${base}-${now()}`
    for (let n = 1; n < 100; n++) {
      const file = path.join(folder, n === 1 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`)
      try { await fs.writeFile(file, data, { flag: 'wx' }) } catch (error) { if (error?.code === 'EEXIST') continue; throw error }
      return { file, display: dir ? path.relative(dir, file) : file }
    }
    throw new MediaError('FAILED', '保存先のファイル名を決められません')
  }

  // 読み取りは作業フォルダ(会話の外からは DSH の保存先)の中だけ。外のファイルを外部へ送らないようにする。
  async function insideWorkspace(exec, requested) {
    const base = await fs.realpath((await workspaceOf(exec)) || fallbackDir()).catch(() => null)
    if (!base) throw new MediaError('FAILED', '作業フォルダが分からないため、ファイルを読めません')
    const file = await fs.realpath(path.resolve(base, requested)).catch(() => { throw new MediaError('FAILED', `ファイルが見つかりません: ${requested}`) })
    const relative = path.relative(base, file)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new MediaError('FAILED', '作業フォルダの外のファイルは読めません')
    return file
  }

  // 画像を読めるモデルのときだけ、画像そのものも会話に返す(read_image と同じ判定)。
  async function canSeeImages(exec) {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    const service = llm()
    if (!provider || !model || !service?.resolveModelInfo) return false
    try { return (await service.resolveModelInfo(provider, model, exec.signal))?.inputModalities?.includes('image') === true } catch { return false }
  }

  const string = description => ({ type: 'string', description })
  const savedSchema = extra => ({ type: 'object', additionalProperties: false, required: ['path', 'model'], properties: { path: { type: 'string' }, model: { type: 'string' }, ...extra } })
  const savedText = (what, value) => `${what}を保存しました: ${value.path}(${value.model})`

  const TOOLS = {
    image: () => ({
      name: 'generate_image',
      description: '文章の指示から画像を作り、作業フォルダの generated/ に保存する。使うモデルは設定「モデルルート」→「用途別」の画像モデル。',
      parameters: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: string('描いてほしい内容(具体的に)'), size: string('大きさ。例: 1024x1024, 1536x1024(対応するモデルだけ)') } },
      timeoutMs: 300_000,
      output: {
        schema: savedSchema({ mediaType: { type: 'string' }, image: { type: 'object' } }),
        render: (_args, value) => [{ type: 'text', text: savedText('画像', value) }, ...(value.image ? [{ type: 'image', attachment: value.image }] : [])],
      },
      async execute(args, exec) {
        if (typeof args?.prompt !== 'string' || !args.prompt.trim()) throw new MediaError('FAILED', 'prompt を指定してください')
        const { target, options } = await prepare('image')
        const result = await generateImage(target, { prompt: args.prompt, ...(typeof args.size === 'string' && args.size ? { size: args.size } : {}) }, { ...options, signal: exec?.signal })
        const saved = await save(exec, 'image', IMAGE_EXT[result.mediaType] || 'png', result.data)
        const value = { path: saved.display, model: target.model, mediaType: result.mediaType }
        const store = attachments()
        if (store?.saveImage && IMAGE_EXT[result.mediaType] && await canSeeImages(exec)) {
          try {
            const ref = await store.saveImage({ data: result.data, mediaType: result.mediaType, name: path.basename(saved.file) })
            value.image = { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }
          } catch {}
        }
        return value
      },
    }),
    tts: () => ({
      name: 'text_to_speech',
      description: '文章を読み上げた音声ファイルを作り、作業フォルダの generated/ に保存する。使うモデルは設定「モデルルート」→「用途別」の読み上げモデル。',
      parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: string('読み上げる文章'), voice: string('声の名前(省略可。OpenAI は alloy など、Gemini は Kore など)') } },
      timeoutMs: 180_000,
      output: { schema: savedSchema({ mediaType: { type: 'string' } }), render: (_args, value) => [{ type: 'text', text: savedText('音声', value) }] },
      async execute(args, exec) {
        if (typeof args?.text !== 'string' || !args.text.trim()) throw new MediaError('FAILED', 'text を指定してください')
        const { target, options } = await prepare('tts')
        const result = await textToSpeech(target, { text: args.text, ...(typeof args.voice === 'string' && args.voice ? { voice: args.voice } : {}) }, { ...options, signal: exec?.signal })
        const saved = await save(exec, 'speech', result.extension, result.data)
        return { path: saved.display, model: target.model, mediaType: result.mediaType }
      },
    }),
    stt: () => ({
      name: 'transcribe_audio',
      description: '音声ファイル(wav / mp3 / m4a / webm / ogg / flac、25MB まで)を文字に起こす。使うモデルは設定「モデルルート」→「用途別」の文字起こしモデル。',
      parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: string('音声ファイルの場所(作業フォルダからの相対パス。作業フォルダの外は読めない)'), language: string('言語コード(例: ja, en)。省略すると自動') } },
      timeoutMs: 300_000,
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['text', 'model'], properties: { text: { type: 'string' }, model: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.text || '(聞き取れる言葉がありませんでした)' }],
      },
      async execute(args, exec) {
        if (typeof args?.path !== 'string' || !args.path.trim()) throw new MediaError('FAILED', 'path を指定してください')
        const file = await insideWorkspace(exec, args.path)
        const mediaType = AUDIO_TYPE[path.extname(file).toLowerCase()]
        if (!mediaType) throw new MediaError('UNSUPPORTED', `対応していない音声の形式です: ${path.extname(file) || '(拡張子なし)'}`)
        const stat = await fs.stat(file)
        if (stat.size > MAX_AUDIO_BYTES) throw new MediaError('FAILED', '音声ファイルが 25MB を超えています')
        const { target, options } = await prepare('stt')
        const language = typeof args.language === 'string' && /^[a-z]{2,3}$/.test(args.language) ? args.language : undefined
        const result = await transcribe(target, { audio: new Uint8Array(await fs.readFile(file)), mediaType, language }, { ...options, signal: exec?.signal })
        return { text: result.text, model: target.model }
      },
    }),
    video: () => ({
      name: 'generate_video',
      description: '文章の指示から短い動画を作り、作業フォルダの generated/ に保存する(数分かかることがある)。使うモデルは設定「モデルルート」→「用途別」の動画モデル。',
      parameters: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: string('動画の内容'), seconds: string('長さ(秒)。例: 4, 8(対応するモデルだけ)'), aspect_ratio: { type: 'string', enum: ['16:9', '9:16'], description: '縦横比' } } },
      timeoutMs: 900_000,
      output: { schema: savedSchema({ mediaType: { type: 'string' } }), render: (_args, value) => [{ type: 'text', text: savedText('動画', value) }] },
      async execute(args, exec) {
        if (typeof args?.prompt !== 'string' || !args.prompt.trim()) throw new MediaError('FAILED', 'prompt を指定してください')
        const { target, options } = await prepare('video')
        const seconds = /^\d{1,3}$/.test(String(args.seconds ?? '')) ? String(args.seconds) : undefined
        const aspectRatio = args.aspect_ratio === '16:9' || args.aspect_ratio === '9:16' ? args.aspect_ratio : undefined
        const result = await generateVideo(target, { prompt: args.prompt, seconds, aspectRatio }, { ...options, signal: exec?.signal, timeoutMs: 850_000 })
        const saved = await save(exec, 'video', 'mp4', result.data)
        return { path: saved.display, model: target.model, mediaType: result.mediaType }
      },
    }),
  }

  /** 用途にモデルが選ばれている道具の定義。 */
  const definitions = () => Object.entries(TOOLS).filter(([kind]) => media()?.[kind]?.model).map(([, make]) => make())

  /** 音声入力の提供元。WAV(16kHz・モノラル)を受け取り、選んだ文字起こしモデルへ送る。 */
  const speechProvider = () => ({
    info: { id: STT_PROVIDER_ID, name: 'モデルルート(用途別の文字起こし)', location: 'cloud', languages: STT_LANGUAGES },
    async transcribe(input, signal) {
      const started = Date.now()
      const { target, options } = await prepare('stt')
      const result = await transcribe(target, { audio: input.audio, mediaType: 'audio/wav', language: input.language }, { ...options, signal })
      return { text: result.text, audioSeconds: wavSeconds(input.audio), inferenceSeconds: (Date.now() - started) / 1000 }
    },
  })

  return { definitions, speechProvider }
}

/**
 * 登録を、今の設定に合わせ直す。道具は同じ名前のものを外してから付け直す。
 * @returns {{ sync(): void, dispose(): void }}
 */
export function createMediaRegistry({ tools, speechToText, mediaTools, media, logger }) {
  let toolDisposers = []
  let speech = null
  let speechKey = ''
  const sync = () => {
    for (const dispose of toolDisposers) { try { dispose() } catch {} }
    toolDisposers = []
    if (tools()?.register) {
      for (const definition of mediaTools.definitions()) {
        try { toolDisposers.push(tools().register(definition)) } catch (error) { logger?.warn?.(`dsh-model-routes: 道具 ${definition.name} を登録できません`, error) }
      }
    }
    // 文字起こしは、モデルが選ばれている間だけ提供元として出す。
    const step = media()?.stt
    const key = step?.model ? step.provider + '/' + step.model : ''
    const service = speechToText()
    if (key === speechKey && (speech || !key)) return
    if (speech) { const closing = speech; speech = null; Promise.resolve(closing()).catch(() => {}) }
    speechKey = key
    if (key && service?.register) {
      try { speech = service.register(mediaTools.speechProvider()) } catch (error) { logger?.warn?.('dsh-model-routes: 文字起こしの提供元を登録できません', error) }
    }
  }
  const dispose = () => {
    for (const fn of toolDisposers) { try { fn() } catch {} }
    toolDisposers = []
    if (speech) { const closing = speech; speech = null; speechKey = ''; return Promise.resolve(closing()).catch(() => {}) }
  }
  return { sync, dispose }
}
