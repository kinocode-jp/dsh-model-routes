// @kinocode/dsh-model-routes - 互換性パッチ
// Node.js 24 環境下での AbortSignal.any の WebIDL 厳格化バグ対策

/**
 * Node.js 24 における AbortSignal.any の WebIDL 厳格化バグ対策。
 * pi-ai の postJson 等で AbortSignal.any([signal, ...]) に signal が undefined で渡されると
 * TypeError: signals[0] is not of type AbortSignal でクラッシュするため、
 * null/undefined を除外する安全なラッパーを適用します。
 */
export function patchAbortSignal() {
  if (globalThis.AbortSignal && typeof globalThis.AbortSignal.any === 'function') {
    const originalAny = globalThis.AbortSignal.any;
    if (!originalAny.__dsh_patched) {
      const patchedAny = function(signals) {
        if (!signals) return new AbortController().signal;
        const filtered = Array.from(signals).filter(s => s != null);
        if (filtered.length === 0) return new AbortController().signal;
        if (filtered.length === 1) return filtered[0];
        return originalAny.call(AbortSignal, filtered);
      };
      patchedAny.__dsh_patched = true;
      globalThis.AbortSignal.any = patchedAny;
    }
  }
}
