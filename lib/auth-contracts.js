// ログイン用ホストサービスの Typert コーデック。依存ライブラリなし。
// 常に切り離した素の JSON を返し、DSH のオブジェクトや秘密情報は渡さない。
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function plainJson(value, maxBytes = 100_000) {
  let count = 0
  const visit = (v, depth = 0) => {
    if (++count > 20_000 || depth > 12) throw new TypeError('JSON の構造が複雑すぎます')
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (Array.isArray(v)) return v.map(x => visit(x, depth + 1))
    if (!isObject(v)) throw new TypeError('素の JSON ではありません')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new TypeError('安全でない JSON キーです')
      return [k, visit(x, depth + 1)]
    }))
  }
  const result = visit(value)
  if (new TextEncoder().encode(JSON.stringify(result)).length > maxBytes) throw new TypeError('JSON が大きすぎます')
  return result
}

export const recordSchema = { parse(value) { if (!isObject(value)) throw new TypeError('オブジェクトではありません'); return plainJson(value) } }
export const nullableRecordSchema = { parse(value) { return value === null ? null : recordSchema.parse(value) } }
export const routeIdSchema = { parse(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new TypeError('ルートIDが不正です')
  return value
} }
export const promptIdSchema = { parse(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new TypeError('入力IDが不正です')
  return value
} }
// 認証コードなどの入力。長さだけ制限し、内容は検査も記録もしない。
export const answerSchema = { parse(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw new TypeError('入力が不正です')
  return value
} }
// モデルID(カタログのID)。英数字と . _ : / @ + - だけ。
export const modelIdSchema = { parse(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value)) throw new TypeError('モデルIDが不正です')
  return value
} }
export const visibleSchema = { parse(value) {
  if (typeof value !== 'boolean') throw new TypeError('表示/非表示は真偽値で指定してください')
  return value
} }
