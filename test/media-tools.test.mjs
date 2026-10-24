import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { STT_PROVIDER_ID, createMediaRegistry, createMediaTools } from '../lib/media-tools.mjs'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const credentials = { async resolve(name) { return name === 'OPENAI_API_KEY' ? { value: 'k' } : undefined } }
const imageFetch = async () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-routes-media-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}
const agentOn = (provider, model) => ({ options: { provider, model }, session: { requestHeader: () => undefined } })

test('道具: 用途にモデルが選ばれているものだけを出す', () => {
  let media = { image: { provider: 'openai-api', model: 'img' } }
  const tools = createMediaTools({ media: () => media, credentials: () => credentials })
  assert.deepEqual(tools.definitions().map(tool => tool.name), ['generate_image'])
  media = { tts: { provider: 'openai-api', model: 'tts' }, stt: { provider: 'google-api', model: 'g' }, video: { provider: 'xai-api', model: 'v' } }
  assert.deepEqual(tools.definitions().map(tool => tool.name), ['text_to_speech', 'transcribe_audio', 'generate_video'])
})

test('画像: 作業フォルダの generated/ に保存し、画像を読めるモデルのときだけ画像も返す', async t => {
  const dir = await workspace(t)
  const saved = []
  const tools = createMediaTools({
    media: () => ({ image: { provider: 'openai-api', model: 'img' } }),
    credentials: () => credentials,
    workingDirectory: () => ({ ensure: async () => dir }),
    attachments: () => ({ async saveImage(input) { saved.push(input); return { attachmentId: 'att1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 } } }),
    llm: () => ({ async resolveModelInfo(provider) { return { inputModalities: provider === 'vision' ? ['text', 'image'] : ['text'] } } }),
    fetchImpl: imageFetch,
    now: () => 'T',
  })
  const tool = tools.definitions()[0]
  const value = await tool.execute({ prompt: '猫' }, { agent: agentOn('vision', 'm'), signal: new AbortController().signal })
  assert.equal(value.path, path.join('generated', 'image-T.png'))
  assert.deepEqual([...await fs.readFile(path.join(dir, value.path))], [...PNG])
  assert.equal(value.image.attachmentId, 'att1')
  assert.deepEqual(tool.output.render({}, value).map(block => block.type), ['text', 'image'])
  const textOnly = await tool.execute({ prompt: '犬' }, { agent: agentOn('plain', 'm'), signal: new AbortController().signal })
  assert.equal(textOnly.image, undefined)
  assert.equal(saved.length, 1)
})

test('文字起こし: 作業フォルダの音声ファイルを送る。対応しない形式は断る', async t => {
  const dir = await workspace(t)
  await fs.writeFile(path.join(dir, 'a.mp3'), Uint8Array.from([1, 2, 3]))
  await fs.writeFile(path.join(dir, 'a.txt'), 'x')
  const sent = []
  const tools = createMediaTools({
    media: () => ({ stt: { provider: 'openai-api', model: 'whisper' } }),
    credentials: () => credentials,
    workingDirectory: () => ({ ensure: async () => dir }),
    fetchImpl: async (url, init) => { sent.push([url, init.body.get('file').type]); return Response.json({ text: 'こんにちは' }) },
  })
  const tool = tools.definitions()[0]
  const exec = { agent: agentOn('p', 'm'), signal: new AbortController().signal }
  assert.deepEqual(await tool.execute({ path: 'a.mp3', language: 'ja' }, exec), { text: 'こんにちは', model: 'whisper' })
  assert.deepEqual(sent, [['https://api.openai.com/v1/audio/transcriptions', 'audio/mpeg']])
  await assert.rejects(tool.execute({ path: 'a.txt' }, exec), error => error.code === 'UNSUPPORTED')
})

test('登録: 設定を変えると付け直し、文字起こしはモデルがある間だけ提供元にする', async () => {
  let media = { image: { provider: 'openai-api', model: 'img' } }
  const registered = new Map()
  const tools = { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } }
  const providers = []
  const speechToText = { register(provider) { providers.push(provider.info.id); return async () => { providers.splice(providers.indexOf(provider.info.id), 1) } } }
  const mediaTools = createMediaTools({ media: () => media, credentials: () => credentials })
  const registry = createMediaRegistry({ tools: () => tools, speechToText: () => speechToText, mediaTools, media: () => media })
  registry.sync()
  assert.deepEqual([[...registered.keys()], providers], [['generate_image'], []])
  media = { stt: { provider: 'openai-api', model: 'whisper' } }
  registry.sync()
  registry.sync()
  assert.deepEqual([[...registered.keys()], providers], [['transcribe_audio'], [STT_PROVIDER_ID]])
  await registry.dispose()
  assert.deepEqual([[...registered.keys()], providers], [[], []])
})

test('保存: 同じ秒に作っても上書きせず、番号を付ける', async t => {
  const dir = await workspace(t)
  const tools = createMediaTools({ media: () => ({ image: { provider: 'openai-api', model: 'img' } }), credentials: () => credentials, workingDirectory: () => ({ ensure: async () => dir }), fetchImpl: imageFetch, now: () => 'T' })
  const tool = tools.definitions()[0]
  const exec = { agent: agentOn('plain', 'm'), signal: new AbortController().signal }
  const paths = [(await tool.execute({ prompt: 'a' }, exec)).path, (await tool.execute({ prompt: 'b' }, exec)).path]
  assert.deepEqual(paths, [path.join('generated', 'image-T.png'), path.join('generated', 'image-T-2.png')])
})

test('文字起こし: 作業フォルダの外のファイルは読まない', async t => {
  const dir = await workspace(t)
  const outside = await workspace(t)
  await fs.writeFile(path.join(outside, 'secret.mp3'), Uint8Array.from([1]))
  let sent = 0
  const tools = createMediaTools({ media: () => ({ stt: { provider: 'openai-api', model: 'whisper' } }), credentials: () => credentials, workingDirectory: () => ({ ensure: async () => dir }), fetchImpl: async () => { sent++; return Response.json({ text: 'x' }) } })
  const tool = tools.definitions()[0]
  const exec = { agent: agentOn('p', 'm'), signal: new AbortController().signal }
  await assert.rejects(tool.execute({ path: path.join(outside, 'secret.mp3') }, exec), /作業フォルダの外/)
  await assert.rejects(tool.execute({ path: path.relative(dir, path.join(outside, 'secret.mp3')) }, exec), /作業フォルダの外/)
  assert.equal(sent, 0)
})

test('文字起こし: 作業フォルダ内のリンクで外を指しても読まず、「..」で始まる名前は読める', async t => {
  const dir = await workspace(t)
  const outside = await workspace(t)
  await fs.writeFile(path.join(outside, 'secret.mp3'), Uint8Array.from([1]))
  await fs.symlink(path.join(outside, 'secret.mp3'), path.join(dir, 'link.mp3'))
  await fs.writeFile(path.join(dir, '..take1.mp3'), Uint8Array.from([2]))
  const tools = createMediaTools({ media: () => ({ stt: { provider: 'openai-api', model: 'whisper' } }), credentials: () => credentials, workingDirectory: () => ({ ensure: async () => dir }), fetchImpl: async () => Response.json({ text: 'ok' }) })
  const tool = tools.definitions()[0]
  const exec = { agent: agentOn('p', 'm'), signal: new AbortController().signal }
  await assert.rejects(tool.execute({ path: 'link.mp3' }, exec), /作業フォルダの外/)
  assert.equal((await tool.execute({ path: '..take1.mp3' }, exec)).text, 'ok')
})

test('候補の控え: 変わったキーを使う枠だけ捨て、キーの指定が無ければ全部捨てる', async () => {
  const { dropMediaCandidates } = await import('../lib/index.js')
  const cache = new Map([['openai-api', { keyEnv: 'OPENAI_API_KEY' }], ['openai-api-2', { keyEnv: 'OPENAI_API_KEY_2' }], ['google-api', { keyEnv: 'GEMINI_API_KEY' }]])
  dropMediaCandidates(cache, 'OPENAI_API_KEY_2')
  assert.deepEqual([...cache.keys()], ['openai-api', 'google-api'])
  dropMediaCandidates(cache, undefined)
  assert.equal(cache.size, 0)
})

test('用途別の候補: API キーが変わった枠だけ世代を進め、ほかの枠の取得中の結果は書き込める', async () => {
  const { MediaCandidateCache, dropMediaCandidates } = await import('../lib/index.js')
  const cache = new MediaCandidateCache()
  cache.set('openai-api', { keyEnv: 'OPENAI_API_KEY', lists: {} })
  const openai = cache.genOf('openai-api')
  const gemini = cache.genOf('google-api') // a first fetch still running, nothing cached yet
  const xai = cache.genOf('xai-api')
  const fetching = new Map([['google-api', { keyEnv: 'GEMINI_API_KEY' }], ['xai-api', { keyEnv: 'XAI_API_KEY' }]])
  dropMediaCandidates(cache, 'OPENAI_API_KEY', fetching)
  assert.notEqual(cache.genOf('openai-api'), openai)
  assert.equal(cache.has('openai-api'), false)
  assert.equal(cache.genOf('google-api'), gemini, 'another service keeps its generation')
  dropMediaCandidates(cache, 'GEMINI_API_KEY', fetching)
  assert.notEqual(cache.genOf('google-api'), gemini, 'a fetch in progress with the changed key is invalidated too')
  assert.equal(cache.genOf('xai-api'), xai)
  // expireAll keeps the lists but makes them stale, and invalidates fetches in progress.
  cache.set('xai-api', { keyEnv: 'XAI_API_KEY', at: 5, lists: { image: ['grok-image'] } })
  cache.expireAll()
  assert.equal(cache.get('xai-api').at, 0)
  assert.deepEqual(cache.get('xai-api').lists, { image: ['grok-image'] })
  assert.notEqual(cache.genOf('xai-api'), xai)
})
