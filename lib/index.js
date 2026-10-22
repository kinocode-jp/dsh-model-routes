// @kinocode/dsh-model-routes
// DeepSeek Harness 用マルチプロバイダ・モデルルート管理プラグイン
//
// 特長:
// 1. 各LLM（Claude, OpenAI, Gemini, Grok, OpenCode 等）の「サブスク枠 (OAuth)」と「APIキー枠」を独立登録
// 2. 公式にない独自LLM・カスタムエンドポイント（Ollama, vLLM, 独自サーバー等）を customProviders で登録
// 3. モデル一覧での表示・非表示（プロバイダ単位 / モデル単位）を柔軟に制御
// 4. 多言語対応 (日本語 ja / 英語 en / 中国語 zh)
// 5. Node.js 24 互換性パッチ (AbortSignal) を自動適用

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { patchAbortSignal } from './patch.js';
import { PROVIDER_PRESETS } from './presets.js';
import { createAuthService } from './auth-service.js';
import { createMessages } from './auth-messages.js';
import { createModelsService } from './models-service.js';
import { plainJson } from './auth-contracts.js';
import { TYPERT } from './typert.host.js';
import { createOauthAccounts, normalizeOauth } from './oauth-accounts.js';
import { AGY_PROVIDER, createAntigravity, normalizeAgy } from './agy/index.mjs';
import { AdapterBase, CHAIN_PROVIDER, MEDIA_KINDS, accountKeyEnv, accountRouteId, createChainAdapter, normalizeAccounts, normalizeChains, normalizeMedia, readSetup, writeSetup } from './chains.js';

/**
 * 追加アカウント(API キーの2本目以降)を持てる API 枠。接続先(api)を自分で持つ枠だけ。
 * OpenCode Zen は DSH 同梱の 'opencode' ルートの接続方式に頼るため、同じ形の別ルートを作れない。
 */
export function accountCapableRoutes() {
  return Object.values(PROVIDER_PRESETS).filter(preset => preset.api?.api && preset.api?.apiKeyEnv).map(preset => ({ routeId: preset.api.provider, service: preset.name, label: preset.api.labels?.ja || preset.name, apiKeyEnv: preset.api.apiKeyEnv }));
}

export const name = 'dsh-model-routes';
export const inject = ['loader'];

export { patchAbortSignal, PROVIDER_PRESETS };

/**
 * 3言語辞書定義
 */
export const I18N = {
  ja: {
    subscriptionSuffix: ' (サブスク)',
    apiSuffix: ' (API)',
    apiModelSuffix: ' (API)',
  },
  en: {
    subscriptionSuffix: ' (Subscription)',
    apiSuffix: ' (API)',
    apiModelSuffix: ' (API)',
  },
  zh: {
    subscriptionSuffix: ' (订阅)',
    apiSuffix: ' (API)',
    apiModelSuffix: ' (API)',
  },
};

/**
 * 現在のロケール判定 (ja | en | zh)
 */
export function resolveLocale(ctx, explicitLocale) {
  if (explicitLocale && I18N[explicitLocale]) return explicitLocale;

  try {
    const settings = ctx.get('settings');
    const pref = settings?.get?.('locale')?.preference;
    if (pref) {
      if (pref.startsWith('ja')) return 'ja';
      if (pref.startsWith('zh')) return 'zh';
      if (pref.startsWith('en')) return 'en';
    }
  } catch {}

  const envLang = process.env.DSH_LANG || process.env.LC_ALL || process.env.LANG || '';
  if (/^zh/i.test(envLang)) return 'zh';
  if (/^ja/i.test(envLang)) return 'ja';

  return 'ja';
}

/**
 * モデル一覧の表示/非表示フィルタリング
 * @param {Array} baseModels プリセットまたはカスタムモデルリスト
 * @param {Object} options ユーザー設定 (visibleModels, hiddenModels, customModels, models)
 */
export function filterModels(baseModels = [], options = {}) {
  const { visibleModels, hiddenModels, customModels = [], models: modelOverrides, modelFlags } = options;
  const flags = boolObject(modelFlags) ? modelFlags : {};

  let list = [...baseModels];

  // 1. モデル個別の上書き (enabled: false 等)
  if (Array.isArray(modelOverrides)) {
    const overrideMap = new Map(modelOverrides.map(m => [m.id, m]));
    list = list.map(m => {
      const ov = overrideMap.get(m.id);
      return ov ? { ...m, ...ov } : m;
    });
    // 新規モデルがあれば追加
    for (const ov of modelOverrides) {
      if (!list.some(m => m.id === ov.id)) {
        list.push(ov);
      }
    }
  }

  // 2. カスタムモデルの追加
  if (Array.isArray(customModels)) {
    for (const cm of customModels) {
      if (!list.some(m => m.id === cm.id)) {
        list.push({ ...cm, defaultVisible: true });
      }
    }
  }

  // 3. 表示/非表示の判定
  return list.filter(m => {
    // 明示的に enabled: false の場合は除外
    if (m.enabled === false) return false;

    // 画面(モデルごとのトグル)で決めた表示/非表示は、設定の絞り込みより優先する。
    if (typeof flags[m.id] === 'boolean') return flags[m.id];

    // hiddenModels に含まれている場合は除外
    if (Array.isArray(hiddenModels) && hiddenModels.includes(m.id)) return false;

    // visibleModels が指定されている場合、それに含まれているもののみ表示
    if (Array.isArray(visibleModels)) {
      return visibleModels.includes(m.id);
    }

    // 指定がない場合は defaultVisible (未定義なら true) に従う
    return m.defaultVisible !== false;
  }).map(({ defaultVisible, enabled, ...rest }) => rest);
}

/**
 * 指定されたプロバイダ設定を構築
 */
export function buildProviderRoute(type, preset, userRouteConfig = {}, locale = 'ja', modelFlags) {
  // enabled が明示的に false の場合は null を返す（非表示・登録しない）
  if (userRouteConfig.enabled === false) return null;

  const labels = preset.labels || {};
  const defaultDisplayName = labels[locale] || labels.ja || `${preset.name} (${type})`;
  const displayName = userRouteConfig.displayName || defaultDisplayName;

  // モデルのフィルタリング
  let models = filterModels(preset.models, { ...userRouteConfig, modelFlags });
  // API 枠は、画面でモデルを全部隠しても設定に残す(キー入力欄が消えないように)。1つだけ出す。
  if (models.length === 0 && type === 'api' && boolObject(modelFlags) && Object.keys(modelFlags).length) models = filterModels(preset.models.slice(0, 1), {});
  if (models.length === 0) return null; // 有効なモデルがゼロの場合はルートを登録しない

  const route = {
    displayName,
    models,
  };

  // サブスク側: apiKeyEnv は絶対に含めない
  if (type === 'subscription') {
    if (preset.baseURL) route.baseURL = preset.baseURL;
    return route;
  }

  // API側: apiKeyEnv, api, baseURL を設定
  if (type === 'api') {
    if (preset.api) route.api = preset.api;
    if (preset.baseURL) route.baseURL = userRouteConfig.baseURL || preset.baseURL;
    route.apiKeyEnv = userRouteConfig.apiKeyEnv || preset.apiKeyEnv;
    return route;
  }

  return route;
}

/**
 * 公式にない任意カスタムプロバイダ（customProviders）の構築
 */
