import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MANY_IMAGE_THRESHOLD, manyImageLimitOf, offloadTargets, parseManyImageLimit, recoverFromManyImageLimit,
  registerImageLimitRecovery, requestDimensions, retainedImages, selectOffload,
} from '../lib/image-limits.js'

const ERROR = '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.16.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels"},"request_id":"req_x"}'

// DSH のセッションの必要な部分だけ(image/offload を読む仕組みを含む)。
function fakeSession(sizes, { projection = true } = {}) {
  const events = []
  let seq = 0
  for (const group of sizes) {
    seq += 1
    const content = [{ type: 'text', text: 'x' }, ...group.map(([width, height], i) => ({ type: 'image', attachment: { attachmentId: `a${seq}-${i}`, width, height } }))]
    events.push({ seq, type: 'tool/result', data: { message: { role: 'tool', content } } })
  }
  const projected = new Map()
  const appended = []
  return {
    appended,
    surface: { nodes: events.map(event => event.seq) },
    eventAt: s => events.find(event => event.seq === s),
    deriveEventMessage: event => projected.get(event.seq) ?? event.data.message,
    append(type, data) {
      appended.push({ type, data })
      if (!projection || type !== 'image/offload') return
      for (const target of data.targets) {
        const message = projected.get(target.seq) ?? events.find(event => event.seq === target.seq).data.message
        let index = 0
        const content = message.content.map(block => {
          if (block.type !== 'image') return block
          const hit = target.imageIndexes.includes(index)
          index += 1
          return hit ? { ...block, offloaded: true } : block
        })
        projected.set(target.seq, { ...message, content })
      }
    },
  }
}

test('Claude の「画像が多いときの上限」の文面を読む', () => {
  assert.equal(parseManyImageLimit(ERROR), 3000)
  assert.equal(parseManyImageLimit('At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels'), 2000)
  assert.equal(parseManyImageLimit('400 prompt is too long'), null)
  assert.equal(parseManyImageLimit(undefined), null)
  assert.equal(manyImageLimitOf({ message: ERROR, code: 'INVALID_REQUEST' }), 3000)
  assert.equal(manyImageLimitOf({ message: 'wrapped', cause: { failure: { message: ERROR } } }), 3000)
})

test('送るときの大きさは llm-pi-ai と同じく画素数だけで縮める', () => {
  // 実際のセッション: 1373x3051 は約 419 万画素で、縮められずに長い辺 3051 のまま送られていた
  assert.deepEqual(requestDimensions(1373, 3051), { width: 1373, height: 3051 })
  assert.deepEqual(requestDimensions(390, 3262), { width: 390, height: 3262 })
  const big = requestDimensions(4000, 4000)
  assert.ok(big.width * big.height <= 2048 * 2048)
})

test('20 枚以下なら外さない(上限を超える画像が無ければ)', () => {
  const images = Array.from({ length: MANY_IMAGE_THRESHOLD }, (_, i) => ({ seq: i + 1, index: 0, longEdge: 2600 }))
  assert.deepEqual(selectOffload(images, 3000), [])
})

test('直近以外で上限を超える画像だけを外す', () => {
  const images = [
    { seq: 1, index: 0, longEdge: 3051 },
    ...Array.from({ length: 20 }, (_, i) => ({ seq: i + 2, index: 0, longEdge: 2400 })),
  ]
  assert.deepEqual(selectOffload(images, 3000), [{ seq: 1, index: 0 }])
})

test('直近の画像が上限を超えるときは、古い画像を外して 20 枚にする(直近は残す)', () => {
  const images = [
    ...Array.from({ length: 22 }, (_, i) => ({ seq: i + 1, index: 0, longEdge: 1000 })),
    { seq: 23, index: 0, longEdge: 3262 },
  ]
  const chosen = selectOffload(images, 3000)
  assert.equal(images.length - chosen.length, MANY_IMAGE_THRESHOLD)
  assert.deepEqual(chosen.map(image => image.seq), [1, 2, 3])
})

test('大きさが分からないときは、古い画像を外して 20 枚にする', () => {
  const images = Array.from({ length: 21 }, (_, i) => ({ seq: i + 1, index: 0, longEdge: null }))
  assert.deepEqual(selectOffload(images, 3000), [{ seq: 1, index: 0 }])
})

test('外した画像の番号は、外し済みの画像も含めて数える', () => {
  const session = fakeSession([[[1000, 3200], [1000, 1000]]])
  session.append('image/offload', { targets: [{ seq: 1, imageIndexes: [0] }] })
  assert.deepEqual(retainedImages(session, [1]), [{ seq: 1, index: 1, longEdge: 1000 }])
  assert.deepEqual(offloadTargets([{ seq: 3, index: 1 }, { seq: 1, index: 0 }, { seq: 3, index: 0 }]), [{ seq: 3, imageIndexes: [0, 1] }, { seq: 1, imageIndexes: [0] }])
})

