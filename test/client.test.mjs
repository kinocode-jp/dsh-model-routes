import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROVIDER_PRESETS } from '../lib/index.js'

// ── 簡易な偽の React。要素を {type, props, children} にし、関数コンポーネントは render() で展開する ──
const effects = []
let refImpl = () => ({ current: null })
let stateImpl = initial => [initial, () => {}]
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: initial => stateImpl(initial),
  useEffect: fn => { effects.push(fn) },
  useRef: (...args) => refImpl(...args),
}
function load(windowExtra = {}, primitives) {
  let loaded
  const window = { __ModuleLoader__: { load: m => { loaded = m } }, ...windowExtra }
  new Function('window', 'setInterval', 'clearInterval', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window, () => 0, () => {})
  return { loaded, mod: loaded.factory(name => (name === 'react' ? fakeReact : primitives ?? (() => { throw new Error('no primitives') })())), window }
}
// 関数コンポーネントを展開した、平らな要素の一覧。
function render(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(n => render(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push({ text: String(node) }); return out }
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }), out)
  out.push(node)
  node.children.forEach(child => render(child, out))
  return out
}
const textOf = nodes => nodes.map(n => n.text ?? '').join(' ')
const buttons = nodes => nodes.filter(n => n.type === 'button')
const hasClass = (n, name) => String(n?.props?.className || '').split(' ').includes(name)
const labelOf = n => n.children.map(c => (typeof c === 'string' ? c : c.text ?? '')).join('')
const findButton = (nodes, label) => buttons(nodes).find(n => labelOf(n) === label)
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const ok = value => ({ ok: true, value })
const stateOf = (routes, attempt = null) => ({ routes, attempt })
const modelGroup = (over = {}) => ({ providerId: 'claude', kind: 'api', routeId: 'anthropic-api', service: 'Claude', label: 'Claude', lastLocked: false, models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', visible: true, default: true }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', visible: false, default: true }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', visible: true, default: false }], ...over })
const route = (over = {}) => ({ providerId: 'claude', routeId: 'anthropic', label: 'Claude', registered: false, credentialType: null, canLogin: true, ...over })

// DSH の locale サービスの代役。辞書の登録・bind・購読・現在の言語を持つ。
function fakeLocale(active = 'ja') {
  const dicts = new Map(), listeners = new Set()
  const service = {
    active, registered: [],
    register(ns, lang, dict) { dicts.set(ns + '/' + lang, dict); service.registered.push([ns, lang]); return () => { dicts.delete(ns + '/' + lang) } },
    bind: ns => (key, params) => {
      const template = dicts.get(ns + '/' + service.active)?.[key] ?? dicts.get(ns + '/en')?.[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : template
    },
    getSnapshot: () => ({ active: service.active }),
    subscribe(fn) { listeners.add(fn); service.subscribed = listeners.size; return () => { listeners.delete(fn); service.subscribed = listeners.size } },
    subscribed: 0,
    setActive(lang) { service.active = lang; for (const fn of [...listeners]) fn() },
  }
  return service
}
// ロケール付きで読み込む(辞書も登録する)。
async function loadWith(lang = 'ja', windowExtra, primitives) {
  const env = load(windowExtra, primitives)
  const locale = fakeLocale(lang)
  await env.mod.apply({ locale })
  return { ...env, locale }
}

// ───────── 登録 ─────────
test('モデル設定画面のカードに登録する(説明パネルの設定セクションは作らない)', async () => {
  const { loaded, mod } = load()
  const calls = []
  const slots = {
    register: (opts, component) => {
      // Match the real slot registry: footer is a list seat, not a keyed seat.
      if (opts.name === 'settings.models.footer' && (typeof opts.id !== 'string' || !opts.id.trim())) {
        throw new Error('list slot "settings.models.footer" requires options.id')
      }
      calls.push({ opts, component })
    },
    inject: (target, fn) => { fn(); return () => {} },
  }
  await mod.apply({ slots, locale: fakeLocale('en') })
  assert.equal(loaded.id, '@kinocode/dsh-model-routes')
  const sections = calls.filter(c => c.opts.name === 'settings.section')
  assert.deepEqual(sections.map(c => [c.opts.id, c.opts.order, c.opts.label()]), [['model-routes', 11, 'Model routes']], '設定に「モデルルート」ページを1つだけ足す(「モデル」のすぐ下)')
  assert.equal(sections[0].component, mod.__test.ModelRoutesPage)
  const cards = calls.filter(c => c.opts.name === 'settings.models.provider-card')
  assert.deepEqual(cards.map(c => c.opts.key), ['llm-pi-ai', 'llm-deepseek'], 'pi-ai のカード全てと、DSH 標準の DeepSeek のカードに届くキー')
  for (const card of cards) assert.equal(card.component, mod.__test.ProviderCardExtension)
  const footer = calls.filter(c => c.opts.name === 'settings.models.footer')
  assert.deepEqual(footer.map(c => c.opts), [{ name: 'settings.models.footer', id: 'model-routes-disabled' }, { name: 'settings.models.footer', id: 'model-routes-agy' }])
  assert.equal(footer[0].component, mod.__test.DisabledRoutesCards)
  assert.equal(footer[1].component, mod.__test.AgyCard)
  assert.equal(calls.length, 5)
})

test('辞書を ja / en / zh の3言語で locale サービスへ登録する', async () => {
  const { locale } = await loadWith('ja')
  assert.deepEqual(locale.registered.map(([ns, lang]) => lang).sort(), ['en', 'ja', 'zh'])
  assert.ok(locale.registered.every(([ns]) => ns === 'model-routes'))
})

// ───────── ローカライズ ─────────
test('3言語の辞書は、同じキーと同じ置換語を持ち、空欄がない', () => {
  const { mod } = load()
  const { DICT } = mod.__test
  const keys = lang => Object.keys(DICT[lang]).sort()
  assert.deepEqual(keys('en'), keys('ja'))
  assert.deepEqual(keys('zh'), keys('ja'))
  const params = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
  for (const key of keys('ja')) {
    for (const lang of ['ja', 'en', 'zh']) assert.ok(DICT[lang][key].trim().length > 0, lang + ' ' + key)
    assert.deepEqual(params(DICT.en[key]), params(DICT.ja[key]), key)
    assert.deepEqual(params(DICT.zh[key]), params(DICT.ja[key]), key)
  }
})

test('言語を切り替えると、画面の文言も切り替わる', async () => {
  const { mod, locale } = await loadWith('ja')
  const { SubscriptionSection, authStore } = mod.__test
  authStore.state = stateOf([route()]); authStore.error = null
  const read = () => textOf(render(SubscriptionSection({ routeId: 'anthropic' })))
  assert.match(read(), /Claude \(OAuth\)/)
  assert.match(read(), /未ログイン/)
  locale.setActive('en')
  assert.match(read(), /Claude \(OAuth\)/)
  assert.match(read(), /Not signed in/)
  locale.setActive('zh')
  assert.match(read(), /Claude \(OAuth\)/)
  assert.match(read(), /未登录/)
})

test('locale サービスが無いときは、ブラウザの言語から選ぶ(日本語・英語・中国語)', () => {
  const { mod } = load()
  const { fallbackT, DICT } = mod.__test
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    for (const [language, lang] of [['ja-JP', 'ja'], ['zh-CN', 'zh'], ['en-US', 'en'], ['fr-FR', 'en']]) {
      Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true })
      assert.equal(fallbackT('btn.login'), DICT[lang]['btn.login'], language)
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator
  }
})

test('表示名の方針: 画面の文言も OAuth で統一し、「サブスク」の語を主要な表示に使わない', () => {
  const { mod } = load()
  const { DICT } = mod.__test
  for (const lang of ['ja', 'en', 'zh']) {
    assert.equal(DICT[lang]['sub.title'], '{name} (OAuth)', lang)
    assert.equal(DICT[lang]['badge.subscription'], 'OAuth', lang)
    assert.equal(DICT[lang]['badge.api'], 'API', lang)
  }
  for (const key of ['btn.login', 'sub.loggedIn', 'sub.notLoggedIn', 'btn.reloginFromKey', 'sub.apiKeyStored']) assert.ok(!/サブスク/.test(DICT.ja[key]), key)
})

// ───────── バッジ ─────────
test('バッジの対象プロバイダが、カタログのサブスク枠/API枠と一致する', () => {
  const { mod } = load()
  const sub = [], api = []
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    if (preset.subscription) sub.push(preset.subscription.provider)
    if (preset.api) api.push(preset.api.provider)
  }
  assert.deepEqual([...mod.__test.BADGES.subscription.ids].sort(), sub.sort())
  assert.deepEqual([...mod.__test.BADGES.api.ids].sort(), api.sort())
  for (const id of mod.__test.BADGES.subscription.ids) assert.ok(!mod.__test.BADGES.api.ids.includes(id), id)
})