export function buildCustomProviderRoute(providerId, userConfig = {}, locale = 'ja') {
  if (userConfig.enabled === false) return null;

  let displayName = userConfig.displayName;
  if (typeof displayName === 'object' && displayName !== null) {
    displayName = displayName[locale] || displayName.ja || displayName.en || providerId;
  } else if (!displayName) {
    displayName = providerId;
  }

  // モデルリストの取得とフィルタリング
  const models = filterModels(userConfig.models || [], userConfig);
  if (models.length === 0) return null;

  const route = {
    displayName,
    models,
  };

  // プロトコル指定 (デフォルト: openai-completions)
  route.api = userConfig.api || 'openai-completions';

  // baseURL
  if (userConfig.baseURL) {
    route.baseURL = userConfig.baseURL;
  }

  // apiKeyEnv (指定がある場合のみ設定、ない場合はキー不要通信またはOAuth)
  if (userConfig.apiKeyEnv) {
    route.apiKeyEnv = userConfig.apiKeyEnv;
  }

  // 追加オプション（headers, compat 等）
  if (userConfig.headers) route.headers = { ...userConfig.headers };
  if (userConfig.compat) route.compat = { ...userConfig.compat };

  return route;
}

// 会話に使えない種類(音声・文字起こし・判定・埋め込み・画像生成・検索 API など)。一覧の取得結果から外す。
const NON_CHAT = /(^|[-_/.])(tts|whisper|transcribe|moderation|embed|embedding|dall-e|image|audio|realtime|search-api|babbage|davinci|sora|speech|live|computer-use|deep-research)([-_./]|$)/i;
export const isChatModel = id => typeof id === 'string' && !NON_CHAT.test(id);

/**
 * モデル ID から、系列(ベンダーまたは名前の頭)と版番号を読む。
 * 例: gpt-6.1-sol → gpt / [6,1]、claude-opus-4-5 → claude / [4,5]、o3-mini → o / [3]、
 *     deepseek/deepseek-v4-flash → deepseek / [4]。8桁の日付や 2026-04-23 は版ではなく日付として扱う。
 */
export function modelVersionOf(id) {
  const text = String(id).toLowerCase();
  const slash = text.indexOf('/');
  const family = slash > 0 ? text.slice(0, slash) : (/^[a-z]+/.exec(text)?.[0] ?? text);
  const tokens = text.slice(slash + 1).split(/[^a-z0-9.]+/).filter(Boolean);
  const version = [];
  let date = '';
  for (const token of tokens) {
    if (/^(19|20)\d{6}$/.test(token)) { date = token; break; }
    if (/^(19|20)\d{2}$/.test(token)) { date = tokens.slice(tokens.indexOf(token)).join('-'); break; }
    const match = /^[a-z]*(\d+(?:\.\d+)*)[a-z]?$/.exec(token);
    if (match) { version.push(...match[1].split('.').map(Number)); continue; }
    if (version.length) break;
  }
  return { family, version, date };
}

/**
 * 新しい順(版番号の大きい順)に並べる。系列ごとにまとめ、系列の並びは元の一覧で最初に出た順。
 * 同じ版では日付なしを先に、日付付きは新しい日付から。
 */
export function sortModelsNewestFirst(models, idOf = model => model.id) {
  const firstSeen = new Map();
  const keyed = models.map((model, index) => {
    const info = modelVersionOf(idOf(model));
    if (!firstSeen.has(info.family)) firstSeen.set(info.family, index);
    return { model, index, ...info };
  });
  const byVersion = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === undefined) return 1;
      if (b[i] === undefined) return -1;
      if (a[i] !== b[i]) return b[i] - a[i];
    }
    return 0;
  };
  keyed.sort((a, b) => (firstSeen.get(a.family) - firstSeen.get(b.family))
    || (a.version.length && b.version.length ? byVersion(a.version, b.version) : (b.version.length - a.version.length))
    || (a.date ? 1 : 0) - (b.date ? 1 : 0)
    || (b.date > a.date ? 1 : b.date < a.date ? -1 : 0)
    || String(idOf(a.model)).localeCompare(String(idOf(b.model))));
  return keyed.map(item => item.model);
}

/**
 * 取得したモデル一覧(live)をカタログの控え(baseModels)に重ねる。
 * 控えのモデルは、取得した一覧に無ければ外す(提供が終わったもの)。控えに無いモデルは既定で非表示として足す。
 * live が空・不正なら控えをそのまま返す(取得に失敗しても動くように)。
 */
export function mergeLiveModels(baseModels = [], live) {
  if (!Array.isArray(live) || live.length === 0) return baseModels;
  const base = new Map(baseModels.map(model => [model.id, model]));
  // 控えのモデル名が揃って「(API)」などの後ろ書きを持つなら、足すモデルにも付ける(同じ名前の別の枠と見分けるため)。
  const suffixes = new Set(baseModels.map(model => / \([^)]+\)$/.exec(String(model.name ?? ''))?.[0] ?? ''));
  const suffix = suffixes.size === 1 ? [...suffixes][0] : '';
  // 並びは取得した一覧の順。オン・オフで並びを分けない(オフのものだけが下にまとまらないように)。
  const merged = [];
  const seen = new Set();
  for (const model of live) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    if (base.has(model.id)) { merged.push(base.get(model.id)); continue; }
    const name = model.name || model.id;
    const entry = { id: model.id, name: suffix && !name.endsWith(suffix) ? name + suffix : name, defaultVisible: false };
    if (Number.isFinite(model.contextWindow)) entry.contextWindow = model.contextWindow;
    if (Number.isFinite(model.maxTokens)) entry.maxTokens = model.maxTokens;
    if (Array.isArray(model.input) && model.input.length) entry.input = [...model.input];
    merged.push(entry);
  }
  return merged.length ? merged : baseModels;
}

/**
 * カタログの枠に、取得したモデル一覧を重ねたもの。
 * 取得結果が無いとき(初回の起動直後・取得失敗)も、控えを同じ規則(系列ごとに新しい版から)で並べる。
 * どの一覧(モデルの表示スイッチ・モデル選択・DSH の取得ダイアログ)でも同じ並びにするため。
 */
export function liveRoute(base, live) {
  return { ...base, models: Array.isArray(live) && live.length ? mergeLiveModels(base.models, live) : sortModelsNewestFirst(base.models) };
}

// 設定ファイルを書き換えずに、画面から枠の有効/無効を保存する。
const currentDshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const overridesPath = () => path.join(currentDshHome(), 'storages', 'model-routes', 'overrides.json');
const boolObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// このプラグインが作成したルート。値は適用時の内容ハッシュ(true は旧形式)。
const ownedRoutes = value => boolObject(value) ? Object.fromEntries(Object.entries(value).filter(([, owned]) => owned === true || typeof owned === 'string')) : {};
const manualRoutes = value => boolObject(value) ? Object.fromEntries(Object.entries(value).filter(([, manual]) => manual === true)) : {};
// 画面で決めたモデルごとの表示/非表示: { ルートID: { モデルID: true|false } }
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const modelFlagsOf = value => {
  const result = {};
  if (!boolObject(value)) return result;
  for (const [routeId, flags] of Object.entries(value)) {
    if (!ROUTE_ID.test(routeId) || !boolObject(flags)) continue;
    const kept = Object.fromEntries(Object.entries(flags).filter(([id, flag]) => MODEL_ID.test(id) && typeof flag === 'boolean'));
    if (Object.keys(kept).length) result[routeId] = kept;
  }
  return result;
};
const fingerprint = route => route === undefined ? '' : createHash('sha1').update(JSON.stringify(route)).digest('hex');

