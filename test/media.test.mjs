import test from 'node:test'
import assert from 'node:assert/strict'
import { generateImage, listMediaModels, generateVideo, mediaTarget, textToSpeech, transcribe, wavSeconds } from '../lib/media.mjs'

// 呼び出しを記録する偽の fetch。応答は responder が決める。
function fakeFetch(responder) {
  const calls = []
  const fetchImpl = async (url, init = {}) => { calls.push([url, init]); return responder(url, init, calls.length) }
  return { calls, fetchImpl }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64')

test('接続先: 追加アカウントは番号つきの鍵を使い、未対応や不足は分ける', () => {
  const target = mediaTarget({ provider: 'openai-api-2', model: 'gpt-image-1' })
  assert.equal(target.vendor, 'openai')
  assert.equal(target.apiKeyEnv, 'OPENAI_API_KEY_2')
  assert.equal(target.baseURL, 'https://api.openai.com/v1')
  assert.equal(mediaTarget({ provider: 'google-api', model: 'imagen-4.0-generate-001' }).apiKeyEnv, 'GEMINI_API_KEY')
  assert.throws(() => mediaTarget({ provider: 'anthropic-api', model: 'claude' }), { code: 'UNSUPPORTED' })
  assert.throws(() => mediaTarget({ provider: 'openai-api' }), { code: 'NOT_CONFIGURED' })
})

test('画像生成(OpenAI): b64 の PNG を取り出し、モデルと指示を送る', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json({ data: [{ b64_json: PNG_B64 }] }))
  const out = await generateImage(mediaTarget({ provider: 'openai-api', model: 'gpt-image-1' }), { prompt: '猫', size: '1024x1024' }, { apiKey: 'sk-test', fetchImpl })
  assert.equal(out.mediaType, 'image/png')
  assert.deepEqual([...out.data], PNG_BYTES)
  const [url, init] = calls[0]
  assert.equal(url, 'https://api.openai.com/v1/images/generations')
  assert.equal(init.headers.authorization, 'Bearer sk-test')
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'gpt-image-1')
  assert.equal(body.prompt, '猫')
  assert.equal(body.size, '1024x1024')
})

test('画像生成(Gemini): inlineData を選び、x-goog-api-key と generateContent を使う', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: '描きました' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] }))
  const out = await generateImage(mediaTarget({ provider: 'google-api', model: 'gemini-2.5-flash-image' }), { prompt: '犬' }, { apiKey: 'g-key', fetchImpl })
  assert.deepEqual([...out.data], PNG_BYTES)
  assert.equal(out.mediaType, 'image/png')
  assert.equal(calls[0][0], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent')
  assert.equal(calls[0][1].headers['x-goog-api-key'], 'g-key')
})

test('音声生成(Gemini): PCM を WAV に包み、長さが 1 秒と分かる', async () => {
  const pcm = new Uint8Array(48000) // 24000Hz・16bit・モノラルで 1 秒
  const { calls, fetchImpl } = fakeFetch(() => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } }] }))
  const out = await textToSpeech(mediaTarget({ provider: 'google-api', model: 'gemini-2.5-flash-preview-tts' }), { text: 'こんにちは', voice: 'Kore' }, { apiKey: 'g-key', fetchImpl })
  assert.equal(out.mediaType, 'audio/wav')
  assert.equal(out.extension, 'wav')
  assert.equal(new TextDecoder().decode(out.data.subarray(0, 4)), 'RIFF')
  assert.equal(wavSeconds(out.data), 1)
  assert.equal(JSON.parse(calls[0][1].body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore')
})

test('文字起こし(OpenAI): FormData でモデルと音声を送り、auto の言語は省く', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json({ text: 'こんにちは' }))
  const out = await transcribe(mediaTarget({ provider: 'openai-api', model: 'whisper-1' }), { audio: new Uint8Array([1, 2, 3]), language: 'auto' }, { apiKey: 'sk-test', fetchImpl })
  assert.equal(out.text, 'こんにちは')
  const [url, init] = calls[0]
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.ok(init.body instanceof FormData)
  assert.equal(init.body.get('model'), 'whisper-1')
  assert.ok(init.body.get('file') instanceof Blob)
  assert.equal(init.body.has('language'), false)
  assert.equal(init.headers['content-type'], undefined)
})