test('バッジのCSSは公式フックだけを対象にし、文言は現在の言語になる', async () => {
  const { mod, locale } = await loadWith('ja')
  const css = mod.__test.badgeCss()
  assert.match(css, /span\[data-provider-id="anthropic"\]\[data-model-id\]::after/)
  assert.match(css, /span\[data-provider-id="anthropic-api"\]\[data-model-id\]::after/)
  assert.match(css, /span\[data-provider-id\$="-api"\]\[data-model-id\]::after/)
  assert.match(css, /content:"OAuth"/)
  assert.match(css, /content:"API"/)
  assert.match(css, /span\[data-provider-id\*="-api-"\]\[data-model-id\]::after/, '追加アカウント(anthropic-api-2 など)も API')
  assert.ok(!css.includes('data-provider-id^='))
  // 翻訳関数を差し替えると、バッジの文言も変わる(言語ごとに辞書を持つ)
  assert.match(mod.__test.badgeCss(key => ({ 'badge.subscription': 'X1', 'badge.api': 'X2' })[key]), /content:"X1"[\s\S]*content:"X2"/)
})

test('スタイル: 1つの style にまとめ、言語が変わると文言を入れ替え、外すと消える', async () => {
  const { mod, locale } = await loadWith('ja')
  const nodes = new Map()
  const doc = { head: { appendChild: n => nodes.set(n.id, n) }, getElementById: id => nodes.get(id) ? Object.assign(nodes.get(id), { remove: () => nodes.delete(id) }) : null, createElement: () => ({ dataset: {} }) }
  globalThis.document = doc
  try {
    const off = mod.__test.installStyles()
    assert.equal(nodes.size, 1)
    const tag = [...nodes.values()][0]
    assert.match(tag.textContent, /\.mr-sub\{/)
    assert.match(tag.textContent, /content:"OAuth"/)
    assert.equal(locale.subscribed, 1, '言語の切り替えに追従する')
    mod.__test.installStyles()
    assert.equal(nodes.size, 1, '二重に入れない')
    off()
    assert.equal(nodes.size, 0)
  } finally { delete globalThis.document }
})

// ───────── デザイン ─────────
test('デザイン: DSH のデザイントークンを使い、直書きの色・インラインstyleを使わない', () => {
  const { mod } = load()
  const css = mod.__test.baseCss()
  assert.match(css, /var\(--dsw-alias-button-primary-fill\)/)
  assert.match(css, /var\(--dsw-alias-bg-module-platform\)/)
  assert.match(css, /var\(--dsw-alias-border-l3\)/)
  assert.match(css, /var\(--dsw-radius-md\)/)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), '色を直書きしない(ダーク/ライトに追従するため)')
})

test('デザイン: 画面で使うクラスは、すべてスタイルに定義されている', async () => {
  const { mod } = await loadWith('ja')
  const { SubscriptionSection, ModelToggles, authStore, modelsStore, baseCss } = mod.__test
  const css = baseCss()
  const used = new Set()
  const collect = nodes => nodes.forEach(n => { if (n.props?.className) n.props.className.split(' ').forEach(c => used.add(c)); if (n.props && 'style' in n.props) assert.fail('インライン style は使わない: ' + n.type) })
  const attempts = [
    { id: 'a', routeId: 'anthropic', label: 'Claude', phase: 'prompt', notices: [{ message: 'm', url: 'https://x.example/a', code: 'ABCD' }], prompt: { id: 'p1', kind: 'text', message: 'm', placeholder: 'ph' }, error: null },
    { id: 'a', routeId: 'anthropic', label: 'Claude', phase: 'prompt', notices: [], prompt: { id: 'p2', kind: 'select', message: 'm', options: [{ id: 'browser', label: 'B' }, { id: 'copy_code', label: 'C' }] }, error: null },
    { id: 'a', routeId: 'anthropic', label: 'Claude', phase: 'error', notices: [], prompt: null, error: 'x' },
    { id: 'a', routeId: 'anthropic', label: 'Claude', phase: 'done', notices: [], prompt: null, error: null },
    { id: 'a', routeId: 'anthropic', label: 'Claude', phase: 'cancelled', notices: [], prompt: null, error: null },
  ]
  for (const attempt of attempts) { authStore.state = stateOf([route()], attempt); collect(render(SubscriptionSection({ routeId: 'anthropic' }))) }
  for (const r of [route(), route({ registered: true, credentialType: 'oauth' }), route({ registered: true, credentialType: 'api_key' }), route({ canLogin: false })]) { authStore.state = stateOf([r]); collect(render(SubscriptionSection({ routeId: 'anthropic' }))) }
  authStore.state = null; authStore.error = 'x'; collect(render(SubscriptionSection({ routeId: 'anthropic' })))
  for (const state of [null, { groups: [modelGroup()] }, { groups: [modelGroup({ models: [] })] }, { groups: [modelGroup({ lastLocked: true, models: [{ id: 'a', name: 'A', visible: true, default: true }] })] }]) {
    modelsStore.state = state; modelsStore.error = state ? null : 'x'
    collect(render(ModelToggles({ routeId: 'anthropic-api', kind: 'api' })))
  }
  modelsStore.state = { groups: [modelGroup({ models: [{ id: 'a', name: 'A', visible: false, default: true }] })] }; modelsStore.error = null
  collect(render(ModelToggles({ routeId: 'anthropic-api' })))
  assert.ok(used.size > 20)
  for (const name of used) assert.ok(css.includes('.' + name), '未定義のクラス: ' + name)
})

// ───────── カード ─────────
test('カード: OAuth 枠の行は SubscriptionRow に任せ、それ以外は状態行と、編集中だけ表示する枠(WhenEditing)に入れる', () => {
  const { mod } = load()
  const { ProviderCardExtension, SubscriptionSection, SubscriptionRow, CardStatus, WhenEditing, ModelToggles } = mod.__test
  const card = routeId => ProviderCardExtension({ provider: { provider: routeId }, keyConfigured: false })
  for (const id of ['anthropic', 'openai-codex', 'xai']) assert.equal(card(id).type, SubscriptionRow, id)
  assert.equal(card(undefined), null)
  // API 枠 + 対になる OAuth 枠: 状態行(API と OAuth) + API のモデル + OAuth 欄
  for (const [api, oauth] of [['anthropic-api', 'anthropic'], ['openai-api', 'openai-codex'], ['xai-api', 'xai']]) {
    const status = card(api).children.find(n => n?.type === CardStatus)
    assert.deepEqual([status.props.apiRouteId, status.props.oauthRouteId, status.props.keyConfigured], [api, oauth, false], api)
    const gate = card(api).children.find(n => n?.type === WhenEditing)
    assert.ok(gate, api)
    const nodes = gate.children.flatMap(function flat(n) { return [n, ...(n?.children || []).flatMap(flat)] })
    const toggles = nodes.filter(n => n?.type === ModelToggles)
    assert.equal(toggles.length, 1)
    assert.deepEqual([toggles[0].props.routeId, toggles[0].props.kind], [api, 'api'])
    const section = nodes.find(n => n?.type === SubscriptionSection)
    assert.equal(section.props.routeId, oauth, api)
  }
  // API だけのサービス・カスタム枠: モデルのトグルだけ(OAuth 欄なし)
  for (const id of ['google-api', 'opencode', 'commandcode-api', 'my-local']) {
    const nodes = card(id).children.flatMap(function flat(n) { return [n, ...(n?.children || []).flatMap(flat)] })
    // 状態行は全部に出す。カスタム枠はキー不要のものがあるため、キーの状態を出さずスイッチだけ(keyless)。
    const status = nodes.filter(n => n?.type === CardStatus)
    assert.equal(status.length, 1, id)
    assert.equal(status[0].props.keyless === true, id === 'my-local', id)
    assert.equal(nodes.filter(n => n?.type === ModelToggles).length, 1, id)
    assert.equal(nodes.filter(n => n?.type === SubscriptionSection).length, 0, id)
    assert.equal(nodes.find(n => n?.type === ModelToggles).props.kind, undefined, '種別の表示は不要')
  }
})

test('編集ゲート: 編集を開いているときだけ中身を出し、閉じると消す', () => {
  const { mod } = load()
  const { WhenEditing } = mod.__test
  const show = open => {
    const saved = stateImpl; stateImpl = () => [open, () => {}]
    try { return render(WhenEditing({ children: { type: 'span', props: { id: 'inner' }, children: [] } })) } finally { stateImpl = saved }
  }
  const closed = show(false)[0]
  assert.equal(closed.props.hidden, true, '閉じている間は表示しない')
  assert.equal(closed.props['data-mr-gate'], 'closed')
  assert.ok(!show(false).some(n => n.props?.id === 'inner'))
  const opened = show(true)
  assert.equal(opened[0].props.hidden, false)
  assert.ok(opened.some(n => n.props?.id === 'inner'), '編集を開いたら出す')
})

