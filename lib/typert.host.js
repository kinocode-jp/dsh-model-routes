import { recordSchema, nullableRecordSchema, routeIdSchema, promptIdSchema, answerSchema, modelIdSchema, visibleSchema } from './auth-contracts.js'

const pkg = '@kinocode/dsh-model-routes'
const strictCodec = (name, schema) => ({ mode: 'strict', typeSymbol: pkg + '#' + name, schema, create: () => schema })
const routeParam = ['routeId', 'RouteId', routeIdSchema]
// [メソッド, 結果名, 結果スキーマ, 引数[[名前, 型名, スキーマ]], 説明]
const SERVICES = [
  {
    key: 'modelRoutesAuth', exportName: 'ModelRoutesAuthService',
    description: 'OAuth 枠のログイン操作。', summary: 'モデル登録のログイン用ホストサービス。',
    jsDoc: '/** モデル登録のログイン用ホストサービス(ctx.modelRoutesAuth)。 */',
    methods: [
      ['getAuthState', 'AuthState', recordSchema, [], 'OAuth 枠ごとのログイン状態と、進行中のログインを返す。'],
      ['startLogin', 'Attempt', recordSchema, [routeParam], '指定した OAuth 枠のログインを開始する。'],
      ['getAttempt', 'MaybeAttempt', nullableRecordSchema, [], '進行中(または直近)のログインの状態を返す。'],
      ['answerPrompt', 'Attempt', recordSchema, [['promptId', 'PromptId', promptIdSchema], ['value', 'Answer', answerSchema]], 'ログイン中に求められた入力(認証コードなど)を渡す。'],
      ['cancelLogin', 'MaybeAttempt', nullableRecordSchema, [], '進行中のログインを取り消す。'],
      ['dismissAttempt', 'AuthState', recordSchema, [], '終了したログインの表示を消す。'],
      ['logout', 'AuthState', recordSchema, [routeParam], '指定した OAuth 枠の保存済みログインを削除する。'],
    ],
  },
  {
    key: 'modelRoutesModels', exportName: 'ModelRoutesModelsService',
    description: 'モデルごとの、モデル一覧への表示/非表示。', summary: 'モデル登録の表示トグル用ホストサービス。',
    jsDoc: '/** モデル登録の表示トグル用ホストサービス(ctx.modelRoutesModels)。 */',
    methods: [
      ['setRouteEnabled', 'Models', recordSchema, [routeParam, ['enabled', 'Enabled', visibleSchema]], '指定したルートを有効/無効にする。'],
      ['getModels', 'Models', recordSchema, [], 'ルートごとのモデルと、いまモデル一覧に出るかを返す。'],
      ['setModelVisible', 'Models', recordSchema, [routeParam, ['modelId', 'ModelId', modelIdSchema], ['visible', 'Visible', visibleSchema]], '指定したモデルの表示/非表示を保存して反映する。'],
      ['resetModels', 'Models', recordSchema, [routeParam], '指定したルートのモデルの表示を既定に戻す。'],
    ],
  },
  {
    key: 'modelRoutesSetup', exportName: 'ModelRoutesSetupService',
    description: '代替チェーン・追加アカウント・用途別モデルの設定。', summary: 'モデルルート設定画面用ホストサービス。',
    jsDoc: '/** モデルルート設定画面用ホストサービス(ctx.modelRoutesSetup)。 */',
    methods: [
      ['getSetup', 'Setup', recordSchema, [], '代替チェーン・追加アカウント・用途別モデルと、選べるモデルの一覧を返す。'],
      ['saveChains', 'Setup', recordSchema, [['value', 'Chains', recordSchema]], '代替チェーンを保存する({ chains: [...] })。'],
      ['saveMedia', 'Setup', recordSchema, [['value', 'Media', recordSchema]], '用途別モデルを保存する({ media: {...} })。'],
      ['reloadMediaModels', 'Setup', recordSchema, [], '用途別の候補(提供元のモデル一覧)を取り直して返す。'],
      ['addAccount', 'Setup', recordSchema, [routeParam], 'API 枠に追加アカウント(#2 …)を作る。'],
      ['removeAccount', 'Setup', recordSchema, [['accountId', 'AccountId', routeIdSchema]], '追加アカウントを外す(保存済みのキーは消さない)。'],
      ['oauthAction', 'Setup', recordSchema, [['value', 'OauthAction', recordSchema]], 'サブスクの複数アカウントを操作する({ action: add|switch|remove|rename, routeId, n, label })。'],
      ['agyState', 'AgyState', recordSchema, [], 'Antigravity のアカウント・ログインの状態・モデル(表示/非表示)を返す。'],
      ['agyAction', 'AgyState', recordSchema, [['value', 'AgyAction', recordSchema]], 'Antigravity を操作する({ action: login|cancel|switch|remove|hide|show|setEnabled|resetUnusable, n, modelId, enabled })。'],
    ],
  },
]
export const TYPERT = {
  package: pkg,
  face: 'host',
  schemas: [],
  invocations: SERVICES.flatMap(service => service.methods.map(([method, resultName, resultSchema, params]) => ({
    id: pkg + '#' + service.key + '/' + method,
    service: service.key, namespace: service.key, method,
    invocation: { kind: 'direct' },
    parameters: params.map(([name, type, schema]) => ({ name, wire: name, source: 'json', codec: strictCodec(type, schema) })),
    result: strictCodec(resultName, resultSchema),
  }))),
  model: {
    services: SERVICES.map(service => ({
      key: service.key, exportName: service.exportName, tags: [], types: [],
      description: service.description, summary: service.summary, jsDoc: service.jsDoc,
      members: service.methods.map(([method, , , params, summary]) => ({
        kind: 'method', name: method,
        signature: method + '(' + params.map(([name, , schema]) => name + ': ' + (schema === visibleSchema ? 'boolean' : schema === recordSchema ? 'object' : 'string')).join(', ') + '): Promise<object>',
        summary,
      })),
    })), events: [], objects: [],
  },
}