export function readOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(overridesPath(), 'utf8'));
    const providers = {};
    if (boolObject(raw?.providers)) for (const [id, kinds] of Object.entries(raw.providers)) {
      if (!boolObject(kinds)) continue;
      const next = {};
      for (const kind of ['subscription', 'api']) if (typeof kinds[kind] === 'boolean') next[kind] = kinds[kind];
      if (Object.keys(next).length) providers[id] = next;
    }
    const customProviders = {};
    if (boolObject(raw?.customProviders)) for (const [id, value] of Object.entries(raw.customProviders)) if (typeof value?.enabled === 'boolean') customProviders[id] = { enabled: value.enabled };
    const owned = ownedRoutes(raw?.owned);
    const manual = manualRoutes(raw?.manual);
    const models = modelFlagsOf(raw?.models);
    return { providers, customProviders, owned, manual, models };
  } catch (error) {
    if (error instanceof SyntaxError) {
      try { fs.renameSync(overridesPath(), overridesPath() + '.corrupt-' + Date.now()); } catch {}
    }
    return { providers: {}, customProviders: {}, owned: {}, manual: {}, models: {} };
  }
}

function writeOverrides(value) {
  const file = overridesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// 取得したモデル一覧の控え。起動直後(取得前)やオフラインでも、前回の一覧を使えるようにする。
const liveModelsPath = () => path.join(currentDshHome(), 'storages', 'model-routes', 'live-models.json');
const liveModelOf = value => {
  if (!boolObject(value) || typeof value.id !== 'string' || !MODEL_ID.test(value.id)) return null;
  const model = { id: value.id };
  if (typeof value.name === 'string' && value.name) model.name = value.name.slice(0, 200);
  if (Number.isFinite(value.contextWindow) && value.contextWindow > 0) model.contextWindow = value.contextWindow;
  if (Number.isFinite(value.maxTokens) && value.maxTokens > 0) model.maxTokens = value.maxTokens;
  if (Array.isArray(value.input)) { const input = value.input.filter(item => item === 'text' || item === 'image'); if (input.length) model.input = input; }
  return model;
};
const liveListOf = list => Array.isArray(list) ? list.map(liveModelOf).filter(Boolean) : [];

export function readLiveModels() {
  try {
    const raw = JSON.parse(fs.readFileSync(liveModelsPath(), 'utf8'));
    const result = {};
    if (boolObject(raw?.routes)) for (const [routeId, entry] of Object.entries(raw.routes)) {
      const models = liveListOf(entry?.models);
      if (ROUTE_ID.test(routeId) && models.length) result[routeId] = models;
    }
    return result;
  } catch {
    return {};
  }
}

function writeLiveModels(routes) {
  const file = liveModelsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), routes: Object.fromEntries(Object.entries(routes).map(([id, models]) => [id, { models }])) }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * カタログの discovery に従って、1つの枠の提供モデルを取得する。
 * - catalog: DSH(pi-ai)の同梱カタログを llm サービスの discoverModels で読む(ネットワークを使わない)。
 * - openai-list: {baseURL}/models(OpenAI 形式)を読む。endpoint があれば、supported_endpoints にそれを含むものだけ。
 * @returns モデルの配列。取得できないときは例外。
 */