test('動画生成(OpenAI): 投稿、途中経過の確認、完了後の取得を順に行う', async () => {
  let polls = 0
  const { calls, fetchImpl } = fakeFetch((url) => {
    if (url.endsWith('/videos')) return json({ id: 'vid_1', status: 'queued' })
    if (url.endsWith('/videos/vid_1')) { polls++; return json({ id: 'vid_1', status: polls === 1 ? 'in_progress' : 'completed' }) }
    return new Response(new Uint8Array([7, 8, 9]), { status: 200 })
  })
  const progress = []
  const out = await generateVideo(mediaTarget({ provider: 'openai-api', model: 'sora-2' }), { prompt: '海', seconds: '4', aspectRatio: '16:9' }, { apiKey: 'sk-test', fetchImpl, pollMs: 0, onProgress: status => progress.push(status) })
  assert.deepEqual([...out.data], [7, 8, 9])
  assert.equal(out.mediaType, 'video/mp4')
  assert.deepEqual(progress, ['queued', 'in_progress'])
  assert.equal(calls.length, 4)
  assert.equal(calls[0][1].method, 'POST')
  const body = JSON.parse(calls[0][1].body)
  assert.equal(body.seconds, '4')
  assert.equal(body.size, '1280x720')
  assert.equal(calls[3][0], 'https://api.openai.com/v1/videos/vid_1/content')
})

test('動画生成: 待っている間に取り消すと拒否される', async () => {
  const controller = new AbortController()
  const { fetchImpl } = fakeFetch((url) => url.endsWith('/videos') ? json({ id: 'vid_2', status: 'queued' }) : json({ id: 'vid_2', status: 'in_progress' }))
  await assert.rejects(
    generateVideo(mediaTarget({ provider: 'openai-api', model: 'sora-2' }), { prompt: '雨' }, { apiKey: 'sk-test', fetchImpl, signal: controller.signal, pollMs: 10, onProgress: () => controller.abort() }),
    { name: 'AbortError' },
  )
})

test('HTTP エラー: 応答の error.message を取り出す', async () => {
  const { fetchImpl } = fakeFetch(() => json({ error: { message: 'Invalid prompt' } }, 400))
  await assert.rejects(generateImage(mediaTarget({ provider: 'openai-api', model: 'gpt-image-1' }), { prompt: 'x' }, { apiKey: 'sk-test', fetchImpl }), { code: 'HTTP', message: '400: Invalid prompt' })
})

test('鍵が空なら通信せず MISSING_CREDENTIAL', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json({}))
  await assert.rejects(generateImage(mediaTarget({ provider: 'openai-api-2', model: 'gpt-image-1' }), { prompt: 'x' }, { apiKey: '', fetchImpl }), { code: 'MISSING_CREDENTIAL' })
  assert.equal(calls.length, 0)
})

test('候補: 提供元の一覧を用途ごとに分け、日付付き・リアルタイム用は外す', async () => {
  const ids = ['gpt-6.1', 'gpt-image-2', 'gpt-image-2-2026-04-21', 'chatgpt-image-latest', 'tts-1', 'gpt-4o-mini-tts', 'whisper-1', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'gpt-realtime-whisper', 'sora-2']
  const target = mediaTarget({ provider: 'openai-api', model: '-' })
  const lists = await listMediaModels(target, { apiKey: 'k', fetchImpl: async () => Response.json({ data: ids.map(id => ({ id })) }) })
  assert.deepEqual(lists, { image: ['gpt-image-2', 'chatgpt-image-latest'], tts: ['tts-1', 'gpt-4o-mini-tts'], stt: ['whisper-1', 'gpt-4o-transcribe'], video: ['sora-2'] })
})