test('編集ゲート: カードの中の API キー入力欄(編集画面)の有無で開閉を判定し、DOM の変化に追従する', () => {
  const { mod } = load()
  const { WhenEditing } = mod.__test
  const states = []
  const saved = stateImpl; stateImpl = initial => [initial, value => states.push(value)]
  let observer
  const prevObserver = globalThis.MutationObserver
  globalThis.MutationObserver = class { constructor(fn) { observer = { fn, observed: null, disconnected: false }; this.o = observer } observe(node, options) { this.o.observed = [node, options] } disconnect() { this.o.disconnected = true } }
  try {
    let hasInput = false
    const row = { querySelector: selector => (selector === 'input[autocomplete="new-password"]' && hasInput ? {} : null) }
    refImpl = () => ({ current: { closest: tag => (tag === 'li' ? row : null) } })
    effects.length = 0
    WhenEditing({ children: null })
    const cleanup = effects.map(fn => fn()).find(Boolean)
    assert.deepEqual(states, [false], '最初は閉じている')
    assert.deepEqual(observer.observed[1], { childList: true, subtree: true })
    hasInput = true; observer.fn()
    assert.equal(states.at(-1), true, '編集を開いた(入力欄が現れた)')
    hasInput = false; observer.fn()
    assert.equal(states.at(-1), false, '閉じた')
    cleanup()
    assert.equal(observer.disconnected, true)
  } finally { stateImpl = saved; refImpl = () => ({ current: null }); if (prevObserver) globalThis.MutationObserver = prevObserver; else delete globalThis.MutationObserver }
})

test('カードの対応が、カタログのサブスク枠とAPI枠の組と一致する', () => {
  const { mod } = load()
  const pairs = {}
  for (const preset of Object.values(PROVIDER_PRESETS)) if (preset.subscription && preset.api) pairs[preset.api.provider] = preset.subscription.provider
  assert.deepEqual(mod.__test.SUBSCRIPTION_OF_API, pairs)
})

test('内部通信の定義が、ホストの Typert 定義と一致する', async () => {
  const { mod } = load()
  const { TYPERT } = await import('../lib/typert.host.js')
  const client = mod.__test.CONTRIBUTION
  assert.equal(client.package, TYPERT.package)
  assert.equal(client.face, 'host')
  assert.deepEqual(client.descriptors.map(d => [d.id, d.service, d.method, d.parameters.map(p => p.name)]), TYPERT.invocations.map(d => [d.id, d.service, d.method, d.parameters.map(p => p.name)]))
  for (const [i, d] of client.descriptors.entries()) {
    assert.deepEqual(d.parameters.map(p => p.codec.typeSymbol), TYPERT.invocations[i].parameters.map(p => p.codec.typeSymbol))
    assert.equal(d.result.typeSymbol, TYPERT.invocations[i].result.typeSymbol)
  }
})

// ───────── サブスク欄 ─────────
async function sectionWith(state, { error = null, busy = false, windowExtra, lang = 'ja' } = {}) {
  const { mod, window, locale } = await loadWith(lang, windowExtra)
  const { authStore, SubscriptionSection } = mod.__test
  const calls = []
  authStore.service = new Proxy({}, { get: (_, method) => async (...args) => { calls.push([method, ...args]); return ok(state) } })
  authStore.state = state; authStore.error = error; authStore.busy = busy
  return { mod, window, locale, calls, authStore, nodes: render(SubscriptionSection({ routeId: 'anthropic' })) }
}

test('OAuth 欄: 未ログインなら「ログイン」(主ボタン)を押せる', async () => {
  const { nodes, calls, authStore } = await sectionWith(stateOf([route()]))
  assert.match(textOf(nodes), /Claude \(OAuth\)/)
  assert.match(textOf(nodes), /未ログイン/)
  const login = findButton(nodes, 'ログイン')
  assert.match(login.props.className, /mr-btn-primary/)
  login.props.onClick()
  await flush()
  assert.deepEqual(calls[0], ['startLogin', 'anthropic'])
  assert.deepEqual(calls[1], ['getAuthState'], '操作のあとに状態を読み直す')
  assert.equal(authStore.busy, false)
})

test('サブスク欄: ログイン済みは状態を示し、ログアウトは確認してから削除する', async () => {
  const confirms = []
  const { nodes, calls } = await sectionWith(stateOf([route({ registered: true, credentialType: 'oauth' })]), { windowExtra: { confirm: message => { confirms.push(message); return true } } })
  assert.match(textOf(nodes), /ログイン済み/)
  assert.ok(findButton(nodes, '再ログイン'))
  const logout = findButton(nodes, 'ログアウト')
  assert.match(logout.props.className, /mr-btn-danger/)
  logout.props.onClick()
  await flush()
  assert.deepEqual(confirms, ['Claude (OAuth) のログインを削除しますか?'])
  assert.deepEqual(calls[0], ['logout', 'anthropic'])
})

test('サブスク欄: 確認で断ると削除しない', async () => {
  const { nodes, calls } = await sectionWith(stateOf([route({ registered: true, credentialType: 'oauth' })]), { windowExtra: { confirm: () => false } })
  findButton(nodes, 'ログアウト').props.onClick()
  await flush()
  assert.deepEqual(calls, [])
})

test('サブスク欄: API キーが保存されているルートは、サブスクではないと警告する', async () => {
  const { nodes } = await sectionWith(stateOf([route({ registered: true, credentialType: 'api_key' })]))
  assert.match(textOf(nodes), /API キーが保存されています/)
  assert.ok(findButton(nodes, 'OAuth でログインし直す'))
  assert.match(textOf(nodes), /OAuth ではありません/)
  assert.ok(!/ログイン済み \(サブスク\)/.test(textOf(nodes)))
})

test('サブスク欄: ログイン方法の選択は id を返す(表示名ではない)', async () => {
  const attempt = { id: 'a1', routeId: 'anthropic', label: 'Claude', phase: 'prompt', notices: [], error: null,
    prompt: { id: 'p1', kind: 'select', message: 'Select Anthropic login method:', options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'copy_code', label: 'Copy code login (headless)' }] } }
  const { nodes, calls } = await sectionWith(stateOf([route()], attempt))
  const browser = findButton(nodes, 'ブラウザでログイン（推奨）')
  const copy = findButton(nodes, 'コードをコピーしてログイン（ブラウザが別のマシンのとき）')
  assert.ok(browser && copy, 'pi-ai の英語の表示名ではなく、翻訳した文言を出す')
  assert.match(browser.props.className, /mr-btn-primary/, '先頭(既定)が主ボタン')
  assert.ok(!nodes.some(n => n.type === 'a'), '選択中は認証リンクを出さない')
  browser.props.onClick()
  await flush()
  assert.deepEqual(calls[0], ['answerPrompt', 'p1', 'browser'], '「Unknown Anthropic login method」になっていた不具合')
  copy.props.onClick()
  await flush()
  assert.deepEqual(calls[2], ['answerPrompt', 'p1', 'copy_code'])
})

test('サブスク欄: 未知の選択肢は pi-ai の表示名を使う', async () => {
  const { mod } = await loadWith('ja')
  assert.equal(mod.__test.methodLabel({ id: 'device', label: 'Device code' }, mod.__test.t), 'Device code')
  assert.equal(mod.__test.methodLabel({ id: 'browser', label: 'Browser login (default)' }, mod.__test.t), 'ブラウザでログイン（推奨）')
})

test('サブスク欄: ログイン中は認証ページのリンクとコード入力を出し、取り消せる', async () => {
  const attempt = { id: 'a1', routeId: 'anthropic', label: 'Claude', phase: 'prompt', notices: [{ message: 'Complete login in your browser.', url: 'https://claude.ai/oauth/authorize?x=1' }], prompt: { id: 'p1', kind: 'text', message: 'Complete login in your browser, or paste the authorization code', placeholder: 'http://localhost:53692/callback' }, error: null }
  const { nodes, calls } = await sectionWith(stateOf([route()], attempt))
  const link = nodes.find(n => n.type === 'a')
  assert.equal(link.props.href, 'https://claude.ai/oauth/authorize?x=1')
  assert.equal(link.props.rel, 'noopener noreferrer')
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.className, 'mr-link')
  const input = nodes.find(n => n.type === 'input')
  assert.equal(input.props.placeholder, 'http://localhost:53692/callback')
  assert.equal(input.props['aria-label'], 'コードまたはリダイレクト URL')
  assert.equal(findButton(nodes, '送信').props.disabled, true, '空欄のままは送信できない')
  assert.ok(!/Complete login/.test(textOf(nodes)), 'pi-ai の英語の案内文をそのまま出さない')
  assert.match(textOf(nodes), /表示されたコードを入力してください/)
  findButton(nodes, '取り消し').props.onClick()
  await flush()
  assert.deepEqual(calls[0], ['cancelLogin'])
})

test('サブスク欄: デバイスコード方式では、コードを大きく表示する', async () => {
  const attempt = { id: 'a1', routeId: 'anthropic', label: 'Claude', phase: 'running', notices: [{ message: 'Enter this code', url: 'https://example.com/device', code: 'ABCD-1234' }], prompt: null, error: null }
  const { nodes } = await sectionWith(stateOf([route()], attempt))
  const value = nodes.find(n => n.props?.className === 'mr-code-value')
  assert.equal(labelOf(value), 'ABCD-1234')
  assert.match(textOf(nodes), /認証コード/)
  assert.match(textOf(nodes), /ブラウザでの認証を待っています/)
})