export async function discoverRouteModels(base, { llm, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const discovery = base?.discovery;
  // exclude: 会話に使えない種類(画像生成・音声・日付付きの別名など)を外す正規表現。
  const excluded = typeof discovery?.exclude === 'string' && discovery.exclude ? new RegExp(discovery.exclude) : null;
  const keep = models => sortModelsNewestFirst(models.filter(model => isChatModel(model.id) && !(excluded && excluded.test(model.id))));
  if (discovery?.kind === 'catalog') {
    if (typeof llm?.discoverModels !== 'function') throw new Error('llm.discoverModels がありません');
    // provider: どのルートの同梱カタログを読むか。API 枠(anthropic-api など)は同じサービスの OAuth/公式ルートの一覧を使う。
    const listed = await llm.discoverModels('llm-pi-ai', { provider: discovery.provider || base.provider }, AbortSignal.timeout(timeoutMs));
    return keep(liveListOf(listed.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: model.inputModalities }))));
  }
  if (discovery?.kind === 'openai-list') {
    if (typeof fetchImpl !== 'function' || !base.baseURL) throw new Error('取得先がありません');
    const response = await fetchImpl(base.baseURL.replace(/\/+$/, '') + '/models', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${base.baseURL}/models が ${response.status} を返しました`);
    const body = await response.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    const usable = discovery.endpoint ? data.filter(model => !Array.isArray(model?.supported_endpoints) || model.supported_endpoints.includes(discovery.endpoint)) : data;
    return keep(liveListOf(usable.map(model => ({ id: model?.id, name: model?.name, contextWindow: model?.context_length }))));
  }
  return [];
}

/** llm-pi-ai のエントリはプロファイルの include 配下にあるため、store 直下とは限らない。 */
export function findLlmpiAi(loader) {
  if (!loader) return null;
  if (loader.store?.['llm-pi-ai']) return loader.store['llm-pi-ai'];
  try {
    for (const entry of loader.entries?.() ?? []) {
      if (entry?.options?.id === 'llm-pi-ai' || entry?.options?.name === '@deepseek-ai/dsh-llm-pi-ai') return entry;
    }
  } catch {}
  try { return loader.resolve?.('llm-pi-ai') ?? null; } catch { return null; }
}

/** overrides(画面からの変更)を設定に重ねる。overrides が優先。 */
export function withOverrides(config = {}, overrides = { providers: {}, customProviders: {} }) {
  const next = { ...config, providers: { ...(config.providers || {}) }, customProviders: { ...(config.customProviders || {}) }, modelFlags: modelFlagsOf(overrides.models) };
  for (const [id, kinds] of Object.entries(overrides.providers || {})) {
    const base = next.providers[id] || {};
    const merged = { ...base };
    for (const kind of ['subscription', 'api']) if (typeof kinds?.[kind] === 'boolean') merged[kind] = { ...(base[kind] || {}), enabled: kinds[kind] };
    next.providers[id] = merged;
  }
  for (const [id, value] of Object.entries(overrides.customProviders || {})) {
    if (typeof value?.enabled === 'boolean') next.customProviders[id] = { ...(next.customProviders[id] || {}), enabled: value.enabled };
  }
  return next;
}

/**
 * 標準的な旧ルートか。プロファイルに手書きされた、カタログと同じ設定のルートを見分ける。
 * 表示名・api・baseURL・apiKeyEnv がカタログ(または旧版)のもので、モデルがカタログにあるものだけなら引き継げる。
 * それ以外のキー(headers, compat, apiKey など)や、別の値があれば、利用者の独自設定なので触らない。
 * @returns {{ listed: string[]|null }|null} listed は旧ルートが列挙していたモデルID(無ければ null)
 */
export function legacyShape(existing, presetRoute) {
  if (!boolObject(existing) || !presetRoute) return null;
  const managed = new Set(['displayName', 'api', 'baseURL', 'apiKeyEnv', 'models']);
  if (Object.keys(existing).some(key => !managed.has(key))) return null;
  const labels = new Set([...Object.values(presetRoute.labels || {}), ...(presetRoute.legacyLabels || [])]);
  if (existing.displayName !== undefined && !labels.has(existing.displayName)) return null;
  if (existing.api !== undefined && existing.api !== presetRoute.api) return null;
  if (existing.baseURL !== undefined && existing.baseURL !== presetRoute.baseURL) return null;
  if (existing.apiKeyEnv !== undefined && existing.apiKeyEnv !== (presetRoute.apiKeyEnv || undefined)) return null;
  let listed = null;
  if (existing.models !== undefined) {
    if (!Array.isArray(existing.models)) return null;
    const known = new Set(presetRoute.models.map(model => model.id));
    if (existing.models.some(model => !boolObject(model) || !known.has(model.id))) return null;
    listed = existing.models.map(model => model.id);
  }
  return { listed };
}

/** 旧ルートが列挙していたモデルを、表示/非表示のフラグに直す(利用者の絞り込みを引き継ぐ)。 */
export function flagsFromListed(listed, presetRoute) {
  if (!Array.isArray(listed) || listed.length === 0) return null;
  const flags = {};
  for (const model of presetRoute.models) {
    const show = listed.includes(model.id);
    if (show !== (model.defaultVisible !== false)) flags[model.id] = show;
  }
  return Object.keys(flags).length ? flags : null;
}

/**
 * 設定画面「モデル」の表示トグル用: ルートごとのモデルと、いま一覧に出るか。
 * 枠が無効・未登録でも、モデルは返す(あとから登録したときの表示を先に決められるように)。
 * registered は { ルートID: true|false }。各グループの registered は、判定できないとき null。
 */
export function buildModelsState(config = {}, locale = 'ja', registered = {}) {
  const registeredOf = routeId => typeof registered[routeId] === 'boolean' ? registered[routeId] : null;
  const groups = [];
  const flagsOf = routeId => config.modelFlags?.[routeId];
  const strip = name => String(name ?? '').replace(/ \(API\)$/, '');
  const userProviders = config.providers || {};
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    for (const kind of ['subscription', 'api']) {
      if (!preset[kind]) continue;
      const routeConfig = (userProviders[id] || {})[kind] || {};
      const routeId = routeConfig.provider || preset[kind].provider;
      const base = liveRoute(preset[kind], config.liveModels?.[routeId]);
      const route = routeConfig.enabled === false ? null : buildProviderRoute(kind, base, routeConfig, locale, flagsOf(routeId));
      const shown = new Set((route?.models || []).map(model => model.id));
      groups.push({
        providerId: id, kind, routeId, service: preset.name, enabled: routeConfig.enabled !== false, registered: registeredOf(routeId),
        label: routeConfig.displayName || base.labels?.[locale] || base.labels?.ja || routeId,
        models: base.models.map(model => ({ id: model.id, name: strip(model.name), visible: shown.has(model.id), default: model.defaultVisible !== false })),
      });
    }
  }
  for (const [id, user] of Object.entries(config.customProviders || {})) {
    const route = user.enabled === false ? null : buildCustomProviderRoute(id, { ...user, modelFlags: flagsOf(id) }, locale);
    const shown = new Set((route?.models || []).map(model => model.id));
    const label = typeof user.displayName === 'object' && user.displayName !== null ? user.displayName[locale] || user.displayName.ja || user.displayName.en || id : user.displayName || id;
    groups.push({ providerId: id, kind: 'api', routeId: id, enabled: user.enabled !== false, registered: registeredOf(id), service: label, label, models: (user.models || []).map(model => ({ id: model.id, name: model.name || model.id, visible: shown.has(model.id), default: model.defaultVisible !== false })) });
  }
  // API 枠は、最後の1つを隠せない(キー入力欄を残すため)。画面でトグルを無効にする目印。
  for (const group of groups) group.lastLocked = group.kind === 'api' && group.models.filter(model => model.visible).length === 1;
  return { locale, groups };
}

/**
 * 枠(ルート)の一覧。登録済みかどうかの判定対象。
 * subscription は OAuth ログイン(保存済み記録)、api は apiKeyEnv の設定有無で判定する。
 */
export function listRouteTargets(config = {}) {
  const targets = []
  const userProviders = config.providers || {}
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    const user = userProviders[id] || {}
    for (const kind of ['subscription', 'api']) {
      const base = preset[kind]
      if (!base) continue
      const routeConfig = user[kind] || {}
      targets.push({ providerId: id, kind, routeId: routeConfig.provider || base.provider, apiKeyEnv: kind === 'api' ? (routeConfig.apiKeyEnv || base.apiKeyEnv || null) : null })
    }
  }
  for (const [id, user] of Object.entries(config.customProviders || {})) targets.push({ providerId: id, kind: 'api', routeId: id, apiKeyEnv: user?.apiKeyEnv || null })
  return targets
}

/**
 * その枠に認証が登録されているか。
 * - subscription: DSH の資格情報に llm-pi-ai/<ルートID> の記録(ログイン結果)がある。
 * - api: apiKeyEnv の値が保存済み、または環境変数にある。キー名のない枠(Ollama 等)は常に登録済み。
 * 資格情報サービスが無い・読めないときは、判定できないので登録済みとして扱う(今までどおり全部表示)。
 */
export async function isRouteRegistered(credentials, target) {
  try {
    if (!credentials) return true
    if (target.kind === 'subscription') {
      if (typeof credentials.describeRecord !== 'function') return true
      return (await credentials.describeRecord('llm-pi-ai/' + target.routeId))?.configured === true
    }
    if (!target.apiKeyEnv) return true
    if (typeof credentials.describe !== 'function') return true
    return (await credentials.describe(target.apiKeyEnv))?.configured === true
  } catch {
    return true
  }
}

/**
 * 設定から、各プロバイダの購読/API枠が有効かを組み立てる。
 * usage-bars はこの状態を読み、モデル登録側で無効なプロバイダのクォータを隠す。
 */
export function buildRouteState(config = {}, locale = 'ja', registered = {}) {
  const routes = {}
  const userProviders = config.providers || {}
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    const user = userProviders[id] || {}
    const record = {}
    for (const kind of ['subscription', 'api']) {
      if (!preset[kind]) { record[kind] = null; continue }
      const routeConfig = user[kind] || {}
      const base = liveRoute(preset[kind], config.liveModels?.[routeConfig.provider || preset[kind].provider])
      const route = routeConfig.enabled === false ? null : buildProviderRoute(kind, base, routeConfig, locale, config.modelFlags?.[routeConfig.provider || base.provider])
      record[kind] = route
        ? { enabled: true, routeId: routeConfig.provider || base.provider, modelCount: route.models.length, registered: registered[routeConfig.provider || base.provider] !== false }
        : { enabled: false, routeId: routeConfig.provider || base.provider, modelCount: 0, registered: registered[routeConfig.provider || base.provider] !== false }
    }
    record.label = preset.name
    routes[id] = record
  }
  for (const [id, user] of Object.entries(config.customProviders || {})) {
    const route = user.enabled === false ? null : buildCustomProviderRoute(id, user, locale)
    const displayName = typeof user.displayName === 'object' && user.displayName !== null
      ? user.displayName[locale] || user.displayName.ja || user.displayName.en || id
      : user.displayName || id
    routes[id] = {
      label: displayName,
      subscription: null,
      api: route ? { enabled: true, routeId: id, modelCount: route.models.length, registered: registered[id] !== false, models: route.models.map(model => ({ id: model.id, name: model.name })) } : { enabled: false, routeId: id, modelCount: 0, registered: registered[id] !== false, models: [] },
    }
  }
  return { locale, routes }
}

/**
 * プラグインのメインエントリー
 */
export function apply(ctx, config = {}) {
  // 1. Node.js 24 互換性パッチを即時適用
  patchAbortSignal();

  // 2. 言語判定
  const locale = resolveLocale(ctx, config.locale);

  // 3. 画面からの有効/無効の上書きを読み、実効設定を作る。
  let overrides = readOverrides();
  // 代替チェーン・追加アカウント・用途別モデル(setup.json)。
  const allowedAccount = routeId => accountCapableRoutes().some(route => route.routeId === routeId);
  // サブスク(OAuth)の複数アカウントを持てるルート: カタログの OAuth 枠(anthropic / openai-codex / xai)。
  const oauthRoutes = () => Object.values(PROVIDER_PRESETS).filter(preset => preset.subscription?.provider).map(preset => ({ routeId: preset.subscription.provider, service: preset.name, label: preset.subscription.labels?.ja || preset.name }));
  const isOauthRoute = routeId => oauthRoutes().some(route => route.routeId === routeId);
  let setup = readSetup();
  setup = { ...setup, accounts: normalizeAccounts(setup.accounts, allowedAccount), oauth: normalizeOauth(setup.oauth, isOauthRoute), agy: normalizeAgy(setup.agy) };
  // Antigravity(他のプラグインに頼らない自前の接続)。アカウントとモデルの表示は setup.json の agy、トークンは資格情報に置く。
  const antigravity = createAntigravity({
    credentials: () => ctx.get?.('credentials'),
    getMeta: () => setup.agy,
    saveMeta: async next => { setup = { ...setup, agy: normalizeAgy(next) }; writeSetup(setup); try { ctx.emit?.('llm/adapters-updated'); } catch {} },
    attachments: () => ctx.get?.('attachments'),
    logger: ctx.logger,
    sort: list => sortModelsNewestFirst(list),
  });
  ctx.effect?.(() => () => antigravity.accounts.dispose(), 'dsh-model-routes: antigravity login');
  const oauthAccounts = createOauthAccounts({
    credentials: () => ctx.get?.('credentials'),
    get: () => setup.oauth,
    save: async next => { setup = { ...setup, oauth: next }; writeSetup(setup); },
  });
  // 起動時などに取得したモデル一覧(ルートID → モデル)。前回の結果を読み、取得できるまで使う。
  let liveModels = readLiveModels();
  const effectiveConfig = () => ({ ...withOverrides(config, overrides), liveModels });
  let effective = effectiveConfig();
  let state = buildRouteState(effective, locale);
  // 直近に判定した登録状態。設定画面のカードとルート一覧に出す。
  let registeredRoutes = {};

  let retryTimer = null;
  let retryCount = 0;
  const scheduleRetry = () => {
    if (retryTimer || retryCount >= 8) return;
    const delay = Math.min(5000, 100 * 2 ** retryCount);
    retryCount += 1;
    retryTimer = setTimeout(() => { retryTimer = null; runSetup(); }, delay);
    retryTimer.unref?.();
  };

  // 4. 設定から各プロバイダ・ルートを構築
  // ログイン済みのサブスク枠だけをモデル一覧に出す(config.registeredOnly: false で従来どおり全部出す)。
  const registeredOnly = config.registeredOnly !== false;
  const lookupRegistered = async (cfg) => {
    const result = {};
    if (!registeredOnly) return result;
    const credentials = ctx.get?.('credentials');
    for (const target of listRouteTargets(cfg)) result[target.routeId] = await isRouteRegistered(credentials, target);
    return result;
  };

  const setupRoutes = async () => {
    effective = effectiveConfig()
    const registered = await lookupRegistered(effective)
    registeredRoutes = registered
    state = buildRouteState(effective, locale, registered)
    const piAiEntry = findLlmpiAi(ctx.loader);
    if (!piAiEntry) {
      if (retryCount === 0) ctx.logger?.warn?.('dsh-model-routes: llm-pi-ai エントリが見つからず、再試行します');
      scheduleRetry();
      return;
    }
    retryCount = 0;

    const currentConfig = piAiEntry.options?.config || {};
    const providers = { ...(currentConfig.providers || {}) };
    let owned = { ...(overrides.owned || {}) };
    let manual = { ...(overrides.manual || {}) };
    let modelFlags = { ...(overrides.models || {}) };
    let ownedChanged = false;
    /**
     * ルートを作る/更新する/引き継ぐ。
     * @param build(flags) 候補ルートを作る関数(モデルの表示/非表示フラグを渡す)
     * @param presetRoute カタログの枠(標準的な旧ルートの判定に使う)。カスタム枠は省略
     * @param wanted false なら、このプラグインのルートは設定から外す(ログインしていないサブスク枠)
     */
    const keepOrCreate = (routeId, build, labels = [], presetRoute, wanted = true) => {
      const candidateOf = () => (wanted ? build(modelFlags[routeId]) : null);
      const existing = providers[routeId];
      if (!existing) {
        const candidate = candidateOf();
        if (candidate) {
          providers[routeId] = candidate;
          owned[routeId] = fingerprint(candidate);
          delete manual[routeId];
          ownedChanged = true;
        }
        return;
      }
      // プロファイルに手書きされた標準的なルート(旧版の設定など)は、プラグインが引き継ぐ。
      // 旧ルートがモデルを絞っていたら、その選択を表示トグルのフラグとして残す。
      // 引き継いだあとも、DSH が設定を読み直す(プロファイルの編集・起動直後)と手書きの内容に戻るため、
      // 前回書いた内容と違っても、標準的な形なら手動の書き換えとはみなさず引き継ぎ直す。
      if (presetRoute && owned[routeId] !== fingerprint(existing)) {
        const legacy = legacyShape(existing, presetRoute);
        if (legacy) {
          const before = JSON.stringify([owned[routeId], manual[routeId], modelFlags[routeId]]);
          const flags = flagsFromListed(legacy.listed, presetRoute);
          if (flags && !modelFlags[routeId]) modelFlags[routeId] = flags;
          const candidate = candidateOf();
          if (candidate) {
            providers[routeId] = candidate;
            owned[routeId] = fingerprint(candidate);
          } else delete providers[routeId];
          delete manual[routeId];
          // 読み直しのたびの引き継ぎ直しでは、記録が変わらなければ保存しない。
          if (JSON.stringify([owned[routeId], manual[routeId], modelFlags[routeId]]) !== before) ownedChanged = true;
          return;
        }
      }
      if (manual[routeId]) return;
      if (owned[routeId]) {
        // 前回の内容と違えば、利用者が手動で書き換えたものとして以後触らない。
        if (owned[routeId] !== true && owned[routeId] !== fingerprint(existing)) {
          delete owned[routeId];
          manual[routeId] = true;
          ownedChanged = true;
          return;
        }
        const candidate = candidateOf();
        if (candidate) {
          providers[routeId] = candidate;
          owned[routeId] = fingerprint(candidate);
        } else {
          delete providers[routeId];
          delete owned[routeId];
        }
        ownedChanged = true;
        return;
      }
      // 旧版や手動設定のルートを、内容・ラベル・空モデルから所有ルートとして引き継ぐ。
      // 独自の apiKey / headers を持つルートは、認証を壊さないよう手動扱いにする。
      const candidate = candidateOf();
      const hasCustomAuth = Object.hasOwn(existing, 'apiKey') || Object.hasOwn(existing, 'headers');
      const adopt = !hasCustomAuth && ((candidate && isDeepStrictEqual(existing, candidate))
        || (Array.isArray(existing.models) && existing.models.length === 0)
        || (typeof existing.displayName === 'string' && labels.includes(existing.displayName)));
      if (adopt && candidate) {
        providers[routeId] = candidate;
        owned[routeId] = fingerprint(candidate);
        ownedChanged = true;
      }
    };
    // 設定で無効にされたルートは、所有権に関係なくメモリ上から外す。
    // placeholder を渡した枠(API 枠・カスタム枠)は、モデル0件のルートとして残す。設定画面のカードが消えず、
    // オフのまま表示してスイッチで戻せるようにするため。OAuth 枠はカードを持たない(API 枠にまとめる)ので外す。
    const disableRoute = (routeId, placeholder) => {
      if (placeholder) {
        if (!isDeepStrictEqual(providers[routeId], placeholder)) { providers[routeId] = placeholder; ownedChanged = true; }
        const mark = fingerprint(placeholder);
        if (owned[routeId] !== mark) { owned[routeId] = mark; ownedChanged = true; }
        if (manual[routeId]) { delete manual[routeId]; ownedChanged = true; }
        return;
      }
      if (providers[routeId]) { delete providers[routeId]; ownedChanged = true; }
      if (owned[routeId]) { delete owned[routeId]; ownedChanged = true; }
    };
    // オフの枠の置き場所: 有効なときと同じ表示名・接続先・キー名で、モデルだけ0件。
    const emptied = route => route ? { ...route, models: [] } : null;

    // ログインしていないサブスク枠は、このプラグインが作ったルートだけ設定から外す(keepOrCreate の wanted)。
    // API 枠は外さない: 設定画面のキー入力欄が消えてしまう。DSH はキー未登録の API ルートのモデルを自動で空にする。
    // プロファイルに手書きされたルートのうち、標準的なものは引き継ぎ、独自設定のものは触らない。

    // --- A. プリセット対象プロバイダ（Claude, OpenAI, Gemini, Grok, OpenCode, CommandCode 等） ---
    const userProviders = effective.providers || {};

    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      const userProv = userProviders[key] || {};

      // サブスク枠
      if (preset.subscription) {
        const subConfig = userProv.subscription || {};
        const subRouteId = subConfig.provider || preset.subscription.provider;

        if (subConfig.enabled === false) disableRoute(subRouteId);
        else {
          const subBase = liveRoute(preset.subscription, effective.liveModels?.[subRouteId]);
          keepOrCreate(subRouteId, flags => buildProviderRoute('subscription', subBase, subConfig, locale, flags), [...Object.values(preset.subscription.labels || {}), ...(preset.subscription.legacyLabels || [])], subBase, registered[subRouteId] !== false);
        }
      }

      // API枠
      if (preset.api) {
        const apiConfig = userProv.api || {};
        const apiRouteId = apiConfig.provider || preset.api.provider;

        if (apiConfig.enabled === false) disableRoute(apiRouteId, emptied(buildProviderRoute('api', preset.api, { ...apiConfig, enabled: true }, locale)));
        else {
          const apiBase = liveRoute(preset.api, effective.liveModels?.[apiRouteId]);
          keepOrCreate(apiRouteId, flags => buildProviderRoute('api', apiBase, apiConfig, locale, flags), [...Object.values(preset.api.labels || {}), ...(preset.api.legacyLabels || [])], apiBase);
        }
        // 追加アカウント(#2, #3 …): 同じ接続先・同じモデルの表示で、キー名だけ番号付きの別ルート。
        // モデル選択で「Claude」と「Claude #2」を選び分けられ(手動の切り替え)、代替チェーンはこれを順に試す。
        for (const n of setup.accounts[apiRouteId] || []) {
          if (!preset.api.api) break;
          const altId = accountRouteId(apiRouteId, n);
          const label = (apiConfig.displayName || preset.api.labels?.[locale] || preset.name) + ' #' + n;
          const altConfig = { ...apiConfig, displayName: label, apiKeyEnv: accountKeyEnv(apiConfig.apiKeyEnv || preset.api.apiKeyEnv, n) };
          if (apiConfig.enabled === false) disableRoute(altId, emptied(buildProviderRoute('api', preset.api, { ...altConfig, enabled: true }, locale)));
          else {
            const altBase = liveRoute(preset.api, effective.liveModels?.[apiRouteId]);
            keepOrCreate(altId, () => buildProviderRoute('api', altBase, altConfig, locale, modelFlags[apiRouteId]), [label]);
          }
        }
      }
    }

    // --- B. 公式にない任意カスタムプロバイダ (customProviders) ---
    const customProviders = effective.customProviders || {};
    for (const [providerId, userCustomConfig] of Object.entries(customProviders)) {
      if (userCustomConfig.enabled === false) disableRoute(providerId, emptied(buildCustomProviderRoute(providerId, { ...userCustomConfig, enabled: true }, locale)));
      else keepOrCreate(providerId, flags => buildCustomProviderRoute(providerId, { ...userCustomConfig, modelFlags: flags }, locale), [userCustomConfig.displayName].filter(value => typeof value === 'string'));
    }

    // カタログから外れた旧ルート(例: opencode-api)を後始末する。
    // 自分が作った内容のままなら外し、利用者が書き換えていたら触らず記録だけ消す。
    const knownRouteIds = new Set(Object.keys(customProviders));
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      const userProv = userProviders[key] || {};
      for (const kind of ['subscription', 'api']) if (preset[kind]) knownRouteIds.add(userProv[kind]?.provider || preset[kind].provider);
    }
    for (const [routeId, numbers] of Object.entries(setup.accounts)) for (const n of numbers) knownRouteIds.add(accountRouteId(routeId, n));
    for (const [routeId, mark] of Object.entries(owned)) {
      if (knownRouteIds.has(routeId)) continue;
      const existing = providers[routeId];
      if (existing && (mark === true || mark === fingerprint(existing))) delete providers[routeId];
      delete owned[routeId];
      ownedChanged = true;
    }

    // 所有権の記録は、ルートを変更する前に保存する。
    if (ownedChanged) {
      const next = { ...overrides, owned, manual, models: modelFlags };
      writeOverrides(next);
      overrides = next;
    }
    if (!isDeepStrictEqual(providers, currentConfig.providers || {})) {
      try {
        // Entry.update は呼び出し時点の options を「変更前」として比較する。
        // 先に options を書き換えると差分なしで無視されるため、新しい値だけを渡す。
        await piAiEntry.update({ config: { ...currentConfig, providers } });
        ctx.logger?.info?.(`dsh-model-routes [${locale}]: updated LLM routes successfully (providers: ${Object.keys(providers).join(', ')})`);
      } catch (err) {
        ctx.logger?.error?.('dsh-model-routes: failed to update routes in llm-pi-ai:', err);
        throw err;
      }
    }
  };

  // 設定の組み立てを直列化する(ログイン直後のイベントと切り替えが重なっても競合しない)。
  let chain = Promise.resolve();
  const queued = fn => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };

  // 他プラグイン(usage-bars)が読むルート状態と、画面からの切り替え口。
  const routesService = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    async setRouteEnabled(providerId, kind, enabled) {
      if (typeof providerId !== 'string' || !providerId) throw new TypeError('プロバイダIDが不正です');
      if (kind !== 'subscription' && kind !== 'api') throw new TypeError('枠は subscription か api を指定してください');
      if (typeof enabled !== 'boolean') throw new TypeError('有効/無効は真偽値で指定してください');
      let next;
      const entry = findLlmpiAi(ctx.loader);
      const preset = PROVIDER_PRESETS[providerId];
      const current = withOverrides(config, overrides).providers?.[providerId]?.[kind];
      const routeId = preset ? (current?.provider || (kind === 'subscription' ? preset.subscription?.provider : preset.api?.provider)) : providerId;
      {
        const existing = routeId === undefined ? undefined : entry?.options?.config?.providers?.[routeId];
        if ((existing && !overrides.owned?.[routeId]) || overrides.manual?.[routeId]) throw new TypeError('このルートは手動設定のため切り替えできません');
      }
      if (!enabled && routeId !== undefined) {
        // Models 画面が生成ルートを設定ファイルへ書き出していても、次回起動で復活しないよう消す。
        try { await ctx.get?.('settings')?.mutate?.('llm-pi-ai', [{ op: 'unset', path: ['providers', routeId] }]) } catch (error) {
          ctx.logger?.warn?.('dsh-model-routes: 設定ファイルからルートを消せませんでした', error);
        }
      }
      if (Object.hasOwn(PROVIDER_PRESETS, providerId)) {
        if (!PROVIDER_PRESETS[providerId][kind]) throw new TypeError('そのプロバイダに指定した枠はありません');
          next = { ...overrides, providers: { ...overrides.providers, [providerId]: { ...overrides.providers[providerId], [kind]: enabled } } };
      } else if (Object.hasOwn(config.customProviders || {}, providerId)) {
        if (kind !== 'api') throw new TypeError('カスタムプロバイダは api 枠だけ切り替えられます');
        next = { ...overrides, customProviders: { ...overrides.customProviders, [providerId]: { enabled } } };
      } else {
        throw new TypeError('未知のプロバイダIDです');
      }
      writeOverrides(next);
      overrides = next;
      await queued(setupRoutes);
      return JSON.parse(JSON.stringify(state));
    },
  };
  ctx.provide('modelRoutes', routesService);

  // サブスク(OAuth)枠のログイン操作。設定画面のカードから DSH の内部通信(Typert)で呼ぶ。
  const authService = createAuthService({
    authorization: () => ctx.get?.('authorization'),
    credentials: () => ctx.get?.('credentials'),
    targets: () => listRouteTargets(effective).filter(target => target.kind === 'subscription').map(target => ({
      providerId: target.providerId, routeId: target.routeId, label: PROVIDER_PRESETS[target.providerId]?.name || target.providerId,
    })),
    logger: ctx.logger,
    messages: createMessages(() => resolveLocale(ctx, config.locale)),
  });
  ctx.provide('modelRoutesAuth', authService);
  // モデルごとの表示トグル。画面で決めた表示/非表示は overrides.json の models に保存し、すぐ反映する。
  const changeFlags = async (routeId, mutate) => {
    const models = { ...(overrides.models || {}) };
    const next = { ...(models[routeId] || {}) };
    mutate(next);
    if (Object.keys(next).length) models[routeId] = next; else delete models[routeId];
    const saved = { ...overrides, models };
    writeOverrides(saved);
    overrides = saved;
    await queued(setupRoutes);
  };
  const modelsService = createModelsService({
    state: () => buildModelsState(effectiveConfig(), locale, registeredRoutes),
    setRoute: (providerId, kind, enabled) => routesService.setRouteEnabled(providerId, kind, enabled),
    setFlag: (routeId, modelId, visible) => changeFlags(routeId, flags => { flags[modelId] = visible; }),
    reset: routeId => changeFlags(routeId, flags => { for (const key of Object.keys(flags)) delete flags[key]; }),
    messages: createMessages(() => resolveLocale(ctx, config.locale)),
  });
  ctx.provide('modelRoutesModels', modelsService);

  // ── 代替チェーン(仮想プロバイダ model-routes) ──
  // 直近の応答: { チェーンID: { provider, model, tried, at } }。設定画面で、どれが答えたかを示す。
  const chainResults = {};
  ctx.inject?.(['llm'], llmCtx => {
    llmCtx.effect(async () => {
      // DSH の基底クラスを使う。プラグインの置き場所(プロファイルの外)からは読み込めないことがあるため、
      // そのときは同じ既定の動きを持つ自前の基底を使う(登録側は型を確かめない)。
      let LlmAdapter = AdapterBase;
      try { ({ LlmAdapter } = await import('@deepseek-ai/dsh-llm')); } catch {}
      const adapter = createChainAdapter(LlmAdapter, {
        llm: llmCtx.llm,
        setup: () => setup,
        // サブスクは、使用中以外でログイン済みのアカウントへ入れ替えて試す。入れ替えたまま使い続ける(次の要求も同じアカウント)。
        oauthOthers: async provider => isOauthRoute(provider) ? oauthAccounts.others(provider) : [],
        switchAccount: async (provider, n) => { await oauthAccounts.switchTo(provider, n); await queued(setupRoutes); },
        onResult: (chainId, result) => {
          chainResults[chainId] = { ...result, at: new Date().toISOString() };
          if (result.tried.length) llmCtx.logger?.info?.(`dsh-model-routes: 代替チェーン ${chainId}: ${result.tried.map(item => item.provider + '/' + item.model + '=' + item.code).join(', ')} → ${result.provider ? result.provider + '/' + result.model : '全滅'}`);
        },
      });
      const registration = llmCtx.llm.registerAdapter([CHAIN_PROVIDER], adapter);
      const agyRegistration = llmCtx.llm.registerAdapter([AGY_PROVIDER], antigravity.createAdapter(LlmAdapter));
      return () => { registration(); agyRegistration(); };
    }, 'dsh-model-routes: chain adapter');
  });
  const notifyModels = () => { try { ctx.emit?.('llm/adapters-updated'); } catch {} };
  const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.())]);
  // 画面の選択肢: 登録されている全プロバイダとモデル(代替チェーン自身は除く)。
  const catalog = async () => {
    const llm = ctx.get?.('llm');
    if (!llm?.listProviders) return [];
    const result = [];
    for (const info of llm.listProviders()) {
      if (info.id === CHAIN_PROVIDER) continue;
      let models = [];
      try { models = (await withTimeout(llm.listModels(info.id), 8000)).map(model => ({ id: model.id, name: model.name || model.id })); } catch {}
      if (models.length) result.push({ provider: info.id, name: info.name || info.id, models: sortModelsNewestFirst(models) });
    }
    return result;
  };
  const setupState = async () => {
    const credentials = ctx.get?.('credentials');
    const known = async env => { try { return (await credentials?.describe?.(env))?.configured === true; } catch { return null; } };
    const accounts = [];
    for (const route of accountCapableRoutes()) {
      const list = [{ n: 1, routeId: route.routeId, label: route.label, keyEnv: route.apiKeyEnv, registered: await known(route.apiKeyEnv) }];
      for (const n of setup.accounts[route.routeId] || []) list.push({ n, routeId: accountRouteId(route.routeId, n), label: route.label + ' #' + n, keyEnv: accountKeyEnv(route.apiKeyEnv, n), registered: await known(accountKeyEnv(route.apiKeyEnv, n)) });
      accounts.push({ ...route, accounts: list });
    }
    const oauth = [];
    for (const route of oauthRoutes()) { try { oauth.push({ ...route, ...(await oauthAccounts.describe(route.routeId)) }); } catch (error) { oauth.push({ ...route, error: error?.message ?? String(error), accounts: [] }); } }
    return plainJson({ chains: setup.chains, accounts, oauth, media: setup.media, mediaKinds: MEDIA_KINDS, catalog: await catalog(), results: chainResults, chainProvider: CHAIN_PROVIDER });
  };
  const agyState = async () => {
    const hidden = new Set(setup.agy.hidden);
    let models = [];
    try { models = sortModelsNewestFirst((await antigravity.models.all()).map(model => ({ id: model.id, name: model.name || model.id, hidden: hidden.has(model.id) }))); } catch {}
    return plainJson({ accounts: await antigravity.accounts.list(), login: antigravity.accounts.loginState(), models });
  };
  const saveSetup = async next => {
    setup = next;
    writeSetup(setup);
  };
  const setupService = {
    async getSetup() { return setupState(); },
    async saveChains(value) {
      await saveSetup({ ...setup, chains: normalizeChains(value?.chains) });
      notifyModels();
      return setupState();
    },
    async saveMedia(value) {
      await saveSetup({ ...setup, media: normalizeMedia(value?.media) });
      return setupState();
    },
    // Antigravity: アカウント・ログインの状態・モデル(表示/非表示)。
    async agyState() { return agyState(); },
    async agyAction(value) {
      const n = Number(value?.n);
      switch (value?.action) {
        case 'login': await antigravity.accounts.startLogin(); break;
        case 'cancel': antigravity.accounts.cancelLogin(); break;
        case 'switch': await antigravity.accounts.switchTo(n); break;
        case 'remove': await antigravity.accounts.remove(n); break;
        case 'hide': case 'show': if (typeof value?.modelId !== 'string') throw new TypeError('モデルIDが不正です'); await antigravity.accounts.setHidden(value.modelId, value.action === 'hide'); break;
        case 'setEnabled': await antigravity.accounts.setEnabled(value?.enabled !== false); break;
        default: throw new TypeError('操作が不正です');
      }
      notifyModels();
      return agyState();
    },
    // サブスク(OAuth)の複数アカウント: add / switch / remove / rename。
    async oauthAction(value) {
      const routeId = value?.routeId;
      if (!isOauthRoute(routeId)) throw new TypeError('このサービスにはサブスクの複数アカウントを作れません');
      const n = Number(value?.n);
      if (value?.action === 'add') await oauthAccounts.add(routeId);
      else if (value?.action === 'switch') await oauthAccounts.switchTo(routeId, n);
      else if (value?.action === 'remove') await oauthAccounts.remove(routeId, n);
      else if (value?.action === 'rename') await oauthAccounts.rename(routeId, n, value?.label);
      else throw new TypeError('操作が不正です');
      await queued(setupRoutes);
      notifyModels();
      return setupState();
    },
    async addAccount(routeId) {
      if (!allowedAccount(routeId)) throw new TypeError('このサービスには追加アカウントを作れません');
      const used = setup.accounts[routeId] || [];
      const n = [2, 3, 4, 5, 6, 7, 8, 9].find(value => !used.includes(value));
      if (!n) throw new TypeError('追加アカウントは 9 個までです');
      await saveSetup({ ...setup, accounts: { ...setup.accounts, [routeId]: [...used, n].sort((a, b) => a - b) } });
      await queued(setupRoutes);
      notifyModels();
      return setupState();
    },
    async removeAccount(accountId) {
      const match = /^(.*)-(\d)$/.exec(String(accountId));
      if (!match || !setup.accounts[match[1]]?.includes(Number(match[2]))) throw new TypeError('その追加アカウントはありません');
      const rest = setup.accounts[match[1]].filter(n => n !== Number(match[2]));
      const accounts = { ...setup.accounts };
      if (rest.length) accounts[match[1]] = rest; else delete accounts[match[1]];
      // 設定ファイルに書き出されていても次回起動で戻らないよう消す(キーそのものは消さない)。
      try { await ctx.get?.('settings')?.mutate?.('llm-pi-ai', [{ op: 'unset', path: ['providers', accountId] }]); } catch {}
      await saveSetup({ ...setup, accounts });
      await queued(setupRoutes);
      notifyModels();
      return setupState();
    },
  };
  Object.defineProperty(setupService, 'typertRemote', { value: { service: setupService, serviceKey: 'modelRoutesSetup', namespace: 'modelRoutesSetup' } });
  ctx.provide('modelRoutesSetup', setupService);
  ctx.effect?.(() => () => authService.dispose(), 'dsh-model-routes: auth service');
  // パッケージ導入時は typert-loader が検出する。file: の直接導入時だけ自前で登録する。
  ctx.inject?.(['typert'], typertCtx => {
    const registry = typertCtx.typert;
    if (!registry.getPackage(TYPERT.package, 'host') && ctx.fiber?.entry?.options.name?.startsWith('file:')) {
      const unregister = registry.register(TYPERT);
      if (typeof unregister === 'function') typertCtx.effect(() => unregister, 'dsh-model-routes: typert manifest');
    }
  });

  const runSetup = () => queued(setupRoutes).catch(error => ctx.logger?.error?.('dsh-model-routes: failed to apply routes:', error));
  ctx.effect?.(() => () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; }, 'dsh-model-routes: retry timer');
  runSetup();
  // 提供モデルの取得: 起動時と、その後 12 時間ごと。一覧が変わったときだけ保存して、ルートを組み直す。
  const refreshLiveModels = async () => {
    wrapDiscovery();
    // テストなど、外部へ問い合わせたくない環境では取得しない(前回の控えは使う)。
    if (process.env.DSH_MODEL_ROUTES_NO_DISCOVERY) return;
    const next = { ...liveModels };
    let changed = false;
    for (const preset of Object.values(PROVIDER_PRESETS)) for (const kind of ['subscription', 'api']) {
      const base = preset[kind];
      if (!base?.discovery) continue;
      try {
        const models = await discoverRouteModels(base, { llm: ctx.get?.('llm') });
        if (models.length && !isDeepStrictEqual(models, next[base.provider])) { next[base.provider] = models; changed = true; }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-model-routes: ${preset.name} のモデル一覧を取得できません(前回の一覧を使います)`, error);
        continue;
      }
    }
    if (!changed) return;
    liveModels = next;
    try { writeLiveModels(next); } catch (error) { ctx.logger?.warn?.('dsh-model-routes: モデル一覧の控えを保存できません', error); }
    await runSetup();
  };
  // DSH 標準の「利用可能なモデルを取得」の結果を、このプラグインのルートについてだけ整える。
  // DSH はプラグイン外のルート(独自の接続先)を接続先の返した順で出すため、OpenAI などでは
  // 音声・判定用のモデルが混ざり、並びもばらばらになる。llm サービスの discoverModels を包み、
  // 会話に使えないものを外して新しい順に並べる。DSH 本体は変えず、外すときに元へ戻す。
  const managedRoute = routeId => {
    if (typeof routeId !== 'string') return false;
    if (Object.hasOwn(config.customProviders || {}, routeId)) return true;
    return Object.values(PROVIDER_PRESETS).some(preset => preset.api?.provider === routeId || preset.subscription?.provider === routeId);
  };
  let wrappedLlm = null;
  let originalDiscover = null;
  const wrapDiscovery = () => {
    const llm = ctx.get?.('llm');
    if (!llm || wrappedLlm === llm || typeof llm.discoverModels !== 'function') return;
    const original = llm.discoverModels;
    llm.discoverModels = async function discoverModels(settingsNs, request, signal) {
      const listed = await original.call(this, settingsNs, request, signal);
      if (!managedRoute(request?.provider) || !Array.isArray(listed)) return listed;
      return sortModelsNewestFirst(listed.filter(model => isChatModel(model?.id)));
    };
    wrappedLlm = llm;
    originalDiscover = original;
  };
  ctx.effect?.(() => () => {
    if (wrappedLlm && originalDiscover) { if (wrappedLlm.discoverModels !== originalDiscover) delete wrappedLlm.discoverModels; if (wrappedLlm.discoverModels !== originalDiscover) wrappedLlm.discoverModels = originalDiscover; }
    wrappedLlm = null; originalDiscover = null;
  }, 'dsh-model-routes: discovery order');
  wrapDiscovery();

  // 起動直後は llm サービスがまだ無いことがあるため、少し待ってから1回、ready でもう1回取得する。
  const liveTimer = setTimeout(() => { refreshLiveModels().catch(() => {}) }, 3000);
  liveTimer.unref?.();
  const liveInterval = setInterval(() => { refreshLiveModels().catch(() => {}) }, 12 * 60 * 60 * 1000);
  liveInterval.unref?.();
  ctx.effect?.(() => () => { clearTimeout(liveTimer); clearInterval(liveInterval); }, 'dsh-model-routes: live models');
  ctx.on('ready', () => { refreshLiveModels().catch(() => {}); return runSetup(); });
  ctx.on('app-boot/config-reload', runSetup);
  // ログインや API キーの登録・削除をすぐモデル一覧へ反映する。
  // ログインの変化をモデル一覧へ反映し、トークンの自動更新や新しいログインを、使用中アカウントの保管先へ写す。
  ctx.on('credentials/record-updated', () => {
    oauthAccounts.syncAll().catch(error => ctx.logger?.warn?.('dsh-model-routes: サブスクのログインを保管できません', error));
    return runSetup();
  });
  ctx.on('credentials/reference-updated', runSetup);
}
