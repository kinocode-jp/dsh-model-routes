// 画像の大きさの制限で要求が断られたときに、古い画像を外して送り直す。
//
// Claude(Anthropic)は、1回の要求に画像が 20 枚を超えると、1枚ごとの縦横の上限を下げる
// (エラー例: "At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels")。
// DSH の llm-pi-ai は画像を「画素数」でしか縮めないため、縦長の全ページのスクリーンショットは長い辺が上限を超えたまま残る。
// 画像は会話の履歴に残るので、以後の要求(送り直し・続き・/compact の要約)がすべて同じエラーで失敗し、
// セッションが進めなくなる。DSH の画像の退避(compaction-image-offload)は、合計バイト数の超過でしか動かない。
//
// ここでは、そのエラーを受けたときに、DSH と同じ image/offload の記録を残して画像を外し(以後は文字の案内に置き換わる)、
// 要求を送り直す。外す画像の選び方:
//   1. 直近の画像を含むメッセージ以外で、送るときの大きさが上限を超える画像(古い順)
//   2. それでも 20 枚を超え、直近のメッセージにも上限を超える画像があるなら、20 枚になるまで古い画像
//   3. 計算で該当が見つからないときは、20 枚になるまで古い画像
// 外した画像は、ファイルの場所を示す文字に置き換わる。モデルは必要なら、縮めてから読み直せる。

/** 画像が何枚を超えると、1枚ごとの上限が下がるか(Anthropic の仕様)。 */
export const MANY_IMAGE_THRESHOLD = 20;
/** llm-pi-ai が送る画像の画素数の既定値(ルートの requestImagePixelBudget)。 */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
/** 1回の要求で失敗が続いたときに、送り直しをやめる回数。 */
const MAX_RECOVERIES_PER_STEP = 6;

const MANY_IMAGE_DIMENSION = /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;

/**
 * 断られた理由が「画像が多いときの縦横の上限」なら、その上限(画素)を返す。
 * @param {unknown} message エラーの文面
 * @returns {number|null}
 */
export function parseManyImageLimit(message) {
  if (typeof message !== 'string') return null;
  const match = MANY_IMAGE_DIMENSION.exec(message);
  if (!match) return null;
  const limit = Number(match[1]);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

/** エラー(失敗の情報・LlmError・その原因)から文面を集める。 */
function messagesOf(error) {
  const out = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && out.length < 8) {
    seen.add(current);
    if (typeof current.message === 'string') out.push(current.message);
    if (typeof current.failure?.message === 'string') out.push(current.failure.message);
    current = current.cause;
  }
  if (typeof error === 'string') out.push(error);
  return out;
}

/** 失敗のどこかに、画像が多いときの上限の文面があれば、その上限を返す。 */
export function manyImageLimitOf(error) {
  for (const message of messagesOf(error)) {
    const limit = parseManyImageLimit(message);
    if (limit !== null) return limit;
  }
  return null;
}

/**
 * llm-pi-ai と同じ計算で、送るときの縦横を求める(画素数だけで縮める)。
 * @returns {{ width: number, height: number }}
 */
export function requestDimensions(width, height, maxPixels = DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let w = Math.max(1, Math.floor(width * scale));
    let h = Math.max(1, Math.round(w * height / width));
    while (w * h > maxPixels && w > 1) { w -= 1; h = Math.max(1, Math.round(w * height / width)); }
    return { width: w, height: h };
  }
  let h = Math.max(1, Math.floor(height * scale));
  let w = Math.max(1, Math.round(h * width / height));
  while (w * h > maxPixels && h > 1) { h -= 1; w = Math.max(1, Math.round(h * width / height)); }
  return { width: w, height: h };
}

/**
 * 要求に入る画像(まだ外していないもの)を、送る順に並べる。
 * 番号(index)は、DSH の image/offload と同じく、メッセージ内の画像を外したものも含めて数える。
 * @param session DSH のセッション(eventAt / deriveEventMessage)
 * @param {number[]} seqs 要求に入るメッセージの記録番号(送る順)
 * @param {number} pixelBudget 送るときの画素数の上限
 */
export function retainedImages(session, seqs, pixelBudget = DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET) {
  const images = [];
  for (const seq of seqs) {
    let event;
    try { event = session.eventAt(seq); } catch { continue; }
    if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue;
    const message = session.deriveEventMessage(event);
    if (!Array.isArray(message?.content)) continue;
    let index = 0;
    for (const block of message.content) {
      if (block?.type !== 'image') continue;
      if (block.offloaded !== true) {
        const { width, height } = block.attachment || {};
        const known = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
        const sent = known ? requestDimensions(width, height, pixelBudget) : null;
        images.push({ seq, index, longEdge: sent ? Math.max(sent.width, sent.height) : null });
      }
      index += 1;
    }
  }
  return images;
}

/**
 * 外す画像を選ぶ(先頭のコメントの 1〜3)。
 * @param {{ seq: number, index: number, longEdge: number|null }[]} images 送る順の画像
 * @param {number} limit 1枚ごとの縦横の上限
 * @returns {{ seq: number, index: number }[]} 外す画像(送る順)
 */
