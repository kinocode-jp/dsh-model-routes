// サブスク(OAuth)の複数アカウント。
// DSH の pi-ai はログインをサービスごとに1件(資格情報の記録 llm-pi-ai/<ルートID>)で持つ。
// このプラグインは、使っていないアカウントのログイン記録を同じ資格情報の中に自分の名前で保管し、
// 「使用中」を切り替えるときに llm-pi-ai/<ルートID> と入れ替える。DSH の接続処理はそのまま使う。
// トークンの自動更新は DSH が使用中の記録に書くので、その内容を保管先にも写して最新に保つ。

/** DSH が使う、使用中のログイン記録。 */
export const activeKey = routeId => 'llm-pi-ai/' + routeId
/** このプラグインが保管する、各アカウントのログイン記録。 */
export const slotKey = (routeId, n) => 'model-routes/oauth-' + routeId + '-' + n

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 保存する設定: { ルートID: { active: 番号, accounts: [番号…], labels: { 番号: 名前 } } } */
export function normalizeOauth(value, allowed = () => true) {
  const result = {}
  if (!isObject(value)) return result
  for (const [routeId, entry] of Object.entries(value)) {
    if (!allowed(routeId) || !isObject(entry)) continue
    const accounts = [...new Set((Array.isArray(entry.accounts) ? entry.accounts : []).filter(n => Number.isInteger(n) && n >= 1 && n <= 9))].sort((a, b) => a - b)
    if (!accounts.length) continue
    const labels = {}
    if (isObject(entry.labels)) for (const n of accounts) if (typeof entry.labels[n] === 'string' && entry.labels[n].trim()) labels[n] = entry.labels[n].trim().slice(0, 40)
    result[routeId] = { active: accounts.includes(entry.active) ? entry.active : accounts[0], accounts, labels }
  }
  return result
}

/**
 * アカウントの束を扱う。
 * @param deps.credentials () => DSH の資格情報サービス(readRecord / modifyRecord / deleteRecord / describeRecord)
 * @param deps.get         () => 現在の設定(normalizeOauth の形)
 * @param deps.save        (next) => 設定を保存する
 */
export function createOauthAccounts({ credentials, get, save }) {
  const store = () => {
    const service = credentials()
    if (!service || typeof service.readRecord !== 'function' || typeof service.modifyRecord !== 'function') throw new Error('DSH の資格情報サービスに接続できません')
    return service
  }
  const read = async key => { try { return await store().readRecord(key) } catch { return undefined } }
  const write = async (key, record) => {
    const service = store()
    if (record) await service.modifyRecord(key, async () => record)
    else if (typeof service.deleteRecord === 'function') await service.deleteRecord(key)
  }
  const entryOf = routeId => get()[routeId]
  const put = async (routeId, entry) => {
    const all = { ...get() }
    if (entry) all[routeId] = entry; else delete all[routeId]
    await save(all)
  }

  // 使用中の記録を、使用中アカウントの保管先へ写す(トークンの自動更新を取りこぼさないため)。
  async function syncActive(routeId) {
    const entry = entryOf(routeId)
    if (!entry) return
    const current = await read(activeKey(routeId))
    if (current?.kind !== 'grant') return
    // 書き込みは「記録が更新された」通知を呼び、その通知でまたここへ来る。同じ内容なら書かずに止める。
    const saved = await read(slotKey(routeId, entry.active))
    if (JSON.stringify(saved) !== JSON.stringify(current)) await write(slotKey(routeId, entry.active), current)
  }

  // まだ束になっていないサービスを、今のログインを「アカウント 1」として束にする。
  async function ensure(routeId) {
    const entry = entryOf(routeId)
    if (entry) return entry
    const next = { active: 1, accounts: [1], labels: {} }
    const current = await read(activeKey(routeId))
    if (current?.kind === 'grant') await write(slotKey(routeId, 1), current)
    await put(routeId, next)
    return next
  }

  return {
    syncActive,
    async syncAll() { for (const routeId of Object.keys(get())) await syncActive(routeId) },

    /** 画面用: 各アカウントの番号・名前・使用中か・ログイン記録があるか(値は返さない)。 */
    async describe(routeId) {
      const entry = entryOf(routeId)
      const activeRecord = await read(activeKey(routeId))
      if (!entry) return { routeId, active: 1, accounts: [{ n: 1, label: null, active: true, signedIn: activeRecord?.kind === 'grant' }] }
      const accounts = []
      for (const n of entry.accounts) {
        const signedIn = n === entry.active ? activeRecord?.kind === 'grant' : (await read(slotKey(routeId, n)))?.kind === 'grant'
        accounts.push({ n, label: entry.labels[n] ?? null, active: n === entry.active, signedIn })
      }
      return { routeId, active: entry.active, accounts }
    },

    /** アカウントを足して、それを使用中にする(ログインは画面から行う)。今のログインは保管する。 */
    async add(routeId) {
      const entry = await ensure(routeId)
      await syncActive(routeId)
      const n = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(value => !entry.accounts.includes(value))
      if (!n) throw new TypeError('アカウントは 9 個までです')
      await write(activeKey(routeId), undefined)
      await put(routeId, { ...entry, active: n, accounts: [...entry.accounts, n].sort((a, b) => a - b) })
      return n
    },

    /** 使用中のアカウントを切り替える。今のログインを保管してから、切り替え先のログインを使用中に入れる。 */
    async switchTo(routeId, n) {
      const entry = await ensure(routeId)
      if (!entry.accounts.includes(n)) throw new TypeError('そのアカウントはありません')
      if (entry.active === n) return false
      await syncActive(routeId)
      await write(activeKey(routeId), await read(slotKey(routeId, n)))
      await put(routeId, { ...entry, active: n })
      return true
    },

    /** アカウントを外す(保管したログインも消す)。使用中なら、ほかのアカウントへ切り替える。 */
    async remove(routeId, n) {
      const entry = entryOf(routeId)
      if (!entry?.accounts.includes(n)) throw new TypeError('そのアカウントはありません')
      const rest = entry.accounts.filter(value => value !== n)
      if (entry.active === n) {
        const next = rest[0]
        await write(activeKey(routeId), next === undefined ? undefined : await read(slotKey(routeId, next)))
        if (next !== undefined) await put(routeId, { ...entry, active: next, accounts: rest, labels: Object.fromEntries(Object.entries(entry.labels).filter(([key]) => Number(key) !== n)) })
      } else await put(routeId, { ...entry, accounts: rest, labels: Object.fromEntries(Object.entries(entry.labels).filter(([key]) => Number(key) !== n)) })
      await write(slotKey(routeId, n), undefined)
      if (!rest.length) await put(routeId, undefined)
    },

    async rename(routeId, n, label) {
      const entry = await ensure(routeId)
      if (!entry.accounts.includes(n)) throw new TypeError('そのアカウントはありません')
      const labels = { ...entry.labels }
      if (typeof label === 'string' && label.trim()) labels[n] = label.trim().slice(0, 40); else delete labels[n]
      await put(routeId, { ...entry, labels })
    },

    /** 代替チェーン用: 使用中以外で、ログイン記録のあるアカウント番号(使用中の次から順に)。 */
    async others(routeId) {
      const entry = entryOf(routeId)
      if (!entry) return []
      const start = entry.accounts.indexOf(entry.active)
      const ordered = [...entry.accounts.slice(start + 1), ...entry.accounts.slice(0, start)]
      const result = []
      for (const n of ordered) if ((await read(slotKey(routeId, n)))?.kind === 'grant') result.push(n)
      return result
    },
  }
}