test('サブスク欄: 失敗・完了・取り消しの表示', async () => {
  const base = { id: 'a1', routeId: 'anthropic', label: 'Claude', notices: [], prompt: null }
  let { nodes } = await sectionWith(stateOf([route()], { ...base, phase: 'error', error: 'invalid_grant: bad' }))
  assert.match(textOf(nodes), /ログインに失敗しました: invalid_grant: bad/)
  assert.ok(findButton(nodes, 'もう一度') && findButton(nodes, '閉じる'))
  ;({ nodes } = await sectionWith(stateOf([route({ registered: true, credentialType: 'oauth' })], { ...base, phase: 'done', error: null })))
  assert.match(textOf(nodes), /ログインしました/)
  ;({ nodes } = await sectionWith(stateOf([route()], { ...base, phase: 'cancelled', error: null })))
  assert.match(textOf(nodes), /取り消しました/)
})

test('サブスク欄: 英語・中国語でも同じ操作ができる', async () => {
  for (const [lang, login, cancel] of [['en', 'Sign in', 'Cancel'], ['zh', '登录', '取消']]) {
    const { nodes } = await sectionWith(stateOf([route()]), { lang })
    assert.ok(findButton(nodes, login), lang)
    const active = { id: 'a', routeId: 'anthropic', label: 'Claude', phase: 'running', notices: [], prompt: null, error: null }
    const running = (await sectionWith(stateOf([route()], active), { lang })).nodes
    assert.ok(findButton(running, cancel), lang)
  }
})

test('サブスク欄: 別のサービスのログインは、この欄に出さない', async () => {
  const other = { id: 'a1', routeId: 'xai', label: 'xAI Grok', phase: 'prompt', notices: [], prompt: { id: 'p1', kind: 'text', message: 'm' }, error: null }
  const { nodes } = await sectionWith(stateOf([route(), route({ providerId: 'xai', routeId: 'xai', label: 'xAI Grok' })], other))
  assert.match(textOf(nodes), /未ログイン/)
  assert.ok(!nodes.some(n => n.type === 'input'))
})

test('サブスク欄: 読み込み中・読み込み失敗(再読み込み)・OAuth非対応', async () => {
  const { mod } = await loadWith('ja')
  const { authStore, SubscriptionSection } = mod.__test
  authStore.state = null; authStore.error = null
  assert.match(textOf(render(SubscriptionSection({ routeId: 'anthropic' }))), /読み込み中/)
  authStore.error = '接続できません'
  const failed = render(SubscriptionSection({ routeId: 'anthropic' }))
  assert.match(textOf(failed), /読み込めません: 接続できません/)
  assert.ok(findButton(failed, '再読み込み'))
  authStore.state = stateOf([route({ canLogin: false })]); authStore.error = null
  assert.match(textOf(render(SubscriptionSection({ routeId: 'anthropic' }))), /利用できません/)
})

// ───────── 認証ページを開く ─────────
const withUrl = (id = 'a7') => ({ id, routeId: 'anthropic', label: 'Claude', phase: 'prompt', notices: [{ message: 'x', url: 'https://claude.ai/a' }], prompt: { id: 'p', kind: 'text', message: 'm' }, error: null })

test('ブラウザを開く(Desktop): 認証URLが届いたら一度だけ window.open で開く', async () => {
  const opened = []
  const { mod } = await loadWith('ja', { dshDesktop: {}, open: (...args) => { opened.push(args); return null } })
  const { authStore } = mod.__test
  authStore.service = { getAuthState: async () => ok(stateOf([route()], withUrl())), startLogin: async () => ok(withUrl()) }
  await authStore.startLogin('anthropic')
  await authStore.refresh()
  assert.deepEqual(opened, [['https://claude.ai/a', '_blank', 'noopener,noreferrer']], '空のタブは開かず、URLだけを一度開く')
})

test('ブラウザを開く(ブラウザ版): クリックで空のタブを先に開き、URLが届いたらそのタブへ移動する', async () => {
  const opened = []
  const tab = { closed: false, location: { href: '' }, close() { this.closed = true } }
  const { mod } = await loadWith('ja', { open: (...args) => { opened.push(args); return tab } })
  const { authStore } = mod.__test
  authStore.service = { getAuthState: async () => ok(stateOf([route()], withUrl())), startLogin: async () => ok(withUrl()) }
  await authStore.startLogin('anthropic')
  assert.deepEqual(opened[0], ['', '_blank'], 'クリックの瞬間に空のタブを開く(あとからだと遮断される)')
  assert.equal(tab.location.href, 'https://claude.ai/a')
  assert.equal(opened.length, 1, 'もう1つ開かない')
  assert.equal(authStore.pendingTab, null)
})

test('ブラウザを開く(ブラウザ版): 失敗・取り消しでは、空のタブを閉じる', async () => {
  const tab = { closed: false, location: { href: '' }, close() { this.closed = true } }
  const { mod } = await loadWith('ja', { open: () => tab })
  const { authStore } = mod.__test
  authStore.service = { startLogin: async () => ({ ok: false, error: { message: 'busy' } }), getAuthState: async () => ok(stateOf([route()])) }
  await authStore.startLogin('anthropic')
  assert.equal(tab.closed, true)
  const tab2 = { closed: false, location: { href: '' }, close() { this.closed = true } }
  authStore.pendingTab = tab2
  authStore.service = { cancelLogin: async () => ok({}), getAuthState: async () => ok(stateOf([route()])) }
  await authStore.cancel()
  assert.equal(tab2.closed, true)
})

// ───────── ストア ─────────
test('ストア: 通信が失敗したら error に出し、操作中フラグを戻す', async () => {
  const { mod } = await loadWith('ja')
  const { authStore } = mod.__test
  authStore.service = { startLogin: async () => ({ ok: false, error: { message: '別のログインが進行中です' } }), getAuthState: async () => ok(stateOf([route()])) }
  await authStore.startLogin('anthropic')
  assert.equal(authStore.busy, false)
  assert.equal(authStore.error, null, '再読み込みが成功すれば古い失敗は消える')
  authStore.service = { startLogin: async () => ({ ok: false, error: { message: '別のログインが進行中です' } }), getAuthState: async () => { throw new Error('切断') } }
  await authStore.startLogin('anthropic')
  assert.match(authStore.error, /切断/)
  authStore.bind(null)
  assert.equal(authStore.state, null)
  assert.equal(authStore.error, 'DSH のログインサービスに接続できません', '接続できない旨も現在の言語')
})

test('ストア: 購読者がいる間だけ定期的に読み、全員が外れたら止める', async () => {
  const { mod } = await loadWith('ja')
  const { authStore } = mod.__test
  authStore.service = { getAuthState: async () => ok(stateOf([route()])) }
  const off1 = authStore.subscribe(() => {}), off2 = authStore.subscribe(() => {})
  assert.equal(authStore.subs.size, 2)
  off1(); off2()
  assert.equal(authStore.subs.size, 0)
  assert.equal(authStore.timer, null)
})

test('サブスク行の非表示: 状態を読めたときだけ隠し、外れたら戻す', async () => {
  const { mod } = await loadWith('ja')
  const { authStore, HideRow } = mod.__test
  const li = { style: { display: '' }, attrs: new Set(), setAttribute(name) { this.attrs.add(name) }, removeAttribute(name) { this.attrs.delete(name) } }
  const refHolder = { current: { closest: tag => tag === 'li' ? li : null } }
  const run = state => {
    effects.length = 0
    authStore.state = state
    const origin = refImpl; refImpl = () => refHolder
    try { HideRow() } finally { refImpl = origin }
    return effects.map(effect => effect()).filter(Boolean)
  }
  run(null)
  assert.equal(li.style.display, '', '状態を読めていない: 隠さない(ログインの手段が無くなるため)')
  const cleanups = run(stateOf([route()]))
  assert.equal(li.style.display, 'none')
  assert.ok(li.attrs.has('data-model-routes-hidden'))
  cleanups.forEach(fn => fn())
  assert.equal(li.style.display, '')
  assert.ok(!li.attrs.has('data-model-routes-hidden'))
})

// ───────── 登録の配線 ─────────
test('内部通信に繋がらなくても、バッジとカードは登録される', async () => {
  const { mod } = load()
  const registered = []
  const slots = { register: opts => { registered.push(opts.name) }, inject: (target, fn) => { fn(); return () => {} } }
  const remote = { $mount: async () => { throw new Error('mount failed') } }
  const warn = console.warn; console.warn = () => {}
  try { await mod.apply({ slots, remote, locale: fakeLocale('ja') }) } finally { console.warn = warn }
  assert.deepEqual(registered, ['settings.models.provider-card', 'settings.models.provider-card', 'settings.section', 'settings.models.footer', 'settings.models.footer'])
})

