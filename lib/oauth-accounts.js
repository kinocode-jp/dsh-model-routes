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
 * @param deps.isLoginActive (routeId) => 認証サービスが使用中キーへの書き込みを終えていないか
 */
export function createOauthAccounts({ credentials, get, save, isLoginActive = () => false }) {
  const routes = new Map()
  const unsafe = new Map()
  let saving = Promise.resolve()
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const store = () => {
    const service = credentials()
    if (!service || typeof service.readRecord !== 'function' || typeof service.modifyRecord !== 'function') throw new Error('DSH の資格情報サービスに接続できません')
    return service
  }
  // Never turn a read failure into an absent record: that would make a switch delete credentials.
  const read = key => store().readRecord(key)
  const write = async (key, record) => {
    const service = store()
    if (record !== undefined && record !== null) await service.modifyRecord(key, async () => record)
    else {
      if (typeof service.deleteRecord !== 'function') throw new Error('DSH の資格情報サービスは記録を削除できません')
      await service.deleteRecord(key)
    }
  }
  const entryOf = routeId => get()[routeId]
  const requireIdleLogin = routeId => {
    if (isLoginActive(routeId)) throw new Error('ログインの処理が終わるまで、アカウントを変更できません')
  }
  function serial(routeId, run) {
    const previous = routes.get(routeId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => {
      if (unsafe.has(routeId)) throw unsafe.get(routeId)
      return run()
    })
    routes.set(routeId, task)
    // Handle the cleanup promise too; a rejected operation must not poison the queue.
    task.then(() => { if (routes.get(routeId) === task) routes.delete(routeId) },
      () => { if (routes.get(routeId) === task) routes.delete(routeId) })
    return task
  }
  const replace = (all, routeId, entry) => {
    const next = { ...all }
    if (entry) next[routeId] = entry; else delete next[routeId]
    return next
  }
  function put(routeId, entry) {
    const task = saving.catch(() => {}).then(async () => {
      // Read inside the shared save lock, not before another route's asynchronous save.
      const before = entryOf(routeId)
      try { await save(replace(get(), routeId, entry)) }
      catch (error) {
        // save may publish in-memory metadata before its disk write rejects.
        try { await save(replace(get(), routeId, before)) }
        catch (rollback) {
          const failure = new AggregateError([error, rollback], 'OAuth 設定の復元に失敗しました。再接続前に保存状態を確認してください')
          unsafe.set(routeId, failure)
          throw failure
        }
        throw error
      }
    })
    saving = task
    return task
  }
  function transaction(routeId, run) {
    return serial(routeId, async () => {
      let entry = entryOf(routeId)
      const original = entry
      const journal = new Map()
      const tx = {
        get entry() { return entry },
        set entry(value) { entry = value },
        read,
        async write(key, record) {
          // Snapshot before any attempted mutation, including a write that mutates then rejects.
          if (!journal.has(key)) journal.set(key, await read(key))
          await write(key, record)
        },
      }
      try {
        const result = await run(tx)
        if (!equal(original, entry)) await put(routeId, entry)
        return result
      } catch (error) {
        const failures = []
        for (const [key, record] of [...journal].reverse()) {
          try { await write(key, record) } catch (rollback) { failures.push(rollback) }
        }
        if (failures.length) {
          const failure = new AggregateError([error, ...failures], 'OAuth 記録の復元に失敗しました。再接続前に保存状態を確認してください')
          unsafe.set(routeId, failure)
          throw failure
        }
        throw error
      }
    })
  }
  async function sync(routeId, tx) {
    if (!tx.entry) return
    const current = await read(activeKey(routeId))
    if (current?.kind !== 'grant') return
    const key = slotKey(routeId, tx.entry.active)
    if (!equal(await read(key), current)) await tx.write(key, current)
  }
  async function ensure(routeId, tx) {
    if (tx.entry) return tx.entry
    tx.entry = { active: 1, accounts: [1], labels: {} }
    await sync(routeId, tx)
    return tx.entry
  }
  // Credential notifications start listeners synchronously, but do not await their promises.
  // Enqueue sync (never call the public queued API from inside a transaction): it reads the
  // active number only after commit/rollback, so a B write cannot be copied into A's slot.
  const syncActive = routeId => transaction(routeId, tx => sync(routeId, tx))
  return {
    // Share only login initiation with account mutations; never hold this queue while
    // authorization waits for the user (its record notifications must remain runnable).
    withRoute: (routeId, run) => serial(routeId, run),
    syncActive,
    async syncAll() { await Promise.all(Object.keys(get()).map(syncActive)) },

    /** 画面用。切り替え途中の記録と設定を混ぜない。 */
    describe(routeId) { return serial(routeId, async () => {
      const entry = entryOf(routeId)
      const activeRecord = await read(activeKey(routeId))
      if (!entry) return { routeId, active: 1, accounts: [{ n: 1, label: null, active: true, signedIn: activeRecord?.kind === 'grant' }] }
      const accounts = []
      for (const n of entry.accounts) {
        const signedIn = n === entry.active ? activeRecord?.kind === 'grant' : (await read(slotKey(routeId, n)))?.kind === 'grant'
        accounts.push({ n, label: entry.labels[n] ?? null, active: n === entry.active, signedIn })
      }
      return { routeId, active: entry.active, accounts }
    }) },

    add(routeId) { return transaction(routeId, async tx => {
      requireIdleLogin(routeId)
      const entry = await ensure(routeId, tx)
      await sync(routeId, tx)
      const n = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(value => !entry.accounts.includes(value))
      if (!n) throw new TypeError('アカウントは 9 個までです')
      await tx.write(activeKey(routeId), undefined)
      tx.entry = { ...entry, active: n, accounts: [...entry.accounts, n].sort((a, b) => a - b) }
      return n
    }) },

    switchTo(routeId, n) { return transaction(routeId, async tx => {
      requireIdleLogin(routeId)
      const entry = await ensure(routeId, tx)
      if (!entry.accounts.includes(n)) throw new TypeError('そのアカウントはありません')
      if (entry.active === n) return false
      await sync(routeId, tx)
      await tx.write(activeKey(routeId), await read(slotKey(routeId, n)))
      tx.entry = { ...entry, active: n }
      return true
    }) },

    remove(routeId, n) { return transaction(routeId, async tx => {
      requireIdleLogin(routeId)
      const entry = tx.entry
      if (!entry?.accounts.includes(n)) throw new TypeError('そのアカウントはありません')
      const rest = entry.accounts.filter(value => value !== n)
      if (entry.active === n) await tx.write(activeKey(routeId), rest.length ? await read(slotKey(routeId, rest[0])) : undefined)
      await tx.write(slotKey(routeId, n), undefined)
      tx.entry = rest.length ? { ...entry, active: entry.active === n ? rest[0] : entry.active, accounts: rest, labels: Object.fromEntries(Object.entries(entry.labels).filter(([key]) => Number(key) !== n)) } : undefined
    }) },

    rename(routeId, n, label) { return transaction(routeId, async tx => {
      if (!tx.entry) requireIdleLogin(routeId)
      const entry = await ensure(routeId, tx)
      if (!entry.accounts.includes(n)) throw new TypeError('そのアカウントはありません')
      const labels = { ...entry.labels }
      if (typeof label === 'string' && label.trim()) labels[n] = label.trim().slice(0, 40); else delete labels[n]
      tx.entry = { ...entry, labels }
    }) },

    /** 代替チェーン用: 使用中の次から順に、ログイン済みの番号を返す。 */
    others(routeId) { return serial(routeId, async () => {
      const entry = entryOf(routeId)
      if (!entry) return []
      const start = entry.accounts.indexOf(entry.active)
      const ordered = [...entry.accounts.slice(start + 1), ...entry.accounts.slice(0, start)]
      const result = []
      for (const n of ordered) if ((await read(slotKey(routeId, n)))?.kind === 'grant') result.push(n)
      return result
    }) },
  }
}
