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
  // Without release dates the larger version comes first; names without a version go last.
  assert.deepEqual(lists, { image: ['gpt-image-2', 'chatgpt-image-latest'], tts: ['gpt-4o-mini-tts', 'tts-1'], stt: ['gpt-4o-transcribe', 'whisper-1'], video: ['sora-2'] })
})

test('候補: 新しい順。公開日時(created)があればその順、無ければ系列ごとに版番号の大きい順', async () => {
  const openai = mediaTarget({ provider: 'openai-api', model: '-' })
  const data = [{ id: 'dall-e-3', created: 1698785189 }, { id: 'gpt-image-1', created: 1745517030 }, { id: 'gpt-image-1.5', created: 1765000000 }, { id: 'tts-1', created: 1681940951 }, { id: 'gpt-4o-mini-tts', created: 1742403959 }]
  const lists = await listMediaModels(openai, { apiKey: 'k', fetchImpl: async () => Response.json({ data }) })
  assert.deepEqual(lists.image, ['gpt-image-1.5', 'gpt-image-1', 'dall-e-3'])
  assert.deepEqual(lists.tts, ['gpt-4o-mini-tts', 'tts-1'])
  const gemini = mediaTarget({ provider: 'google-api', model: '-' })
  const models = ['imagen-3.0-generate-002', 'gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'gemini-3-pro-image-preview'].map(id => ({ name: 'models/' + id }))
  const google = await listMediaModels(gemini, { apiKey: 'k', fetchImpl: async () => Response.json({ models }) })
  assert.deepEqual(google.image, ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'imagen-3.0-generate-002'])
})

test('新しい順: Gemini は系列ごと(Gemini → Imagen)・版の大きい順・同じ版なら基本のモデルが先。日時あり・なし混在、日時が同じ場合も決まった順', async () => {
  const { newestFirst } = await import('../lib/media.mjs')
  assert.deepEqual(newestFirst(['imagen-4.0-ultra-generate-001', 'imagen-4.0-fast-generate-001', 'imagen-4.0-generate-001', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'imagen-3.0-generate-002']),
    ['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001', 'imagen-4.0-ultra-generate-001', 'imagen-3.0-generate-002'])
  // Without dates the gpt-image line comes before dall-e.
  assert.deepEqual(newestFirst(['dall-e-3', 'gpt-image-1', 'gpt-image-1.5', 'dall-e-2']), ['gpt-image-1.5', 'gpt-image-1', 'dall-e-3', 'dall-e-2'])
  // Dated models first (newest date first; equal dates by version), then the undated ones.
  const created = new Map([['b', 200], ['a', 100], ['tie-2', 150], ['tie-1', 150]])
  assert.deepEqual(newestFirst(['gpt-image-9', 'a', 'tie-2', 'b', 'tie-1'], created), ['b', 'tie-2', 'tie-1', 'a', 'gpt-image-9'])
  // The order does not depend on the input order.
  const ids = ['imagen-4.0-generate-001', 'gemini-2.5-flash-image', 'imagen-4.0-fast-generate-001', 'gemini-3-pro-image-preview', 'veo-3.0-generate-001']
  const once = newestFirst(ids)
  // Every rotation and its reverse: fixed inputs, so a failure can be reproduced.
  for (let i = 0; i < ids.length; i++) {
    const rotated = [...ids.slice(i), ...ids.slice(0, i)]
    assert.deepEqual(newestFirst(rotated), once)
    assert.deepEqual(newestFirst(rotated.reverse()), once)
  }
})

test('動画(Gemini): 転送先へは API キーを送らない', async () => {
  const target = mediaTarget({ provider: 'google-api', model: 'veo' })
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.headers?.['x-goog-api-key'] ?? null])
    if (String(url).endsWith(':predictLongRunning')) return Response.json({ name: 'operations/1' })
    if (String(url).endsWith('/operations/1')) return Response.json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files.example/v1' } }] } } })
    if (String(url) === 'https://files.example/v1') return new Response(null, { status: 302, headers: { location: 'https://storage.example/v.mp4' } })
    return new Response(Uint8Array.from([7, 8]), { status: 200 })
  }
  const result = await generateVideo(target, { prompt: 'p' }, { apiKey: 'k', fetchImpl, pollMs: 0 })
  assert.deepEqual([...result.data], [7, 8])
  assert.deepEqual(calls.slice(-2), [['https://files.example/v1', 'k'], ['https://storage.example/v.mp4', null]])
})

test('動画(Gemini): 同じホスト内の転送ではキーを付け直す', async () => {
  const target = mediaTarget({ provider: 'google-api', model: 'veo' })
  const keys = []
  const fetchImpl = async (url, init = {}) => {
    url = String(url)
    if (url.endsWith(':predictLongRunning')) return Response.json({ name: 'operations/1' })
    if (url.endsWith('/operations/1')) return Response.json({ done: true, response: { generatedVideos: [{ video: { uri: 'https://api.example/files/a' } }] } })
    keys.push([url, init.headers?.['x-goog-api-key'] ?? null])
    if (url === 'https://api.example/files/a') return new Response(null, { status: 307, headers: { location: '/files/a:download' } })
    if (url === 'https://api.example/files/a:download') return new Response(null, { status: 302, headers: { location: 'https://cdn.example/x' } })
    return new Response(Uint8Array.from([1]), { status: 200 })
  }
  await generateVideo(target, { prompt: 'p' }, { apiKey: 'k', fetchImpl, pollMs: 0 })
  assert.deepEqual(keys, [['https://api.example/files/a', 'k'], ['https://api.example/files/a:download', 'k'], ['https://cdn.example/x', null]])
})

test('新しい順: 同じ版の Gemini は flash を pro より先にし、続いた変種の語(fast-ultra)も数える', async () => {
  const { newestFirst } = await import('../lib/media.mjs')
  assert.deepEqual(newestFirst(['gemini-2.5-pro', 'gemini-2.5-flash']), ['gemini-2.5-flash', 'gemini-2.5-pro'])
  assert.deepEqual(newestFirst(['gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts']), ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'])
  assert.deepEqual(newestFirst(['x-fast-ultra-1', 'x-fast-1', 'x-1']), ['x-1', 'x-fast-1', 'x-fast-ultra-1'])
  // A flash variant still comes before the same version's pro.
  assert.deepEqual(newestFirst(['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash']), ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'])
})