test('内部通信: マウントして modelRoutesAuth と modelRoutesModels に接続し、解除でストアと辞書を外す', async () => {
  const { mod } = load()
  const cleanups = []
  let unmounted = 0
  const service = { getAuthState: async () => ok(stateOf([route()])) }
  const modelsService = { getModels: async () => ok({ groups: [modelGroup()] }) }
  const locale = fakeLocale('ja')
  const ctx = {
    locale,
    slots: { register() {}, inject: (t, fn) => { fn(); return () => {} } },
    remote: { $mount: async contribution => { assert.equal(contribution, mod.__test.CONTRIBUTION); return () => { unmounted++ } } },
    get: name => name === 'remote.modelRoutesAuth' ? service : name === 'remote.modelRoutesModels' ? modelsService : undefined,
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose) },
  }
  await mod.apply(ctx)
  assert.equal(mod.__test.authStore.service, service)
  assert.equal(mod.__test.modelsStore.service, modelsService)
  assert.equal(locale.registered.length, 3)
  cleanups.forEach(fn => fn())
  assert.equal(unmounted, 1)
  assert.equal(mod.__test.authStore.service, null)
  assert.equal(mod.__test.modelsStore.service, null)
})

// ───────── モデルの表示トグル ─────────
async function togglesWith(group, { error = null, primitives, lang = 'ja' } = {}) {
  const { mod } = await loadWith(lang, undefined, primitives)
  const { modelsStore, ModelToggles } = mod.__test
  const calls = []
  modelsStore.service = new Proxy({}, { get: (_, method) => async (...args) => { calls.push([method, ...args]); return ok({ groups: [group] }) } })
  modelsStore.state = group ? { groups: [group] } : null
  modelsStore.error = error
  modelsStore.busy = false
  return { mod, calls, modelsStore, nodes: render(ModelToggles({ routeId: group?.routeId ?? 'anthropic-api', kind: 'api' })) }
}
const switches = nodes => nodes.filter(n => n.type === 'button' && n.props.role === 'switch')

test('トグル: モデルごとにスイッチを出し、名前・ID・種別を表示する', async () => {
  const { nodes } = await togglesWith(modelGroup())
  const rows = nodes.filter(n => hasClass(n, 'mr-model-row'))
  assert.equal(rows.length, 3)
  assert.match(textOf(nodes), /モデル一覧に表示するモデル/)
  assert.match(textOf(nodes), /オンにしたモデルが、モデル選択の一覧に出ます/)
  assert.match(textOf(render(rows[0])), /Claude Sonnet 5\.5/)
  assert.match(textOf(render(rows[0])), /claude-sonnet-5-5/)
  assert.deepEqual(switches(nodes).map(n => n.props['aria-checked']), [true, false, true])
  assert.equal(nodes.find(n => hasClass(n, 'mr-kind')).children[0], 'API')
  assert.equal(switches(nodes)[0].props['aria-label'], 'Claude Sonnet 5.5 をモデル一覧に表示')
})

test('トグル: 押すと、ホストに表示/非表示を送り、状態を更新する', async () => {
  const { nodes, calls, modelsStore } = await togglesWith(modelGroup())
  switches(nodes)[1].props.onClick()   // 非表示 → 表示
  await flush()
  assert.deepEqual(calls[0], ['setModelVisible', 'anthropic-api', 'claude-opus-5-5', true])
  switches(nodes)[0].props.onClick()   // 表示 → 非表示
  await flush()
  assert.deepEqual(calls[1], ['setModelVisible', 'anthropic-api', 'claude-sonnet-5-5', false])
  assert.equal(modelsStore.busy, false)
})

test('トグル: DSH 標準の Switch があれば、それを使う', async () => {
  const Switch = props => ({ type: 'dsh-switch', props, children: [] })
  const { nodes, calls } = await togglesWith(modelGroup(), { primitives: { Switch } })
  const used = nodes.filter(n => n.type === 'dsh-switch')
  assert.equal(used.length, 3)
  assert.deepEqual(Object.keys(used[0].props).filter(key => key !== 'children').sort(), ['checked', 'disabled', 'label', 'onChange', 'title'].sort())
  assert.equal(used[1].props.checked, false)
  assert.ok(!nodes.some(n => n.props?.role === 'switch'), '簡易スイッチは使わない')
  used[1].props.onChange(true)   // Switch は次の値を渡す
  await flush()
  assert.deepEqual(calls[0], ['setModelVisible', 'anthropic-api', 'claude-opus-5-5', true])
})

test('トグル: 既定と違うときだけ「既定に戻す」を出し、押すと初期化する', async () => {
  let { nodes, calls } = await togglesWith(modelGroup())          // opus 非表示・sonnet-5 表示 = 既定と違う
  const reset = findButton(nodes, '既定に戻す')
  assert.ok(reset)
  reset.props.onClick()
  await flush()
  assert.deepEqual(calls[0], ['resetModels', 'anthropic-api'])
  const same = modelGroup({ models: [{ id: 'a', name: 'A', visible: true, default: true }, { id: 'b', name: 'B', visible: false, default: false }] })
  ;({ nodes } = await togglesWith(same))
  assert.equal(findButton(nodes, '既定に戻す'), undefined, '既定のままなら出さない')
})

test('トグル: API 枠の最後の1つはスイッチを無効にし、理由を示す', async () => {
  const locked = modelGroup({ lastLocked: true, models: [{ id: 'a', name: 'A', visible: true, default: true }, { id: 'b', name: 'B', visible: false, default: false }] })
  const { nodes } = await togglesWith(locked)
  const [on, off] = switches(nodes)
  assert.equal(on.props.disabled, true, '最後の1つは隠せない')
  assert.equal(on.props.title, 'キー入力欄を残すため、API では少なくとも1つのモデルを表示します。')
  assert.equal(off.props.disabled, false, '隠れているものは出せる')
  assert.match(textOf(nodes), /キー入力欄を残すため/)
})

test('トグル: 読み込み中・失敗・モデルなし・操作の失敗', async () => {
  let { nodes } = await togglesWith(null)
  assert.match(textOf(nodes), /モデルを読み込み中/)
  ;({ nodes } = await togglesWith(null, { error: '切断' }))
  assert.match(textOf(nodes), /モデルの一覧を読み込めません: 切断/)
  assert.ok(nodes.some(n => hasClass(n, 'mr-error')))
  ;({ nodes } = await togglesWith(modelGroup({ models: [] })))
  assert.match(textOf(nodes), /表示できるモデルがありません/)
  const { mod, modelsStore } = await togglesWith(modelGroup())
  modelsStore.service = { setModelVisible: async () => ({ ok: false, error: { message: 'API 枠のモデルは少なくとも1つ表示してください' } }) }
  await modelsStore.set('anthropic-api', 'a', false)
  assert.match(modelsStore.error, /少なくとも1つ/)
  assert.equal(modelsStore.busy, false)
  assert.match(textOf(render(mod.__test.ModelToggles({ routeId: 'anthropic-api' }))), /少なくとも1つ/, '失敗は画面に出る')
})

test('トグル: 英語・中国語でも表示できる', async () => {
  for (const [lang, title, reset] of [['en', /Models shown in the model list/, 'Reset to default'], ['zh', /在模型列表中显示的模型/, '恢复默认']]) {
    const { nodes } = await togglesWith(modelGroup(), { lang })
    assert.match(textOf(nodes), title, lang)
    assert.ok(findButton(nodes, reset), lang)
  }
})

test('OAuth 欄: モデルのトグルと注意書きを含む(Claude だけ Claude Code の注意)', async () => {
  const { mod } = await loadWith('ja')
  const { authStore, modelsStore, SubscriptionSection } = mod.__test
  modelsStore.state = { groups: [modelGroup({ routeId: 'anthropic', kind: 'subscription', label: 'Claude (OAuth)' }), modelGroup({ routeId: 'openai-codex', kind: 'subscription', label: 'OpenAI (OAuth)' })] }
  authStore.state = stateOf([route(), route({ providerId: 'openai', routeId: 'openai-codex', label: 'OpenAI' })])
  const claude = render(SubscriptionSection({ routeId: 'anthropic' }))
  assert.ok(claude.some(n => hasClass(n, 'mr-models')), 'OAuth のモデルのトグル')
  assert.equal(claude.find(n => hasClass(n, 'mr-kind')).children[0], 'OAuth')
  assert.match(textOf(claude), /ログインが切れたときは/)
  assert.match(textOf(claude), /Claude Code のトークンはコピーしないでください/)
  const openai = render(SubscriptionSection({ routeId: 'openai-codex' }))
  assert.ok(!/Claude Code/.test(textOf(openai)), '他のサービスには出さない')
  assert.match(textOf(openai), /OpenAI \(OAuth\)/)
})


test('Route RPC: client strict codec rejects invalid route IDs and non-boolean enabled', () => {
  const { mod } = load()
  const descriptor = mod.__test.CONTRIBUTION.descriptors.find(d => d.method === 'setRouteEnabled')
  const [id, enabled] = descriptor.parameters
  assert.equal(enabled.codec.schema.parse(false), false)
  assert.throws(() => enabled.codec.schema.parse('yes'))
  assert.throws(() => id.codec.schema.parse('../x'))
})