export function selectOffload(images, limit, threshold = MANY_IMAGE_THRESHOLD) {
  if (images.length === 0) return [];
  const oversized = image => image.longEdge !== null && image.longEdge > limit;
  // 数え方が想定と違う(文書なども数える等)ときは、上限を超える画像だけを外す。
  if (images.length <= threshold) return images.filter(oversized).map(({ seq, index }) => ({ seq, index }));
  const latestSeq = images[images.length - 1].seq;
  const chosen = new Set(images.filter(image => image.seq !== latestSeq && oversized(image)));
  const left = images.filter(image => !chosen.has(image));
  const stillOversized = left.some(oversized);
  // 上限を超える画像が残る(直近のメッセージにある・計算で見つからない)ときは、20 枚まで減らす。
  if (left.length > threshold && (stillOversized || chosen.size === 0)) {
    for (const image of left) {
      if (images.length - chosen.size <= threshold) break;
      chosen.add(image);
    }
  }
  return images.filter(image => chosen.has(image)).map(({ seq, index }) => ({ seq, index }));
}

/** 選んだ画像を、DSH の image/offload の形にまとめる。 */
export function offloadTargets(selected) {
  const bySeq = new Map();
  for (const { seq, index } of selected) {
    if (!bySeq.has(seq)) bySeq.set(seq, []);
    bySeq.get(seq).push(index);
  }
  return [...bySeq].map(([seq, indexes]) => ({ seq, imageIndexes: [...indexes].sort((a, b) => a - b) }));
}

/** 記録したあと、選んだ画像が本当に外れたか(image/offload を読む仕組みが動いているか)。 */
function offloaded(session, targets) {
  for (const target of targets) {
    const message = session.deriveEventMessage(session.eventAt(target.seq));
    let index = 0;
    const flags = [];
    for (const block of message?.content || []) if (block?.type === 'image') { flags[index] = block.offloaded === true; index += 1; }
    if (!target.imageIndexes.every(i => flags[i] === true)) return false;
  }
  return true;
}

/**
 * 画像を外す。外せたら true。
 * @returns {{ count: number }|null}
 */
export function recoverFromManyImageLimit({ session, seqs, error, pixelBudget, logger }) {
  const limit = manyImageLimitOf(error);
  if (limit === null || !session || !Array.isArray(seqs)) return null;
  const selected = selectOffload(retainedImages(session, seqs, pixelBudget), limit);
  if (selected.length === 0) return null;
  const targets = offloadTargets(selected);
  try {
    session.append('image/offload', { targets });
  } catch (err) {
    logger?.warn?.('dsh-model-routes: 画像を外す記録を残せません(compaction-image-offload が無効の可能性)', err);
    return null;
  }
  if (!offloaded(session, targets)) {
    logger?.warn?.('dsh-model-routes: 画像を外す記録が反映されません(compaction-image-offload が無効の可能性)');
    return null;
  }
  logger?.info?.(`dsh-model-routes: 画像が多いときの縦横の上限(${limit}px)で断られたため、古い画像 ${selected.length} 枚を外して送り直します`);
  return { count: selected.length };
}

/**
 * DSH の受け口に登録する。
 * - agent/request-error: 会話の要求が断られたとき(送り直す)
 * - compaction/summary-error: /compact などの要約が断られたとき(要約をやり直す)
 * @param ctx プラグインの context(on / logger)
 * @param {(provider: string|undefined) => number|undefined} pixelBudgetOf ルートの requestImagePixelBudget
 */
export function registerImageLimitRecovery(ctx, pixelBudgetOf = () => undefined) {
  if (typeof ctx?.on !== 'function') return;
  // 同じ要求で失敗が続くとき、送り直しを打ち切る(画像が外れずに同じ失敗を繰り返さないように)。
  const attempts = new WeakMap();
  const budget = provider => {
    const value = pixelBudgetOf(provider);
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET;
  };
  ctx.on('agent/request-error', (payload, next) => {
    const { agent, failure, signal, turn, step, provider } = payload || {};
    if (signal?.aborted || manyImageLimitOf(failure) === null || !agent?.session) return next();
    const key = `${turn}:${step}`;
    const seen = attempts.get(agent.session);
    const count = seen?.key === key ? seen.count : 0;
    if (count >= MAX_RECOVERIES_PER_STEP) return next();
    const result = recoverFromManyImageLimit({ session: agent.session, seqs: agent.session.surface?.nodes || [], error: failure, pixelBudget: budget(provider), logger: ctx.logger });
    if (!result) return next();
    attempts.set(agent.session, { key, count: count + 1 });
    return Promise.resolve({ kind: 'retry' });
  });
  ctx.on('compaction/summary-error', (payload, next) => {
    const { session, sourceEventSeqs, error, signal } = payload || {};
    if (signal?.aborted || manyImageLimitOf(error) === null) return next();
    const result = recoverFromManyImageLimit({ session, seqs: sourceEventSeqs, error, pixelBudget: budget(undefined), logger: ctx.logger });
    if (!result) return next();
    return true;
  });
}
