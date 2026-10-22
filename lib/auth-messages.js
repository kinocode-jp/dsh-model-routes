// ログイン用ホストサービスのメッセージ(ja / en / zh)。画面に出るエラー文はここから返す。
// pi-ai や OAuth サーバーが返すエラー(invalid_grant など)は、そのまま表示する。
export const AUTH_MESSAGES = {
  ja: {
    unknownRoute: '未知のサブスク枠です',
    stopped: 'サービスは停止しています',
    noAuthService: 'DSH の認証サービスが見つかりません',
    noOauth: 'このサービスにはOAuthログインがありません',
    busy: '別のログインが進行中です。先に取り消してください',
    promptSuperseded: '新しい入力が求められたため取り消しました',
    promptNotNeeded: '入力は不要になりました',
    promptRejected: 'この入力は受け付けていません(期限切れまたは取り消し済み)',
    cancelled: '取り消しました',
    logoutBusy: 'ログイン中は削除できません。先に取り消してください',
    noCredentials: 'DSH の資格情報サービスが見つかりません',
    loginFailed: 'ログインに失敗しました: {message}',
    unknownModel: '未知のモデルです',
    lastModel: 'キー入力欄を残すため、API 枠のモデルは少なくとも1つ表示してください',
  },
  en: {
    unknownRoute: 'Unknown subscription route',
    stopped: 'The service has stopped',
    noAuthService: 'The DSH authorization service was not found',
    noOauth: 'This service has no OAuth sign-in',
    busy: 'Another sign-in is in progress. Cancel it first',
    promptSuperseded: 'Cancelled because a newer prompt was requested',
    promptNotNeeded: 'The prompt is no longer needed',
    promptRejected: 'This input is not accepted (expired or already cancelled)',
    cancelled: 'Cancelled',
    logoutBusy: 'Cannot remove while signing in. Cancel the sign-in first',
    noCredentials: 'The DSH credentials service was not found',
    loginFailed: 'Sign-in failed: {message}',
    unknownModel: 'Unknown model',
    lastModel: 'Keep at least one API model visible so the key field stays available',
  },
  zh: {
    unknownRoute: '未知的订阅渠道',
    stopped: '服务已停止',
    noAuthService: '未找到 DSH 的授权服务',
    noOauth: '该服务没有 OAuth 登录',
    busy: '另一个登录正在进行,请先取消',
    promptSuperseded: '因出现新的输入请求而取消',
    promptNotNeeded: '不再需要该输入',
    promptRejected: '该输入不被接受(已过期或已取消)',
    cancelled: '已取消',
    logoutBusy: '登录进行中,无法删除。请先取消登录',
    noCredentials: '未找到 DSH 的凭据服务',
    loginFailed: '登录失败: {message}',
    unknownModel: '未知的模型',
    lastModel: 'API 渠道至少要显示一个模型,以保留密钥输入框',
  },
}

/** 言語を返す関数から、翻訳関数 messages(key, params) を作る。未知の言語は ja。 */
export function createMessages(getLocale = () => 'ja') {
  return (key, params) => {
    let locale = 'ja'
    try { const value = getLocale(); if (AUTH_MESSAGES[value]) locale = value } catch {}
    const template = AUTH_MESSAGES[locale][key] ?? AUTH_MESSAGES.ja[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : template
  }
}