test('状態行: API キーと OAuth の実際の状態を出し、どちらも無いときは案内する', async () => {
  const { mod } = await loadWith('ja')
  const { CardStatus, modelsStore, authStore } = mod.__test
  modelsStore.state = { groups: [modelGroup({ enabled: true, registered: false }), modelGroup({ routeId: 'anthropic', kind: 'subscription', enabled: true, registered: true })] }
  authStore.state = stateOf([route({ registered: true, credentialType: 'oauth' })])
  let nodes = render(CardStatus({ apiRouteId: 'anthropic-api', keyConfigured: false, oauthRouteId: 'anthropic' }))
  assert.match(textOf(nodes), /API キー 未登録.*OAuth ログイン済み/)
  assert.ok(!/モデル一覧に出ません/.test(textOf(nodes)), 'OAuth で使えるので案内しない')
  authStore.state = stateOf([route({ registered: false })])
  nodes = render(CardStatus({ apiRouteId: 'anthropic-api', keyConfigured: false, oauthRouteId: 'anthropic' }))
  assert.match(textOf(nodes), /API キーも OAuth ログインもない/)
  // API キーだけのサービス
  modelsStore.state = { groups: [modelGroup({ providerId: 'opencode', routeId: 'opencode', service: 'OpenCode Zen', enabled: true, registered: false })] }
  nodes = render(CardStatus({ apiRouteId: 'opencode', keyConfigured: false }))
  assert.match(textOf(nodes), /API キーが未登録のため/)
  nodes = render(CardStatus({ apiRouteId: 'opencode', keyConfigured: true }))
  assert.match(textOf(nodes), /API キー 登録済み/)
  assert.ok(!/未登録のため/.test(textOf(nodes)))
  // DSH 標準の DeepSeek は、DSH が渡すキーの状態で示す
  assert.match(textOf(render(CardStatus({ apiRouteId: 'deepseek-official', keyConfigured: true }))), /API キー 登録済み/)
  // それ以外の、このプラグインのルートでないものは何も出さない
  assert.equal(CardStatus({ apiRouteId: 'some-builtin', keyConfigured: true }), null)
})

test('DSH 標準の DeepSeek の行は状態行だけで、モデルのトグルを出さない(読み込み中のまま残らない)', async () => {
  const { mod } = await loadWith('ja')
  const { ProviderCardExtension, CardStatus, ModelToggles, modelsStore } = mod.__test
  const node = ProviderCardExtension({ provider: { provider: 'deepseek-official' }, keyConfigured: true })
  assert.equal(node.type, CardStatus)
  // 読み込み済みで該当ルートが無ければ、「読み込み中」を出さない
  modelsStore.state = { groups: [modelGroup()] }
  modelsStore.error = null
  assert.equal(ModelToggles({ routeId: 'unknown-route' }), null)
  modelsStore.state = null
  assert.match(textOf(render(ModelToggles({ routeId: 'unknown-route' }))), /読み込み中/)
})

test('トグル: モデルが多いときは検索窓と件数を出し、検索で絞り込む', async () => {
  const { mod } = await loadWith('ja')
  const { ModelToggles, modelsStore } = mod.__test
  const models = Array.from({ length: 20 }, (_, i) => ({ id: 'vendor/model-' + i, name: 'Model ' + i, visible: i < 3, default: i < 3 }))
  modelsStore.state = { groups: [modelGroup({ routeId: 'commandcode-api', models })] }
  modelsStore.error = null
  let nodes = render(ModelToggles({ routeId: 'commandcode-api' }))
  assert.ok(nodes.some(n => n.type === 'input' && n.props.type === 'search'))
  assert.match(textOf(nodes), /20 件中 3 件/)
  assert.equal(switches(nodes).length, 20)
  // 少ないときは検索窓を出さない
  modelsStore.state = { groups: [modelGroup()] }
  nodes = render(ModelToggles({ routeId: 'anthropic-api' }))
  assert.ok(!nodes.some(n => n.type === 'input'))
})


test('状態行: 各枠の横にオン・オフを置き、確かめずに切り替える。オフの枠は「オフ」と出す', async () => {
  const asked = []
  const { mod } = await loadWith('ja', { confirm: message => { asked.push(message); return false } })
  const { CardStatus, SubscriptionRow, HideRow, modelsStore, authStore } = mod.__test
  const calls = []
  const groups = [modelGroup({ enabled: false, registered: false }), modelGroup({ routeId: 'anthropic', kind: 'subscription', enabled: false, registered: true })]
  modelsStore.state = { groups }
  modelsStore.error = null
  modelsStore.busy = false
  modelsStore.service = { setRouteEnabled: async (...args) => { calls.push(args); return ok({ groups }) } }
  authStore.state = stateOf([route({ registered: true, credentialType: 'oauth' })])
  const nodes = render(CardStatus({ apiRouteId: 'anthropic-api', keyConfigured: false, oauthRouteId: 'anthropic' }))
  assert.deepEqual(switches(nodes).map(n => [n.props['aria-label'], n.props['aria-checked']]), [['Claude (API) を有効にする', false], ['Claude (OAuth) を有効にする', false]])
  assert.match(textOf(nodes), /API キー オフ.*OAuth オフ/)
  assert.ok(!/モデル一覧に出ません/.test(textOf(nodes)), '全部オフなら案内を出さない')
  switches(nodes)[0].props.onClick(); await flush()
  assert.deepEqual(calls, [['anthropic-api', true]])
  assert.equal(asked.length, 0, '確認ダイアログは出さない')
  // OAuth の行は、API 枠がオフでも API のカードへまとめて隠す
  assert.equal(SubscriptionRow({ routeId: 'anthropic' }).type, HideRow)
  // DSH 標準の DeepSeek にはスイッチを出さない
  assert.equal(switches(render(CardStatus({ apiRouteId: 'deepseek-official', keyConfigured: true }))).length, 0)
})

test('Disabled routes: footer retains only disabled API/custom cards and re-enable removes them', async () => {
  const { mod } = await loadWith('en')
  const { DisabledRoutesCards, modelsStore } = mod.__test
  const groups = [
    modelGroup({ enabled: false }),
    modelGroup({ routeId: 'local', service: 'Local', label: 'Local', enabled: false }),
    modelGroup({ routeId: 'google-api', enabled: true }),
    modelGroup({ routeId: 'anthropic', kind: 'subscription', enabled: false }),
  ]
  modelsStore.state = { groups }
  modelsStore.busy = false
  let nodes = render({ type: DisabledRoutesCards, props: {}, children: [] })
  assert.deepEqual(nodes.filter(n => n.props?.['data-mr-disabled-route']).map(n => n.props['data-mr-disabled-route']), ['anthropic-api', 'local'])
  assert.match(textOf(nodes), /Enable this route first to edit its API key/)
  assert.equal(nodes.filter(n => n.type === 'input').length, 0, 'disabled routes never create a secret editor')
  const calls = []
  modelsStore.service = { setRouteEnabled: async (routeId, enabled) => {
    calls.push([routeId, enabled])
    return ok({ groups: groups.map(group => group.routeId === routeId ? { ...group, enabled } : group) })
  } }
  switches(nodes).find(n => n.props['aria-label'] === 'Enable Claude (API)').props.onClick()
  await flush()
  assert.deepEqual(calls, [['anthropic-api', true]])
  nodes = render({ type: DisabledRoutesCards, props: {}, children: [] })
  assert.deepEqual(nodes.filter(n => n.props?.['data-mr-disabled-route']).map(n => n.props['data-mr-disabled-route']), ['local'])
  modelsStore.state = null
  assert.deepEqual(DisabledRoutesCards(), [])
})