test('記録が反映されない(image/offload を読む仕組みが無い)ときは外したことにしない', () => {
  const sizes = [[[1373, 3051]], ...Array.from({ length: 20 }, () => [[1440, 2400]])]
  const session = fakeSession(sizes, { projection: false })
  assert.equal(recoverFromManyImageLimit({ session, seqs: session.surface.nodes, error: { message: ERROR } }), null)
})

function hooks() {
  const handlers = {}
  const logs = []
  const ctx = { on: (name, fn) => { handlers[name] = fn }, logger: { info: m => logs.push(m), warn: m => logs.push(m) } }
  return { ctx, handlers, logs }
}

test('会話の要求が断られたら、画像を外して送り直す', async () => {
  const { ctx, handlers } = hooks()
  registerImageLimitRecovery(ctx)
  const sizes = [[[1373, 3051]], [[390, 2600]], ...Array.from({ length: 19 }, () => [[1440, 2400]])]
  const session = fakeSession(sizes)
  const agent = { session }
  let passed = 0
  const next = () => { passed += 1; return Promise.resolve(undefined) }
  const action = await handlers['agent/request-error']({ agent, failure: { message: ERROR, code: 'INVALID_REQUEST' }, turn: 4, step: 19, signal: new AbortController().signal }, next)
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(passed, 0)
  assert.deepEqual(session.appended, [{ type: 'image/offload', data: { targets: [{ seq: 1, imageIndexes: [0] }] } }])
  // 外したあとは上限を超える画像が無いので、同じ失敗が来ても外すものは無い → 次へ渡す
  await handlers['agent/request-error']({ agent, failure: { message: ERROR }, turn: 4, step: 19, signal: new AbortController().signal }, next)
  assert.equal(passed, 1)
})

test('別の失敗は次へ渡す', async () => {
  const { ctx, handlers } = hooks()
  registerImageLimitRecovery(ctx)
  let passed = 0
  await handlers['agent/request-error']({ agent: { session: fakeSession([]) }, failure: { message: '429 rate limited', code: 'RATE_LIMITED' }, signal: new AbortController().signal }, () => { passed += 1 })
  assert.equal(passed, 1)
  assert.equal(handlers['compaction/summary-error']({ session: fakeSession([]), sourceEventSeqs: [], error: new Error('x') }, () => false), false)
})

test('/compact の要約が断られたら、画像を外して要約をやり直す', () => {
  const { ctx, handlers } = hooks()
  registerImageLimitRecovery(ctx)
  const sizes = [...Array.from({ length: 21 }, () => [[1440, 2400]]), [[1226, 3417]]]
  const session = fakeSession(sizes)
  const error = Object.assign(new Error(ERROR), { code: 'INVALID_REQUEST' })
  assert.equal(handlers['compaction/summary-error']({ session, sourceEventSeqs: session.surface.nodes, error }, () => false), true)
  // 直近(要約に入る最後のメッセージ)が上限を超えるので、古い画像を外して 20 枚にする
  assert.deepEqual(session.appended[0].data.targets, [{ seq: 1, imageIndexes: [0] }, { seq: 2, imageIndexes: [0] }])
})

test('ルートの画素数の設定を使って、送るときの大きさを計算する', async () => {
  const { ctx, handlers } = hooks()
  // 画素数を 100 万に絞ったルートなら 1373x3051 は 671x1491 程度まで縮むので、上限 3000 を超えない
  registerImageLimitRecovery(ctx, provider => provider === 'small' ? 1_000_000 : undefined)
  const sizes = [[[1373, 3051]], ...Array.from({ length: 20 }, () => [[1440, 2400]])]
  const session = fakeSession(sizes)
  let passed = 0
  await handlers['agent/request-error']({ agent: { session }, provider: 'small', failure: { message: ERROR }, turn: 1, step: 1, signal: new AbortController().signal }, () => { passed += 1 })
  // 上限を超える画像は無いと計算されるので、20 枚まで古い順に外す
  assert.equal(passed, 0)
  assert.deepEqual(session.appended[0].data.targets, [{ seq: 1, imageIndexes: [0] }])
})

test('外す画像が無くなったら次へ渡す(送り直しを繰り返さない)', async () => {
  const { ctx, handlers } = hooks()
  registerImageLimitRecovery(ctx)
  const session = fakeSession(Array.from({ length: 40 }, () => [[100, 100]]))
  const agent = { session }
  const results = []
  for (let i = 0; i < 10; i += 1) {
    // すべての画像が上限を超える: 1回目で 20 枚まで減らし、2回目で残りも外し、3回目は外すものが無い
    results.push(await handlers['agent/request-error']({ agent, failure: { message: ERROR.replace('3000', '50') }, turn: 1, step: 1, signal: new AbortController().signal }, () => 'next'))
  }
  assert.deepEqual(results.slice(0, 3).map(r => r?.kind ?? r), ['retry', 'retry', 'next'])
})