test('Disabled routes: local Edit exposes model controls and partner OAuth login, with localized hints', async () => {
  for (const lang of ['ja', 'en', 'zh']) {
    const { mod } = await loadWith(lang)
    const { DisabledRouteCard, modelsStore, authStore, DICT } = mod.__test
    const group = modelGroup({ enabled: false })
    modelsStore.state = { groups: [group, modelGroup({ routeId: 'anthropic', kind: 'subscription', enabled: true })] }
    authStore.state = stateOf([route()])
    const saved = stateImpl
    let nextOpen = false
    stateImpl = initial => [initial, value => { nextOpen = value }]
    try { findButton(render(DisabledRouteCard({ group })), DICT[lang]['agy.edit']).props.onClick() } finally { stateImpl = saved }
    assert.equal(nextOpen, true)
    stateImpl = initial => [initial === false ? true : initial, () => {}]
    let nodes
    try { nodes = render(DisabledRouteCard({ group })) } finally { stateImpl = saved }
    assert.match(textOf(nodes), new RegExp(DICT[lang]['routes.disabledHint'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.ok(nodes.some(n => n.props?.['data-mr-models'] === 'anthropic-api'))
    assert.ok(nodes.some(n => n.props?.['data-mr-subscription'] === 'anthropic'))
    assert.ok(findButton(nodes, DICT[lang]['btn.login']))
    assert.ok(switches(nodes).some(n => n.props['aria-label'].includes('(OAuth)')))
    assert.equal(nodes.filter(n => n.type === 'input' && n.props.type === 'password').length, 0)
  }
})

test('Antigravity: 自前の接続処理の状態を出し、切り替え・オフ・ログインを送る', async () => {
  const { mod } = await loadWith('ja')
  const { AgyCard, agyStore } = mod.__test
  const state = { accounts: [{ n: 1, email: 'a@example.com', active: true, signedIn: true }, { n: 2, email: 'b@example.com', active: false, signedIn: true }], login: null, models: [{ id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash', hidden: false }, { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', hidden: true }] }
  const calls = []
  agyStore.bind(new Proxy({}, { get: (_, method) => async (...args) => { calls.push([method, ...args]); return ok(state) } }))
  await agyStore.refresh()
  const nodes = render(AgyCard())
  assert.match(textOf(nodes), /Antigravity.*OAuth アカウント 2 件 ・ 使用中: a@example.com/)
  assert.ok(!/dsh-agy/.test(textOf(nodes)), '他のプラグインに頼らない')
  await agyStore.setEnabled(false)
  assert.deepEqual(calls.at(-1), ['agyAction', { action: 'setEnabled', enabled: false }])
  await agyStore.toggle('claude-opus-5-5-high', true)
  assert.deepEqual(calls.at(-1), ['agyAction', { action: 'show', modelId: 'claude-opus-5-5-high' }])
  await agyStore.act({ action: 'switch', n: 2 })
  assert.deepEqual(calls.at(-1), ['agyAction', { action: 'switch', n: 2 }])
})
test('Antigravity: オフはホストの印で決め、モデル一覧が読めないときもオフと出してスイッチでオンに戻せる', async () => {
  const { mod } = await loadWith('ja')
  const { AgyCard, agyStore } = mod.__test
  const account = { n: 1, email: 'a@example.com', active: true, signedIn: true }
  const calls = []
  let state = { accounts: [account], login: null, models: [], disabled: true }
  agyStore.bind(new Proxy({}, { get: (_, method) => async (...args) => { calls.push([method, ...args]); return ok(state) } }))
  await agyStore.refresh()
  let toggle = switches(render(AgyCard()))
  assert.equal(toggle.length, 1, '一覧が空でもスイッチを出す')
  assert.equal(toggle[0].props['aria-checked'] ?? toggle[0].props.checked, false)
  assert.match(textOf(render(AgyCard())), /オフ/)
  await agyStore.setEnabled(true)
  assert.deepEqual(calls.at(-1), ['agyAction', { action: 'setEnabled', enabled: true }])
  // 印が無く、モデルが見えていればオン
  state = { accounts: [account], login: null, models: [{ id: 'm', name: 'M', hidden: false }] }
  await agyStore.refresh()
  toggle = switches(render(AgyCard()))
  assert.equal(toggle[0].props['aria-checked'] ?? toggle[0].props.checked, true)
})
test('モデルルート: 代替チェーンを編集して保存し、アカウントを追加する', async () => {
  const { mod } = await loadWith('ja')
  const { ModelRoutesPage, ChainsTab, AccountsTab, setupStore } = mod.__test
  const state = {
    chains: [], media: {}, mediaKinds: ['image', 'stt', 'tts', 'video'], results: {},
    catalog: [{ provider: 'anthropic', name: 'Claude (OAuth)', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] }, { provider: 'openai-codex', name: 'OpenAI (OAuth)', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] }],
    accounts: [{ routeId: 'anthropic-api', service: 'Claude', label: 'Claude', apiKeyEnv: 'ANTHROPIC_API_KEY', accounts: [{ n: 1, routeId: 'anthropic-api', label: 'Claude', keyEnv: 'ANTHROPIC_API_KEY', registered: true }] }],
  }
  const calls = []
  setupStore.service = new Proxy({}, { get: (_, method) => async (...args) => { calls.push([method, ...args]); return ok(state) } })
  setupStore.state = state
  setupStore.error = null
  setupStore.busy = false
  let nodes = render(ModelRoutesPage())
  assert.deepEqual(nodes.filter(n => n.props?.role === 'tab').map(n => labelOf(n)), ['代替チェーン', 'アカウント', '用途別'])
  assert.match(textOf(nodes), /まだチェーンがありません/)
  // 保存は、チェーンを編集した下書きを送る
  const saveDraft = { chains: [{ id: 'main', name: 'メイン', steps: [{ provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }], accounts: true }] }
  await setupStore.act('saveChains', '保存しました', saveDraft)
  assert.deepEqual(calls.at(-1), ['saveChains', saveDraft])
  state.chains = saveDraft.chains
  state.results = { main: { provider: 'openai-codex', model: 'gpt-6.1-sol', tried: [{ provider: 'anthropic', model: 'claude-opus-5-5', code: 'RATE_LIMIT' }] } }
  nodes = render(ChainsTab({ store: setupStore, translate: mod.__test.t }))
  assert.match(textOf(nodes), /直近の応答: OpenAI \(OAuth\) \/ gpt-6.1-sol.*切り替え: Claude \(OAuth\) \/ claude-opus-5-5 RATE_LIMIT/)
  // アカウントの追加
  nodes = render(AccountsTab({ store: setupStore, translate: mod.__test.t }))
  findButton(nodes, '#2 を追加').props.onClick(); await flush()
  assert.deepEqual(calls.at(-1), ['addAccount', 'anthropic-api'])
})

test('代替チェーン: 一覧に無い保存済みの選択(キー未登録の追加アカウント)も消さずに見せ、名前で読める', async () => {
  const { mod } = await loadWith('ja')
  const { ChainsTab, setupStore } = mod.__test
  setupStore.state = {
    chains: [{ id: 'main', name: '動作確認', steps: [{ provider: 'anthropic-api-2', model: 'claude-haiku-5-5' }], accounts: true }],
    catalog: [{ provider: 'anthropic-api', name: 'Claude', models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }] }],
    results: { main: { provider: 'openai-codex', model: 'gpt-6.1-sol', tried: [{ provider: 'anthropic-api-2', model: 'claude-haiku-5-5', code: 'MISSING_CREDENTIAL' }] } },
    accounts: [], media: {}, mediaKinds: [],
  }
  setupStore.busy = false
  const nodes = render(ChainsTab({ store: setupStore, translate: mod.__test.t }))
  assert.match(textOf(nodes), /Claude #2\(一覧に無い\)/)
  assert.match(textOf(nodes), /切り替え: Claude #2 \/ claude-haiku-5-5 MISSING_CREDENTIAL/)
})

test('用途別: モデルはセレクトで選び(新しい順のまま)、一覧の読み込みボタンと用途ごとのスイッチ(新しく選んだ用途は無効)がある', async () => {
  const { mod } = await loadWith('ja')
  const { MediaTab, setupStore } = mod.__test
  const calls = []
  const state = {
    media: { tts: { provider: 'openai-api', model: 'gpt-4o-mini-tts', enabled: true }, video: { provider: 'google-api', model: 'veo-3' } },
    mediaKinds: ['image', 'stt', 'tts', 'video'],
    mediaCatalog: {
      image: [{ provider: 'openai-api', name: 'OpenAI', models: [{ id: 'gpt-image-1.5', name: 'gpt-image-1.5' }, { id: 'gpt-image-1', name: 'gpt-image-1' }] }],
      tts: [{ provider: 'openai-api', name: 'OpenAI', models: [{ id: 'gpt-4o-mini-tts', name: 'gpt-4o-mini-tts' }, { id: 'tts-1', name: 'tts-1' }] }],
      stt: [], video: [],
    },
    catalog: [{ provider: 'anthropic', name: 'Claude (OAuth)', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] }],
  }
  setupStore.service = new Proxy({}, { get: (_, method) => async (...args) => { calls.push([method, ...args]); return ok(state) } })
  setupStore.state = state; setupStore.error = null; setupStore.busy = false
  const drafts = []
  const saved = stateImpl
  stateImpl = initial => [initial, value => drafts.push(value)]
  try {
    const nodes = render(MediaTab({ store: setupStore, translate: mod.__test.t }))
    assert.equal(nodes.filter(n => n.type === 'input').length, 0, 'no free-text model field')
    const row = kind => render(nodes.find(n => n.props?.['data-mr-media'] === kind))
    // The model select keeps the catalog's newest-first order.
    const imageSelects = row('image').filter(n => n.type === 'select')
    assert.equal(imageSelects.length, 2)
    // A purpose with no models explains how to get some instead of offering chat models.
    assert.match(textOf(row('stt')), /使えるモデルがありません/)
    assert.ok(!/Claude/.test(textOf(row('stt'))))
    // Switches: on for the saved tts, disabled where no model is chosen.
    const switchOf = kind => row(kind).find(n => n.props?.role === 'switch')
    assert.equal(switchOf('tts').props['aria-checked'], true)
    assert.equal(switchOf('image').props['aria-checked'], false)
    assert.equal(switchOf('image').props.disabled, true)
    assert.equal(switchOf('video').props['aria-checked'], true, 'saved before the switch existed: shown on, as the host treats it')
    // Picking a service for a new purpose selects its newest model and leaves the purpose off.
    imageSelects[0].props.onChange({ target: { value: 'openai-api' } })
    assert.deepEqual(drafts.at(-1).image, { provider: 'openai-api', model: 'gpt-image-1.5', enabled: false })
    // Turning tts off keeps its model.
    switchOf('tts').props.onClick()
    assert.deepEqual(drafts.at(-1).tts, { provider: 'openai-api', model: 'gpt-4o-mini-tts', enabled: false })
    // The reload button asks the host to fetch the provider lists again.
    findButton(nodes, 'モデル一覧を読み込む').props.onClick(); await flush()
    assert.deepEqual(calls.at(-1), ['reloadMediaModels'])
  } finally { stateImpl = saved }
})

test('用途別: 一覧に無いサービスはオンにできない(オフはできる)。選んだあとは「モデルを選ぶ」を出さない。読み込めなかったサービスは理由を出す', async () => {
  const { mod } = await loadWith('ja')
  const { MediaTab, setupStore } = mod.__test
  const state = {
    media: { image: { provider: 'openai-api', model: 'gpt-image-2', enabled: false }, tts: { provider: 'openai-api', model: 'tts-1', enabled: true }, stt: { provider: 'google-api', model: 'gemini-3-flash' } },
    mediaKinds: ['image', 'stt', 'tts', 'video'],
    mediaCatalog: { image: [], tts: [], stt: [{ provider: 'google-api', name: 'Gemini', models: [{ id: 'gemini-3-flash', name: 'gemini-3-flash' }] }], video: [] },
    mediaErrors: { 'xai-api': { name: 'Grok', message: '401' } },
  }
  setupStore.service = new Proxy({}, { get: () => async () => ok(state) })
  setupStore.state = state; setupStore.error = null; setupStore.busy = false
  const nodes = render(MediaTab({ store: setupStore, translate: mod.__test.t }))
  const row = kind => render(nodes.find(n => n.props?.['data-mr-media'] === kind))
  const switchOf = kind => row(kind).find(n => n.props?.role === 'switch')
  assert.equal(switchOf('image').props.disabled, true, 'not in the list and off: cannot be switched on')
  assert.equal(switchOf('tts').props.disabled, false, 'not in the list but on: can still be switched off')
  assert.ok(row('image').some(n => n.props?.['data-mr-media-unlisted'] !== undefined))
  assert.ok(!row('stt').some(n => n.props?.['data-mr-media-unlisted'] !== undefined))
  const modelSelect = row('stt').filter(n => n.type === 'select')[1]
  assert.ok(!render(modelSelect).some(n => n.type === 'option' && n.props.value === ''), 'no empty choice once a model is chosen')
  assert.match(textOf(nodes), /Grok: モデル一覧を読み込めませんでした\(エラー: 401\)/)
})

test('用途別: 「モデル一覧を読み込む」の知らせは、読み込めなかったサービスがあるときだけ変える。取得に失敗しただけの枠はオンにできる', async () => {
  const { mod } = await loadWith('ja')
  const { MediaTab, setupStore } = mod.__test
  const base = { media: { image: { provider: 'openai-api', model: 'gpt-image-2', enabled: false } }, mediaKinds: ['image'], mediaCatalog: { image: [] } }
  let next = { ...base, mediaErrors: {} }
  setupStore.service = new Proxy({}, { get: () => async () => ok(next) })
  setupStore.state = { ...base, mediaErrors: { 'openai-api': { name: 'OpenAI', message: '8 秒以内に応答がありませんでした' } } }
  setupStore.error = null; setupStore.busy = false
  let nodes = render(MediaTab({ store: setupStore, translate: mod.__test.t }))
  const sw = nodes.find(n => n.props?.role === 'switch')
  assert.equal(sw.props.disabled, false, 'a service whose list only failed to load can be switched on')
  await findButton(nodes, 'モデル一覧を読み込む').props.onClick(); await flush()
  assert.equal(setupStore.notice, 'モデル一覧を読み込みました')
  next = { ...base, mediaErrors: { 'openai-api': { name: 'OpenAI', message: '401' } } }
  nodes = render(MediaTab({ store: setupStore, translate: mod.__test.t }))
  await findButton(nodes, 'モデル一覧を読み込む').props.onClick(); await flush()
  assert.match(setupStore.notice, /読み込めなかったサービスがあります/)
})

test('用途別: 取得の失敗理由は画面の言語で出す(時間切れ・キー未登録・HTTP)。押せないスイッチは理由を名前に含める', async () => {
  const { mod } = await loadWith('en')
  const { MediaTab, setupStore } = mod.__test
  setupStore.state = {
    media: { image: { provider: 'openai-api', model: 'gpt-image-2', enabled: false }, tts: { provider: 'openai-api', model: 'tts-1', enabled: true } },
    mediaKinds: ['image', 'tts'], mediaCatalog: { image: [], tts: [] },
    mediaErrors: {
      'xai-api': { name: 'Grok', message: 'timeout', code: 'timeout', detail: { seconds: 8 } },
      'google-api': { name: 'Gemini', message: '「GEMINI_API_KEY」のAPIキーが登録されていません', code: 'missing_credential', detail: { key: 'GEMINI_API_KEY' } },
      'openai-api-2': { name: 'OpenAI #2', message: '401: bad key', code: 'http', detail: { status: 401, detail: 'bad key' } },
    },
  }
  setupStore.error = null; setupStore.busy = false
  const nodes = render(MediaTab({ store: setupStore, translate: mod.__test.t }))
  const errors = render(nodes.find(n => n.props?.['data-mr-media-errors'] !== undefined))
  assert.equal(errors[0].props.role, undefined, 'a plain list; the notice below announces')
  const text = textOf(errors)
  assert.match(text, /Grok: could not load the model list \(no answer within 8 seconds\)/)
  assert.match(text, /Gemini: could not load the model list \(API key "GEMINI_API_KEY" is not registered\)/)
  assert.match(text, /OpenAI #2: could not load the model list \(HTTP 401: bad key\)/)
  const switches = nodes.filter(n => n.props?.role === 'switch')
  assert.equal(switches[0].props['aria-label'], 'Enable Image generation (This service is not in the current list (no API key registered, or no model for this purpose). It cannot be switched on.)')
  assert.match(switches[1].props['aria-label'], /Once switched off, it cannot be switched on again/, 'an unlisted purpose that is on says what switching it off means')
})

test('用途別: 一覧に無いサービスでも、保存済みがオンならオフにした後もスイッチは押せる(オンに戻せる)', async () => {
  const { mod } = await loadWith('ja')
  const { MediaTab, setupStore } = mod.__test
  setupStore.state = { media: { image: { provider: 'openai-api', model: 'gpt-image-2', enabled: true } }, mediaKinds: ['image'], mediaCatalog: { image: [] }, mediaErrors: {} }
  setupStore.error = null; setupStore.busy = false
  const saved = stateImpl
  stateImpl = initial => [initial === null ? { image: { provider: 'openai-api', model: 'gpt-image-2', enabled: false } } : initial, () => {}]
  try {
    const nodes = render(MediaTab({ store: setupStore, translate: mod.__test.t }))
    const sw = nodes.find(n => n.props?.role === 'switch')
    assert.equal(sw.props['aria-checked'], false)
    assert.equal(sw.props.disabled, false, 'still operable: switched off in the draft only')
    assert.equal(nodes.find(n => n.props?.['data-mr-media-unlisted'] !== undefined).props['aria-hidden'], 'true')
    assert.match(sw.props['aria-label'], /保存するまではオンに戻せます/, 'the name says it can still be switched back on')
  } finally { stateImpl = saved }
})

test('代替チェーン: 新しく足した段(モデル未選択)では「モデルを選ぶ」を出す', async () => {
  const { mod } = await loadWith('ja')
  const { ChainsTab, setupStore } = mod.__test
  setupStore.state = {
    chains: [{ id: 'main', name: 'メイン', steps: [{ provider: 'anthropic', model: '' }], accounts: true }],
    catalog: [{ provider: 'anthropic', name: 'Claude (OAuth)', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] }],
    results: {}, accounts: [], media: {}, mediaKinds: [],
  }
  setupStore.busy = false
  const nodes = render(ChainsTab({ store: setupStore, translate: mod.__test.t }))
  const modelSelect = nodes.filter(n => n.type === 'select').find(n => n.props['aria-label'] === 'モデルを選ぶ')
  assert.ok(modelSelect, 'the model select')
  assert.ok(render(modelSelect).some(n => n.type === 'option' && n.props.value === ''), 'the empty choice is there while no model is chosen')
})

test('OAuth: ログイン中は保存先を変える追加・切り替え・削除を無効にする', async () => {
  const { mod } = await loadWith('ja')
  const { OauthAccounts, authStore, setupStore, t } = mod.__test
  setupStore.state = { oauth: [{ routeId: 'anthropic', label: 'Claude', accounts: [{ n: 1, active: true, signedIn: false }, { n: 2, active: false, signedIn: true }] }] }
  setupStore.busy = false; authStore.busy = false
  for (const phase of ['running', 'prompt']) {
    authStore.state = { routes: [], attempt: { id: 'synthetic', routeId: 'anthropic', label: 'Claude', phase, notices: [], prompt: null, error: null } }
    const nodes = render(OauthAccounts({ store: setupStore, translate: t }))
    const mapping = buttons(nodes).filter(node => ['アカウントを追加', '使う', '外す'].includes(labelOf(node)))
    assert.equal(mapping.length, 4)
    assert.ok(mapping.every(node => node.props.disabled === true))
  }
  authStore.state = { routes: [], attempt: null }; setupStore.busy = true
  assert.equal(findButton(render(OauthAccounts({ store: setupStore, translate: t })), 'ログイン').props.disabled, true)
})
