// ブラウザ側:
//  (1) モデル選択のモデル名に「サブスク」「API」のバッジを付ける。
//  (2) 設定のモデル画面で、Claude 等を1行にし、その中でサブスク(OAuth)のログインもできるようにする。
//  (3) 既存のモデル画面のフッターで、ルート全体の有効・無効を切り替える。
// 文言は ja / en / zh の辞書を DSH の locale サービス(ctx.locale)へ登録し、言語の切り替えに追従する。
// 見た目は DSH のモデル設定ページと同じデザイントークン(--dsw-alias-*)と寸法に合わせる。
window.__ModuleLoader__.load({
  id: '@kinocode/dsh-model-routes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { createElement: el, useState, useEffect, useRef } = React
    // DSH 標準の部品(Switch)。取得できない環境では、同じ見た目の簡易スイッチで代用する。
    let primitives = null
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch { primitives = null }

    // ───────────── 辞書 ─────────────
    const NS = 'model-routes'
    const DICT = {
      ja: {
        'routes.enable': '{name} を有効にする',
        'status.api': 'API キー', 'status.oauth': 'OAuth',
        'status.keySet': '登録済み', 'status.keyMissing': '未登録',
        'status.loggedIn': 'ログイン済み', 'status.notLoggedIn': '未ログイン',
        'status.disabled': 'オフ', 'status.unknown': '確認中',
        'status.unusable': 'API キーが未登録のため、このサービスのモデルはモデル一覧に出ません。「編集」から登録してください。',
        'status.unusablePair': 'API キーも OAuth ログインもないため、このサービスのモデルはモデル一覧に出ません。「編集」から登録するか、使わないならスイッチでオフにしてください。',
        'models.api': 'API', 'models.oauth': 'OAuth',
        'badge.subscription': 'OAuth', 'badge.api': 'API',
        'sub.title': '{name} (OAuth)',
        'sub.hint': 'サブスクのアカウントでログインします。API キーとは別に登録でき、登録するとモデル一覧にこのログイン用のモデルが追加されます。',
        'sub.note.relogin': 'ログインが切れたときは、「ログアウト」のあと、もう一度ログインしてください。',
        'sub.note.claudeCode': 'Claude Code のトークンはコピーしないでください。同じトークンを2つのツールで使うと、片方が必ず失効します。',
        'models.title': 'モデル一覧に表示するモデル',
        'models.hint': 'オンにしたモデルが、モデル選択の一覧に出ます。',
        'models.count': '{total} 件中 {shown} 件をモデル選択の一覧に出しています。',
        'page.title': 'モデルルート',
        'tab.chains': '代替チェーン', 'tab.accounts': 'アカウント', 'tab.media': '用途別',
        'chains.hint': 'プライマリが使えないとき(制限・枠切れ・認証切れ・サーバーエラー)、同じモデルの別アカウント、次にセカンダリ…の順に自動で切り替えます。モデル選択で「代替チェーン › チェーン名」を選ぶと使えます。返答が出始めたあとの失敗では切り替えません。',
        'chains.none': 'まだチェーンがありません。', 'chains.add': 'チェーンを追加', 'chains.name': 'チェーン名', 'chains.defaultName': 'メイン',
        'chains.step': '{n} 番目', 'chains.primary': 'プライマリ', 'chains.secondary': 'セカンダリ', 'chains.addStep': 'モデルを追加',
        'chains.accounts': '各モデルの別アカウント(#2 …)も順に試す', 'chains.remove': 'チェーンを削除', 'chains.save': '保存', 'chains.saved': '保存しました',
        'chains.up': '上へ', 'chains.down': '下へ', 'chains.removeStep': '外す',
        'chains.last': '直近の応答: {target}', 'chains.lastFallback': '(切り替え: {tried})', 'chains.lastFailed': '直近は全候補が失敗しました: {tried}',
        'chains.selectProvider': 'サービスを選ぶ', 'chains.selectModel': 'モデルを選ぶ', 'chains.unsaved': '未保存の変更があります',
        'chains.unlisted': '{name}(一覧に無い)',
        'accounts.hint': 'API キーのサービスに2本目以降のキーを登録できます。追加すると、モデル画面に「Claude #2」のようなカードができるので、その「編集」でキーを入力してください。モデル選択で「Claude」と「Claude #2」を選び分けられ(手動の切り替え)、代替チェーンはこれを順に試します(自動の切り替え)。',
        'accounts.add': '#{n} を追加', 'accounts.remove': '外す', 'accounts.keyName': 'キー名 {env}',
        'accounts.registered': '登録済み', 'accounts.missing': '未登録', 'accounts.oauthNote': 'API キーの追加アカウント(#2 …)は、モデル選択で別のサービスとして選べます。',
        'oauth.title': 'サブスク(OAuth)', 'oauth.hint': 'サブスクのアカウントを複数登録できます。使うのは「使用中」の1つで、「使う」で切り替えます(手動)。代替チェーンは、失敗したときに次のログイン済みアカウントへ切り替えて試します(自動。切り替えたまま使い続けます)。',
        'oauth.account': 'アカウント {n}', 'oauth.active': '使用中', 'oauth.use': '使う', 'oauth.add': 'アカウントを追加', 'oauth.remove': '外す',
        'oauth.signedIn': 'ログイン済み', 'oauth.signedOut': '未ログイン', 'oauth.login': 'ログイン',
        'oauth.addedHint': '追加したアカウントが使用中になりました。「ログイン」で、そのアカウントでログインしてください。',
        'oauth.confirmRemove': '{label} を外しますか? 保管したログインも消します。',
        'accounts.confirmRemove': '{label} を外しますか? 保存済みのキーは消しません。',
        'media.hint': '用途ごとにモデルを選んでスイッチを入れると、チャットでその道具(画像生成 generate_image・文字起こし transcribe_audio・読み上げ text_to_speech・動画生成 generate_video)が使えるようになります。モデルは新しい順に並びます。使えるのは OpenAI・Gemini・Grok の API キーの枠です(Grok は画像と動画だけ)。作ったファイルは作業フォルダの generated/ に保存されます。',
        'media.image': '画像生成', 'media.stt': '文字起こし', 'media.tts': '読み上げ', 'media.video': '動画生成',
        'media.clear': '解除',
        'media.reload': 'モデル一覧を読み込む', 'media.reloaded': 'モデル一覧を読み込みました', 'media.enabled': '{name}を有効にする',
        'media.noModels': '使えるモデルがありません。OpenAI・Gemini・Grok の API キーを登録してから「モデル一覧を読み込む」を押してください。',
        'page.loading': '読み込み中…', 'page.error': '読み込めません: {message}',
        'agy.title': 'Antigravity', 'agy.edit': '編集',
        'agy.accountsTitle': 'アカウント', 'agy.accountsHint': 'Google アカウントを複数登録できます。使うのは「使用中」の1つで、「使う」で切り替えます(手動)。制限・枠切れ・ログイン切れのときは、ログイン済みの次のアカウントへ自動で切り替えて試し、切り替えたまま使い続けます。',
        'agy.signInHint': '「編集」から Google アカウントでログインしてください。', 'agy.needsLogin': '再ログインが必要', 'agy.loginDone': 'ログインしました: {email}',
        'agy.accounts': 'OAuth', 'agy.accountCount': 'アカウント {count} 件', 'agy.activeAccount': '使用中: {email}', 'agy.noAccount': '未ログイン',
        'agy.login': 'アカウントを追加(ログイン)', 'agy.loginOpened': 'ブラウザでログインを済ませると、ここに反映されます。',
        'agy.unusable': '使えなかったため一覧から外したモデル({count}件): {names}。1日たつと自動で戻ります。', 'agy.resetUnusable': '今すぐ戻す',
        'agy.offHint': 'オフの間は、Antigravity のモデルをモデル一覧に出しません。オンに戻すと、オフにする前の表示に戻ります。',
        'models.search': 'モデルを検索', 'models.noMatch': '一致するモデルがありません。',
        'models.reset': '既定に戻す',
        'models.loading': 'モデルを読み込み中…',
        'models.loadError': 'モデルの一覧を読み込めません: {message}',
        'models.none': '表示できるモデルがありません。',
        'models.locked': 'キー入力欄を残すため、API では少なくとも1つのモデルを表示します。',
        'models.show': '{name} をモデル一覧に表示',
        'sub.loading': '読み込み中…',
        'sub.loadError': 'OAuth の状態を読み込めません: {message}',
        'sub.none': 'このサービスには OAuth の枠がありません。',
        'sub.noOauth': 'この DSH では OAuth ログインを利用できません。',
        'sub.notLoggedIn': '未ログイン', 'sub.loggedIn': 'ログイン済み',
        'sub.apiKeyStored': 'このルートには API キーが保存されています（OAuth ではありません）。',
        'btn.login': 'ログイン', 'btn.relogin': '再ログイン', 'btn.logout': 'ログアウト',
        'btn.reloginFromKey': 'OAuth でログインし直す', 'btn.deleteKey': '保存を削除',
        'btn.reload': '再読み込み', 'btn.cancel': '取り消し', 'btn.close': '閉じる', 'btn.retry': 'もう一度',
        'btn.submit': '送信', 'btn.copyLink': 'リンクをコピー', 'link.open': '認証ページを開く',
        'confirm.logout': '{name} (OAuth) のログインを削除しますか?',
        'confirm.deleteKey': '{name} の保存済みの認証を削除しますか?',
        'attempt.done': 'ログインしました。モデル一覧に OAuth のモデルが追加されます。',
        'attempt.cancelled': 'ログインを取り消しました。',
        'attempt.error': 'ログインに失敗しました: {message}',
        'attempt.errorUnknown': '不明なエラー',
        'attempt.waiting': 'ブラウザでの認証を待っています…',
        'attempt.code': 'ブラウザで認証したあと、表示されたコードを入力してください。',
        'attempt.chooseMethod': 'ログイン方法を選んでください。',
        'attempt.codeLabel': '認証コード',
        'attempt.codeInput': 'コードまたはリダイレクト URL',
        'method.browser': 'ブラウザでログイン（推奨）',
        'method.copy_code': 'コードをコピーしてログイン（ブラウザが別のマシンのとき）',
        'store.disconnected': 'DSH のログインサービスに接続できません',
        'store.failed': 'ログイン操作に失敗しました',
      },
      en: {
        'routes.enable': 'Enable {name}',
        'status.api': 'API key', 'status.oauth': 'OAuth',
        'status.keySet': 'Saved', 'status.keyMissing': 'Not saved',
        'status.loggedIn': 'Signed in', 'status.notLoggedIn': 'Not signed in',
        'status.disabled': 'Off', 'status.unknown': 'Checking',
        'status.unusable': 'No API key is saved, so this service’s models are not in the model list. Add one from Edit.',
        'status.unusablePair': 'There is no API key and no OAuth sign-in, so this service’s models are not in the model list. Add one from Edit, or turn it off with the switches if you do not use it.',
        'models.api': 'API', 'models.oauth': 'OAuth',
        'badge.subscription': 'OAuth', 'badge.api': 'API',
        'sub.title': '{name} (OAuth)',
        'sub.hint': 'Sign in with your subscription account. It is registered separately from the API key, and once registered the models for this sign-in are added to the model list.',
        'sub.note.relogin': 'If the sign-in expires, log out and sign in again.',
        'sub.note.claudeCode': 'Do not copy Claude Code tokens. If two tools share one token, whichever refreshes first breaks the other.',
        'models.title': 'Models shown in the model list',
        'models.hint': 'Models you turn on appear in the model picker.',
        'models.count': '{shown} of {total} models appear in the model picker.',
        'page.title': 'Model routes',
        'tab.chains': 'Fallback chains', 'tab.accounts': 'Accounts', 'tab.media': 'By purpose',
        'chains.hint': 'When the primary fails (rate limit, quota, expired sign-in, server error), the chain tries the same model on other accounts, then the secondary, and so on. Pick “Fallback chains › name” in the model picker. A failure after the reply has started is not switched.',
        'chains.none': 'No chains yet.', 'chains.add': 'Add chain', 'chains.name': 'Chain name', 'chains.defaultName': 'Main',
        'chains.step': '#{n}', 'chains.primary': 'Primary', 'chains.secondary': 'Secondary', 'chains.addStep': 'Add model',
        'chains.accounts': 'Also try other accounts (#2 …) of each model', 'chains.remove': 'Delete chain', 'chains.save': 'Save', 'chains.saved': 'Saved',
        'chains.up': 'Up', 'chains.down': 'Down', 'chains.removeStep': 'Remove',
        'chains.last': 'Last reply: {target}', 'chains.lastFallback': '(switched: {tried})', 'chains.lastFailed': 'Every candidate failed last time: {tried}',
        'chains.selectProvider': 'Choose a service', 'chains.selectModel': 'Choose a model', 'chains.unsaved': 'There are unsaved changes',
        'chains.unlisted': '{name} (not listed)',
        'accounts.hint': 'Register a second or later key for API-key services. Each added account gets its own card (e.g. “Claude #2”) on the Models page; enter the key from its Edit. Pick “Claude” or “Claude #2” in the model picker to switch by hand; fallback chains try them in order.',
        'accounts.add': 'Add #{n}', 'accounts.remove': 'Remove', 'accounts.keyName': 'Key name {env}',
        'accounts.registered': 'Saved', 'accounts.missing': 'Not saved', 'accounts.oauthNote': 'Additional API-key accounts (#2 …) can be picked as separate services in the model picker.',
        'oauth.title': 'Subscriptions (OAuth)', 'oauth.hint': 'Register several subscription accounts. One is “in use”; switch with “Use” (manual). Fallback chains switch to the next signed-in account on failure (automatic; it stays switched).',
        'oauth.account': 'Account {n}', 'oauth.active': 'In use', 'oauth.use': 'Use', 'oauth.add': 'Add account', 'oauth.remove': 'Remove',
        'oauth.signedIn': 'Signed in', 'oauth.signedOut': 'Not signed in', 'oauth.login': 'Sign in',
        'oauth.addedHint': 'The new account is now in use. Press “Sign in” to sign in with it.',
        'oauth.confirmRemove': 'Remove {label}? Its stored sign-in is deleted too.',
        'accounts.confirmRemove': 'Remove {label}? The stored key is kept.',
        'media.hint': 'Choose a model for a purpose and switch it on to enable its tool in chat (generate_image, transcribe_audio, text_to_speech, generate_video). Models are listed newest first. Only the OpenAI, Gemini, and Grok API key slots can be used (Grok: images and video only). Files are saved under generated/ in the working folder.',
        'media.image': 'Image generation', 'media.stt': 'Transcription', 'media.tts': 'Read aloud', 'media.video': 'Video generation',
        'media.clear': 'Clear',
        'media.reload': 'Load model list', 'media.reloaded': 'Model list loaded', 'media.enabled': 'Enable {name}',
        'media.noModels': 'No models available. Register an OpenAI, Gemini, or Grok API key, then press "Load model list".',
        'page.loading': 'Loading…', 'page.error': 'Could not load: {message}',
        'agy.title': 'Antigravity', 'agy.edit': 'Edit',
        'agy.accountsTitle': 'Accounts', 'agy.accountsHint': 'Register several Google accounts. One is “in use”; switch with “Use” (manual). On a rate limit, used-up quota or expired sign-in it switches to the next signed-in account automatically and stays there.',
        'agy.signInHint': 'Sign in with a Google account from Edit.', 'agy.needsLogin': 'Sign in again', 'agy.loginDone': 'Signed in: {email}',
        'agy.accounts': 'OAuth', 'agy.accountCount': '{count} account(s)', 'agy.activeAccount': 'In use: {email}', 'agy.noAccount': 'Not signed in',
        'agy.login': 'Add account (sign in)', 'agy.loginOpened': 'Finish signing in in the browser; it appears here afterwards.',
        'agy.unusable': 'Removed from the list because they failed ({count}): {names}. They come back automatically after a day.', 'agy.resetUnusable': 'Restore now',
        'agy.offHint': 'While off, Antigravity models are kept out of the model list. Turning it back on restores the previous visibility.',
        'models.search': 'Search models', 'models.noMatch': 'No models match.',
        'models.reset': 'Reset to default',
        'models.loading': 'Loading models…',
        'models.loadError': 'Could not load the models: {message}',
        'models.none': 'No models to show.',
        'models.locked': 'Keep at least one API model on so the key field stays available.',
        'models.show': 'Show {name} in the model list',
        'sub.loading': 'Loading…',
        'sub.loadError': 'Could not load the OAuth status: {message}',
        'sub.none': 'This service has no OAuth route.',
        'sub.noOauth': 'OAuth sign-in is not available in this DSH.',
        'sub.notLoggedIn': 'Not signed in', 'sub.loggedIn': 'Signed in',
        'sub.apiKeyStored': 'An API key is stored for this route (it is not OAuth).',
        'btn.login': 'Sign in', 'btn.relogin': 'Sign in again', 'btn.logout': 'Log out',
        'btn.reloginFromKey': 'Sign in with OAuth instead', 'btn.deleteKey': 'Delete stored key',
        'btn.reload': 'Reload', 'btn.cancel': 'Cancel', 'btn.close': 'Close', 'btn.retry': 'Try again',
        'btn.submit': 'Submit', 'btn.copyLink': 'Copy link', 'link.open': 'Open the sign-in page',
        'confirm.logout': 'Remove the stored {name} (OAuth) sign-in?',
        'confirm.deleteKey': 'Delete the credential stored for {name}?',
        'attempt.done': 'Signed in. The OAuth models are added to the model list.',
        'attempt.cancelled': 'Sign-in was cancelled.',
        'attempt.error': 'Sign-in failed: {message}',
        'attempt.errorUnknown': 'Unknown error',
        'attempt.waiting': 'Waiting for you to finish in the browser…',
        'attempt.code': 'After signing in in the browser, enter the code it shows.',
        'attempt.chooseMethod': 'Choose how to sign in.',
        'attempt.codeLabel': 'Verification code',
        'attempt.codeInput': 'Code or redirect URL',
        'method.browser': 'Sign in with the browser (recommended)',
        'method.copy_code': 'Sign in by copying a code (when the browser is on another machine)',
        'store.disconnected': 'Cannot connect to the DSH sign-in service',
        'store.failed': 'The sign-in operation failed',
      },
      zh: {
        'routes.enable': '启用 {name}',
        'status.api': 'API 密钥', 'status.oauth': 'OAuth',
        'status.keySet': '已保存', 'status.keyMissing': '未保存',
        'status.loggedIn': '已登录', 'status.notLoggedIn': '未登录',
        'status.disabled': '已关闭', 'status.unknown': '确认中',
        'status.unusable': '未保存 API 密钥，此服务的模型不会出现在模型列表中。请从“编辑”中添加。',
        'status.unusablePair': '既没有 API 密钥也没有 OAuth 登录，此服务的模型不会出现在模型列表中。请从“编辑”中添加，或在不使用时用开关关闭。',
        'models.api': 'API', 'models.oauth': 'OAuth',
        'badge.subscription': 'OAuth', 'badge.api': 'API',
        'sub.title': '{name} (OAuth)',
        'sub.hint': '使用订阅账号登录。它与 API 密钥分别登记,登记后模型列表中会加入该登录对应的模型。',
        'sub.note.relogin': '登录失效时,请先“退出登录”,再重新登录。',
        'sub.note.claudeCode': '请勿复制 Claude Code 的令牌。两个工具共用同一令牌时,先刷新的一方会使另一方失效。',
        'models.title': '在模型列表中显示的模型',
        'models.hint': '开启的模型会出现在模型选择列表中。',
        'models.count': '共 {total} 个模型，其中 {shown} 个会出现在模型选择列表中。',
        'page.title': '模型路由',
        'tab.chains': '备用链', 'tab.accounts': '账号', 'tab.media': '按用途',
        'chains.hint': '主模型不可用时(限流、额度用尽、登录失效、服务器错误),依次尝试同一模型的其他账号,再尝试次要模型。在模型选择中选择“备用链 › 名称”即可使用。回复开始后的失败不会切换。',
        'chains.none': '还没有备用链。', 'chains.add': '添加备用链', 'chains.name': '名称', 'chains.defaultName': '主要',
        'chains.step': '第 {n} 个', 'chains.primary': '主', 'chains.secondary': '次', 'chains.addStep': '添加模型',
        'chains.accounts': '也依次尝试各模型的其他账号(#2 …)', 'chains.remove': '删除备用链', 'chains.save': '保存', 'chains.saved': '已保存',
        'chains.up': '上移', 'chains.down': '下移', 'chains.removeStep': '移除',
        'chains.last': '最近的回复: {target}', 'chains.lastFallback': '(已切换: {tried})', 'chains.lastFailed': '上次所有候选都失败了: {tried}',
        'chains.selectProvider': '选择服务', 'chains.selectModel': '选择模型', 'chains.unsaved': '有未保存的更改',
        'chains.unlisted': '{name}(不在列表中)',
        'accounts.hint': '可为 API 密钥服务登记第二个及以后的密钥。添加后模型页面会出现“Claude #2”这样的卡片,请在其“编辑”中输入密钥。在模型选择中可手动选择“Claude”或“Claude #2”;备用链会依次尝试。',
        'accounts.add': '添加 #{n}', 'accounts.remove': '移除', 'accounts.keyName': '密钥名 {env}',
        'accounts.registered': '已保存', 'accounts.missing': '未保存', 'accounts.oauthNote': 'API 密钥的附加账号(#2 …)可在模型选择中作为单独的服务选择。',
        'oauth.title': '订阅(OAuth)', 'oauth.hint': '可登记多个订阅账号。使用中的只有一个,用“使用”切换(手动)。备用链失败时会切换到下一个已登录的账号(自动,并保持切换后的状态)。',
        'oauth.account': '账号 {n}', 'oauth.active': '使用中', 'oauth.use': '使用', 'oauth.add': '添加账号', 'oauth.remove': '移除',
        'oauth.signedIn': '已登录', 'oauth.signedOut': '未登录', 'oauth.login': '登录',
        'oauth.addedHint': '新添加的账号已设为使用中。请点击“登录”用该账号登录。',
        'oauth.confirmRemove': '要移除 {label} 吗?保存的登录也会删除。',
        'accounts.confirmRemove': '要移除 {label} 吗?已保存的密钥不会删除。',
        'media.hint': '为某个用途选择模型并打开开关后,聊天中即可使用对应工具(generate_image、transcribe_audio、text_to_speech、generate_video)。模型按从新到旧排列。仅可使用 OpenAI、Gemini、Grok 的 API 密钥通道(Grok 仅支持图片和视频)。生成的文件保存在工作文件夹的 generated/ 中。',
        'media.image': '生成图片', 'media.stt': '语音转写', 'media.tts': '朗读', 'media.video': '生成视频',
        'media.clear': '清除',
        'media.reload': '加载模型列表', 'media.reloaded': '已加载模型列表', 'media.enabled': '启用{name}',
        'media.noModels': '没有可用的模型。请先登记 OpenAI、Gemini 或 Grok 的 API 密钥,然后点击“加载模型列表”。',
        'page.loading': '加载中…', 'page.error': '无法加载: {message}',
        'agy.title': 'Antigravity', 'agy.edit': '编辑',
        'agy.accountsTitle': '账号', 'agy.accountsHint': '可登记多个 Google 账号。使用中的只有一个,用“使用”切换(手动)。遇到限流、额度用尽或登录失效时,会自动切换到下一个已登录的账号并保持。',
        'agy.signInHint': '请从“编辑”中用 Google 账号登录。', 'agy.needsLogin': '需要重新登录', 'agy.loginDone': '已登录: {email}',
        'agy.accounts': 'OAuth', 'agy.accountCount': '{count} 个账号', 'agy.activeAccount': '正在使用: {email}', 'agy.noAccount': '未登录',
        'agy.login': '添加账号(登录)', 'agy.loginOpened': '在浏览器中完成登录后会显示在这里。',
        'agy.unusable': '因无法使用而从列表中移除的模型({count} 个): {names}。一天后会自动恢复。', 'agy.resetUnusable': '立即恢复',
        'agy.offHint': '关闭期间，Antigravity 的模型不会出现在模型列表中。重新开启后恢复关闭前的显示。',
        'models.search': '搜索模型', 'models.noMatch': '没有匹配的模型。',
        'models.reset': '恢复默认',
        'models.loading': '正在加载模型…',
        'models.loadError': '无法读取模型列表: {message}',
        'models.none': '没有可显示的模型。',
        'models.locked': '为保留密钥输入框,API 至少要显示一个模型。',
        'models.show': '在模型列表中显示 {name}',
        'sub.loading': '加载中…',
        'sub.loadError': '无法读取 OAuth 状态: {message}',
        'sub.none': '该服务没有 OAuth 渠道。',
        'sub.noOauth': '当前 DSH 不支持 OAuth 登录。',
        'sub.notLoggedIn': '未登录', 'sub.loggedIn': '已登录',
        'sub.apiKeyStored': '此渠道保存的是 API 密钥(不是 OAuth)。',
        'btn.login': '登录', 'btn.relogin': '重新登录', 'btn.logout': '退出登录',
        'btn.reloginFromKey': '改用 OAuth 登录', 'btn.deleteKey': '删除已保存的密钥',
        'btn.reload': '重新加载', 'btn.cancel': '取消', 'btn.close': '关闭', 'btn.retry': '重试',
        'btn.submit': '提交', 'btn.copyLink': '复制链接', 'link.open': '打开登录页面',
        'confirm.logout': '要删除已保存的 {name} (OAuth) 登录吗?',
        'confirm.deleteKey': '要删除为 {name} 保存的凭据吗?',
        'attempt.done': '已登录。OAuth 模型已加入模型列表。',
        'attempt.cancelled': '已取消登录。',
        'attempt.error': '登录失败: {message}',
        'attempt.errorUnknown': '未知错误',
        'attempt.waiting': '正在等待你在浏览器中完成登录…',
        'attempt.code': '在浏览器中完成登录后,请输入页面显示的代码。',
        'attempt.chooseMethod': '请选择登录方式。',
        'attempt.codeLabel': '验证码',
        'attempt.codeInput': '代码或重定向 URL',
        'method.browser': '使用浏览器登录(推荐)',
        'method.copy_code': '复制代码登录(浏览器在另一台设备上时)',
        'store.disconnected': '无法连接到 DSH 的登录服务',
        'store.failed': '登录操作失败',
      },
    }
    // 辞書の登録先(DSH の ctx.locale)と、翻訳関数。locale サービスが無いときはブラウザの言語で ja/en/zh から選ぶ。
    let localeService = null
    const pickBuiltin = () => {
      const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      return lang.startsWith('ja') ? 'ja' : lang.startsWith('zh') ? 'zh' : 'en'
    }
    const format = (template, params) => params ? template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : template
    const fallbackT = (key, params) => format((DICT[pickBuiltin()] || DICT.en)[key] ?? DICT.en[key] ?? key, params)
    const t = (key, params) => (localeService ? localeService.bind(NS)(key, params) : fallbackT(key, params))
    const activeLanguage = () => localeService?.getSnapshot?.()?.active || pickBuiltin()
    // 言語が切り替わったら再描画する。
    function useT() {
      const [, force] = useState(0)
      useEffect(() => (localeService?.subscribe ? localeService.subscribe(() => force(n => n + 1)) : undefined), [])
      return t
    }

    // ───────────── スタイル(モデル設定ページと同じトークン・寸法) ─────────────
    const STYLE_ID = 'dsh-model-routes-style'
    const BTN = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;font:inherit;cursor:pointer;border:none;background:transparent;white-space:nowrap'
    function baseCss() {
      return [
        '.mr-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
        // サブスク欄(モデル設定ページの editor カードと同じ見た目)
        '.mr-gate[hidden]{display:none}',
        '.mr-extras{display:flex;flex-direction:column;gap:12px}',
        '.mr-divider{height:0;border-top:.5px solid var(--dsw-alias-border-l2)}',
        '.mr-models{display:flex;flex-direction:column;gap:8px}',
        '.mr-models-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.mr-kind{margin-left:8px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);font-size:11px;font-weight:400;line-height:16px;color:var(--dsw-alias-label-secondary)}',
        '.mr-model-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
        '.mr-model-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
        '.mr-model-row:first-child{border-top:0}',
        '.mr-model-name{display:flex;flex-direction:column;min-width:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
        '.mr-model-id{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mr-switch{box-sizing:border-box;flex:none;position:relative;width:36px;height:20px;padding:0;border:none;border-radius:10px;background:var(--dsw-alias-border-l4);cursor:pointer;transition:background .12s}',
        '.mr-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}',
        '.mr-switch-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s}',
        '.mr-switch[aria-checked="true"] .mr-switch-thumb{transform:translateX(16px)}',
        '.mr-switch:disabled{opacity:.4;cursor:default}',
        '.mr-switch:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
        '.mr-sub{display:flex;flex-direction:column;gap:12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);padding:16px;color:var(--dsw-alias-label-primary)}',
        '.mr-sub-head{display:flex;flex-direction:column;gap:4px}',
        '.mr-sub-title{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
        '.mr-status{display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}',
        '.mr-status-ok{color:var(--dsw-alias-state-success-primary)}',
        '.mr-status-warn{color:var(--dsw-alias-state-warn-label)}',
        '.mr-dot{box-sizing:border-box;flex:none;width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-label-dimmed)}',
        '.mr-dot-ok{background:var(--dsw-alias-state-success-primary)}',
        '.mr-dot-warn{background:var(--dsw-alias-state-warn-primary)}',
        '.mr-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
        '.mr-btn{' + BTN + ';height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
        '.mr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
        '.mr-btn-primary{height:36px;padding:0 14px;border-radius:var(--dsw-radius-md);font-size:14px;line-height:22px;border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
        '.mr-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
        '.mr-btn-danger{border-color:transparent;color:var(--dsw-alias-state-error-primary)}',
        '.mr-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
        '.mr-btn-link{border-color:transparent;color:var(--dsw-alias-label-tertiary)}',
        '.mr-btn-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
        '.mr-btn:disabled{opacity:.4;cursor:default}',
        '.mr-btn:focus-visible,.mr-input:focus-visible,.mr-link:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
        '.mr-link{color:var(--dsw-alias-state-business-primary);font-size:13px;line-height:20px;text-decoration:none;border-radius:var(--dsw-radius-xs)}',
        '.mr-link:hover{text-decoration:underline}',
        '.mr-field{display:flex;flex-direction:column;gap:6px}',
        '.mr-field-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.mr-input-row{display:flex;gap:8px;align-items:center}',
        '.mr-input{box-sizing:border-box;flex:1 1 auto;min-width:0;height:32px;padding:0 10px;font:inherit;font-size:14px;line-height:22px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
        '.mr-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
        '.mr-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
        '.mr-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
        '.mr-code-value{font-family:var(--ds-font-family-code);font-size:15px;font-weight:500;letter-spacing:.06em;color:var(--dsw-alias-label-primary)}',
        // カード見出しの下の状態行と、末尾のサービス一覧
        // カード(.rowCard)が余白と行間 12px を持つため、ここでは余白を足さない。
        '.mr-card-status{display:flex;flex-direction:column;gap:4px;margin-top:-6px}',
        '.mr-card-extras{display:flex;flex-direction:column;gap:12px}',
        '.mr-card-slot{display:contents}',
        // Antigravity のカード(DSH のモデル画面のカードと同じトークン・寸法)
        '.mr-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary)}',
        '.mr-card-head{display:flex;align-items:center;gap:10px}',
        // 設定「モデルルート」ページ
        '.mr-page{display:flex;flex-direction:column;gap:16px;max-width:800px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
        '.mr-page-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
        '.mr-tabs{display:flex;gap:8px;flex-wrap:wrap}',
        '.mr-tab{' + BTN + ';height:32px;padding:0 14px;border-radius:var(--dsw-radius-md);font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}',
        '.mr-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill)}',
        '.mr-step{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mr-step-label{flex:none;min-width:72px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
        // 用途別: サービスとモデルの欄を行ごとに同じ幅・同じ位置にする。
        '[data-mr-media] .mr-select{width:11em}[data-mr-media] .mr-select+.mr-select{width:16em}.mr-media-spacer{visibility:hidden}',
        '.mr-select{box-sizing:border-box;height:32px;min-width:0;max-width:100%;padding:0 8px;font:inherit;font-size:13px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
        '.mr-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
        '.mr-card-name{display:inline-flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;font-size:14px;font-weight:500;line-height:22px}',
        '.mr-status-items{display:flex;flex-wrap:wrap;gap:4px 16px}',
        '.mr-status-item{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.mr-status-label{color:var(--dsw-alias-label-tertiary)}',
        '.mr-status-switch{display:inline-flex;margin-left:4px}',
      ].join('\n')
    }
    // ───────────── モデル選択のバッジ ─────────────
    // モデル選択(入力欄のボタン・メニュー・一覧)は、モデル名を data-provider-id / data-model-id 付きの
    // span で包む(DSH公式の装飾フック)。ここへ CSS で「サブスク」「API」を付ける。
    // conversation.input.model.label スロットは1つしか使えず DeepSeek 標準の1017バッジと競合するため、スロットは使わない。
    // 値はカタログ(@kinocode/dsh-provider-catalog)の provider。変えたらここも直す(テストが一致を確認する)。
    const BADGES = {
      subscription: { key: 'badge.subscription', ids: ['anthropic', 'openai-codex', 'xai'], color: 'var(--dsw-alias-state-success-primary)' },
      api: { key: 'badge.api', ids: ['anthropic-api', 'openai-api', 'google-api', 'xai-api', 'opencode', 'commandcode-api'], suffix: '-api', color: 'var(--dsw-alias-state-warn-primary)' },
    }
    function badgeCss(translate = t) {
      const rules = []
      for (const badge of Object.values(BADGES)) {
        const selectors = badge.ids.map(id => 'span[data-provider-id=' + JSON.stringify(id) + '][data-model-id]::after')
        if (badge.suffix) selectors.push('span[data-provider-id$=' + JSON.stringify(badge.suffix) + '][data-model-id]::after')
        // 追加アカウント(anthropic-api-2 など)も API のバッジ。
        if (badge.suffix) selectors.push('span[data-provider-id*=' + JSON.stringify(badge.suffix + '-') + '][data-model-id]::after')
        rules.push(selectors.join(',') + '{content:' + JSON.stringify(translate(badge.key)) + ';--mr-badge:' + badge.color + ';display:inline-block;margin-left:6px;padding:0 6px;border:.5px solid var(--mr-badge);border-radius:var(--dsw-radius-xs);color:var(--mr-badge);font-size:11px;font-weight:500;line-height:16px;vertical-align:baseline;white-space:nowrap}')
      }
      return rules.join('\n')
    }
    // スタイルは1つの <style> にまとめる。言語が変わったらバッジの文言を入れ替える。
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      let tag = document.getElementById(STYLE_ID)
      if (!tag) {
        tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.dataset.plugin = '@kinocode/dsh-model-routes'
        document.head.appendChild(tag)
      }
      const paint = () => { tag.textContent = baseCss() + '\n' + badgeCss() }
      paint()
      const unsubscribe = localeService?.subscribe ? localeService.subscribe(paint) : undefined
      return () => { unsubscribe?.(); document.getElementById(STYLE_ID)?.remove() }
    }

    // ───────────── サブスク(OAuth)のログイン ─────────────
    // 設定のモデル画面には API キー欄しかない。1つのサービス(Claude など)の行に「サブスク」欄を足し、
    // サブスク用の別の行は隠す。ログイン処理はホストの modelRoutesAuth サービス(DSH内部通信)に任せる。
    // API 枠のルートID → 対になるサブスク枠のルートID。カタログと同じ内容(テストが一致を確認する)。
    const SUBSCRIPTION_OF_API = { 'anthropic-api': 'anthropic', 'openai-api': 'openai-codex', 'xai-api': 'xai' }
    const SUBSCRIPTION_ROUTES = Object.values(SUBSCRIPTION_OF_API)
    // 状態行を出す DSH 標準のルート。API キーで使うことが確かなものだけ(キー不要のルートを「未登録」と誤表示しないため)。
    const BUILTIN_KEY_ROUTES = ['deepseek-official']
    const API_OF_SUBSCRIPTION = Object.fromEntries(Object.entries(SUBSCRIPTION_OF_API).map(([api, sub]) => [sub, api]))
    const SERVICE_PKG = '@kinocode/dsh-model-routes'
    const objectSchema = { parse(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object'); return value } }
    const nullableSchema = { parse(value) { return value === null ? null : objectSchema.parse(value) } }
    const stringSchema = (name, pattern, max) => ({ parse(value) { if (typeof value !== 'string' || !value || value.length > max || (pattern && !pattern.test(value))) throw new Error('Invalid ' + name); return value } })
    const codec = (name, schema) => ({ mode: 'strict', typeSymbol: SERVICE_PKG + '#' + name, schema, create: () => schema })
    const routeIdCodec = codec('RouteId', stringSchema('routeId', /^[a-z0-9][a-z0-9-]{0,63}$/, 64))
    const modelIdCodec = codec('ModelId', stringSchema('modelId', /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/, 128))
    const visibleCodec = codec('Visible', { parse(value) { if (typeof value !== 'boolean') throw new Error('Invalid visible'); return value } })
    // ホストの typert.host.js と同じ内容(テストが一致を確認する)。
    const CONTRIBUTION = { package: SERVICE_PKG, face: 'host', descriptors: [
      ['modelRoutesAuth', 'getAuthState', 'AuthState', objectSchema, []],
      ['modelRoutesAuth', 'startLogin', 'Attempt', objectSchema, [['routeId', routeIdCodec]]],
      ['modelRoutesAuth', 'getAttempt', 'MaybeAttempt', nullableSchema, []],
      ['modelRoutesAuth', 'answerPrompt', 'Attempt', objectSchema, [['promptId', codec('PromptId', stringSchema('promptId', /^[A-Za-z0-9_-]{1,64}$/, 64))], ['value', codec('Answer', stringSchema('value', null, 8192))]]],
      ['modelRoutesAuth', 'cancelLogin', 'MaybeAttempt', nullableSchema, []],
      ['modelRoutesAuth', 'dismissAttempt', 'AuthState', objectSchema, []],
      ['modelRoutesAuth', 'logout', 'AuthState', objectSchema, [['routeId', routeIdCodec]]],
      ['modelRoutesModels', 'setRouteEnabled', 'Models', objectSchema, [['routeId', routeIdCodec], ['enabled', codec('Enabled', { parse(value) { if (typeof value !== 'boolean') throw new Error('Invalid enabled'); return value } })]]],
      ['modelRoutesModels', 'getModels', 'Models', objectSchema, []],
      ['modelRoutesModels', 'setModelVisible', 'Models', objectSchema, [['routeId', routeIdCodec], ['modelId', modelIdCodec], ['visible', visibleCodec]]],
      ['modelRoutesModels', 'resetModels', 'Models', objectSchema, [['routeId', routeIdCodec]]],
      ['modelRoutesSetup', 'getSetup', 'Setup', objectSchema, []],
      ['modelRoutesSetup', 'saveChains', 'Setup', objectSchema, [['value', codec('Chains', objectSchema)]]],
      ['modelRoutesSetup', 'saveMedia', 'Setup', objectSchema, [['value', codec('Media', objectSchema)]]],
      ['modelRoutesSetup', 'reloadMediaModels', 'Setup', objectSchema, []],
      ['modelRoutesSetup', 'addAccount', 'Setup', objectSchema, [['routeId', routeIdCodec]]],
      ['modelRoutesSetup', 'removeAccount', 'Setup', objectSchema, [['accountId', codec('AccountId', stringSchema('accountId', /^[a-z0-9][a-z0-9-]{0,63}$/, 64))]]],
      ['modelRoutesSetup', 'oauthAction', 'Setup', objectSchema, [['value', codec('OauthAction', objectSchema)]]],
      ['modelRoutesSetup', 'agyState', 'AgyState', objectSchema, []],
      ['modelRoutesSetup', 'agyAction', 'AgyState', objectSchema, [['value', codec('AgyAction', objectSchema)]]],
    ].map(([service, method, result, schema, params]) => ({
      id: SERVICE_PKG + '#' + service + '/' + method, service, namespace: service, method, invocation: { kind: 'direct' },
      parameters: params.map(([name, c]) => ({ name, wire: name, source: 'json', codec: c })),
      result: codec(result, schema),
    })) }

    const isActive = attempt => !!attempt && (attempt.phase === 'running' || attempt.phase === 'prompt')
    const isDesktop = () => typeof window !== 'undefined' && 'dshDesktop' in window
    const authStore = {
      service: null, state: null, error: null, busy: false, revision: 0, last: 0, timer: null, subs: new Set(), opened: new Set(), pendingTab: null,
      bind(service) { this.service = service; this.state = null; this.error = service ? null : t('store.disconnected'); if (service && this.subs.size) this.refresh(); else this.emit() },
      emit() { this.revision++; for (const fn of [...this.subs]) fn() },
      subscribe(fn) {
        this.subs.add(fn)
        if (this.subs.size === 1) { this.refresh(); this.timer = setInterval(() => this.tick(), 1500) }
        return () => { this.subs.delete(fn); if (!this.subs.size && this.timer !== null) { clearInterval(this.timer); this.timer = null } }
      },
      tick() { if (isActive(this.state?.attempt) || Date.now() - this.last > 15000) this.refresh() },
      async call(method, ...args) {
        if (typeof this.service?.[method] !== 'function') throw new Error(t('store.disconnected'))
        const result = await this.service[method](...args)
        if (!result || result.ok !== true) throw new Error(result?.error?.message || t('store.failed'))
        return result.value
      },
      // ブラウザ版は、クリックの瞬間に空のタブを開いておく(あとから開くとポップアップとして遮断されるため)。
      // Desktop 版はシステムブラウザで開かれるので不要。
      prepareTab() {
        if (isDesktop() || typeof window === 'undefined' || typeof window.open !== 'function') return
        try { const tab = window.open('', '_blank'); if (tab) { try { tab.opener = null } catch {} this.pendingTab = tab } } catch {}
      },
      closeTab() { try { this.pendingTab?.close?.() } catch {} this.pendingTab = null },
      openUrl(attempt) {
        // 認証URLが届いたら一度だけ開く。ブロックされたときのため、画面にもリンクを出す。
        const url = attempt?.notices?.find(notice => notice.url)?.url
        if (!url || this.opened.has(attempt.id + ' ' + url)) return
        this.opened.add(attempt.id + ' ' + url)
        try {
          if (this.pendingTab && !this.pendingTab.closed) { this.pendingTab.location.href = url; this.pendingTab = null; return }
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener,noreferrer')
        } catch {}
      },
      async refresh() {
        if (!this.service) return
        try {
          this.state = await this.call('getAuthState'); this.error = null
          this.openUrl(this.state.attempt)
          if (this.state.attempt && !isActive(this.state.attempt)) this.closeTab()
          // ブラウザでのログインが終わったら、ルート一覧の登録状態も読み直す。
          const finished = this.state.attempt?.phase === 'done' ? this.state.attempt.id : null
          if (finished && finished !== this.finished) { this.finished = finished; modelsStore.refresh(); setTimeout(() => { modelsStore.refresh(); setupStore.refresh() }, 1500) }
        } catch (error) { this.error = error?.message || String(error) }
        this.last = Date.now(); this.emit()
      },
      // 操作を直列に実行して画面を更新する。失敗は error に出す。
      async act(method, ...args) {
        if (this.busy) return
        this.busy = true; this.emit()
        try { await this.call(method, ...args); this.error = null } catch (error) { this.error = error?.message || String(error); this.closeTab() }
        this.busy = false
        await this.refresh()
        // ログイン・ログアウトで登録状態が変わるため、ルート一覧も読み直す(ホストの反映を待って再度)。
        modelsStore.refresh(); setTimeout(() => modelsStore.refresh(), 1500)
      },
      startLogin(routeId) { this.prepareTab(); return this.act('startLogin', routeId) },
      answer(promptId, value) { return this.act('answerPrompt', promptId, value) },
      cancel() { this.closeTab(); return this.act('cancelLogin') },
      dismiss() { this.closeTab(); return this.act('dismissAttempt') },
      logout(routeId) { return this.act('logout', routeId) },
    }
    function useAuth() {
      const [, force] = useState(0)
      useEffect(() => authStore.subscribe(() => force(n => n + 1)), [])
      return authStore
    }
    // ── モデルごとの「モデル一覧に表示」トグル ──
    const modelsStore = {
      service: null, state: null, error: null, busy: false, subs: new Set(),
      bind(service) { this.service = service; this.state = null; this.error = service ? null : t('store.disconnected'); if (service && this.subs.size) this.refresh(); else this.emit() },
      emit() { for (const fn of [...this.subs]) fn() },
      subscribe(fn) { this.subs.add(fn); if (this.subs.size === 1) this.refresh(); return () => { this.subs.delete(fn) } },
      async call(method, ...args) {
        if (typeof this.service?.[method] !== 'function') throw new Error(t('store.disconnected'))
        const result = await this.service[method](...args)
        if (!result || result.ok !== true) throw new Error(result?.error?.message || t('store.failed'))
        return result.value
      },
      async refresh() {
        if (!this.service) return
        try { this.state = await this.call('getModels'); this.error = null } catch (error) { this.error = error?.message || String(error) }
        this.emit()
      },
      async act(method, ...args) {
        if (this.busy) return
        this.busy = true; this.emit()
        try { this.state = await this.call(method, ...args); this.error = null } catch (error) { this.error = error?.message || String(error) }
        this.busy = false; this.emit()
      },
      set(routeId, modelId, visible) { return this.act('setModelVisible', routeId, modelId, visible) },
      reset(routeId) { return this.act('resetModels', routeId) },
      setRoute(routeId, enabled) { return this.act('setRouteEnabled', routeId, enabled) },
    }
    function useModels() {
      const [, force] = useState(0)
      useEffect(() => modelsStore.subscribe(() => force(n => n + 1)), [])
      return modelsStore
    }
    // DSH 標準の Switch(あれば)。無い環境では同じ見た目の簡易スイッチ。
    function ModelSwitch({ checked, onChange, label, disabled, title }) {
      const Switch = primitives?.Switch
      if (Switch) return el(Switch, { checked, onChange, label, disabled, title })
      return el('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, title, disabled: !!disabled, className: 'mr-switch', onClick: () => onChange(!checked) }, el('span', { className: 'mr-switch-thumb' }))
    }
    // ルートごとのモデル一覧。オンのモデルが、モデル選択の一覧に出る。
    // モデルがこれより多いときは、一覧の上に検索窓を出す(取得したモデルで数十件になるため)。
    const SEARCH_THRESHOLD = 12
    function ModelToggles({ routeId, kind }) {
      const translate = useT()
      const store = useModels()
      const [query, setQuery] = useState('')
      const group = store.state?.groups?.find(item => item.routeId === routeId)
      if (!group) {
        // 読み込み済みなのに無いルートは、このプラグインの管理外。待ち続けず何も出さない。
        if (store.state && !store.error) return null
        return el('p', { className: store.error ? 'mr-error' : 'mr-hint' }, store.error ? translate('models.loadError', { message: store.error }) : translate('models.loading'))
      }
      const changed = group.models.some(model => model.visible !== model.default)
      const visibleCount = group.models.filter(model => model.visible).length
      const searchable = group.models.length > SEARCH_THRESHOLD
      const needle = query.trim().toLowerCase()
      const listed = searchable && needle ? group.models.filter(model => (model.id + ' ' + model.name).toLowerCase().includes(needle)) : group.models
      return el('div', { className: 'mr-models', 'data-mr-models': routeId },
        el('div', { className: 'mr-models-head' },
          el('span', { className: 'mr-field-label' }, translate('models.title'), kind ? el('span', { className: 'mr-kind' }, translate('models.' + kind)) : null),
          changed && el('button', { type: 'button', className: 'mr-btn mr-btn-link', disabled: store.busy, onClick: () => store.reset(routeId) }, translate('models.reset'))),
        el('p', { className: 'mr-hint' }, searchable ? translate('models.count', { shown: visibleCount, total: group.models.length }) : translate('models.hint')),
        searchable && el('input', { className: 'mr-input', type: 'search', value: query, placeholder: translate('models.search'), 'aria-label': translate('models.search'), autoComplete: 'off', spellCheck: false, onChange: event => setQuery(event.target.value) }),
        group.models.length === 0 ? el('p', { className: 'mr-hint' }, translate('models.none'))
          : listed.length === 0 ? el('p', { className: 'mr-hint' }, translate('models.noMatch'))
          : el('ul', { className: 'mr-model-list' }, listed.map(model => {
            const locked = group.lastLocked && model.visible
            return el('li', { key: model.id, className: 'mr-model-row' },
              el('span', { className: 'mr-model-name' }, el('span', null, model.name), el('span', { className: 'mr-model-id' }, model.id)),
              el(ModelSwitch, { checked: model.visible, label: translate('models.show', { name: model.name }), disabled: store.busy || locked, title: locked ? translate('models.locked') : undefined, onChange: next => store.set(routeId, model.id, next) }))
          })),
        group.lastLocked && visibleCount === 1 && el('p', { className: 'mr-hint' }, translate('models.locked')),
        store.error && store.state && el('p', { className: 'mr-error' }, store.error))
    }
    // 編集を開いているときだけ表示する。カードの中に API キーの入力欄(編集画面)があるかを見る。
    function WhenEditing({ children }) {
      const ref = useRef(null)
      const [open, setOpen] = useState(false)
      useEffect(() => {
        const row = ref.current?.closest?.('li') || ref.current?.parentElement
        if (!row) return undefined
        const check = () => setOpen(!!row.querySelector('input[autocomplete="new-password"]'))
        check()
        if (typeof MutationObserver === 'undefined') return undefined
        const observer = new MutationObserver(check)
        observer.observe(row, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [])
      return el('div', { ref, className: 'mr-gate', hidden: !open, 'data-mr-gate': open ? 'open' : 'closed' }, open ? children : null)
    }

    const confirmed = message => typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm(message)
    const btn = (label, onClick, { kind, disabled, key } = {}) => el('button', {
      key, type: 'button', onClick, disabled: !!disabled,
      className: 'mr-btn' + (kind === 'primary' ? ' mr-btn-primary' : kind === 'danger' ? ' mr-btn-danger' : kind === 'link' ? ' mr-btn-link' : ''),
    }, label)

    // pi-ai の選択肢は { id, label }。既知の id は翻訳し、未知なら pi-ai の表示名を使う。
    const methodLabel = (option, translate) => {
      const key = 'method.' + option.id
      return Object.hasOwn(DICT.en, key) ? translate(key) : option.label
    }
    function PromptForm({ store, attempt, translate }) {
      const [value, setValue] = useState('')
      const prompt = attempt.prompt
      if (prompt.kind === 'select') {
        return el('div', { className: 'mr-field' },
          el('span', { className: 'mr-field-label' }, translate('attempt.chooseMethod')),
          el('div', { className: 'mr-actions' }, (prompt.options || []).map((option, i) => btn(methodLabel(option, translate), () => store.answer(prompt.id, option.id), { key: option.id, kind: i === 0 ? 'primary' : undefined, disabled: store.busy }))))
      }
      const submit = () => { if (value) { store.answer(prompt.id, value); setValue('') } }
      const label = translate('attempt.codeInput')
      return el('div', { className: 'mr-field' },
        el('span', { className: 'mr-field-label' }, label),
        el('div', { className: 'mr-input-row' },
          el('input', { className: 'mr-input', type: prompt.kind === 'secret' ? 'password' : 'text', value, placeholder: prompt.placeholder || '', autoComplete: 'off', spellCheck: false, 'aria-label': label,
            onChange: event => setValue(event.target.value), onKeyDown: event => { if (event.key === 'Enter') submit() } }),
          btn(translate('btn.submit'), submit, { kind: 'primary', disabled: store.busy || !value })))
    }

    function AttemptView({ store, attempt, translate }) {
      const notices = attempt.notices || []
      const link = [...notices].reverse().find(notice => notice.url)
      const code = [...notices].reverse().find(notice => notice.code)
      const choosing = attempt.phase === 'prompt' && attempt.prompt?.kind === 'select'
      return el('div', { className: 'mr-field', 'data-mr-attempt': attempt.phase },
        attempt.phase === 'done' && el('span', { className: 'mr-status mr-status-ok' }, el('span', { className: 'mr-dot mr-dot-ok' }), translate('attempt.done')),
        attempt.phase === 'cancelled' && el('span', { className: 'mr-hint' }, translate('attempt.cancelled')),
        attempt.phase === 'error' && el('p', { className: 'mr-error' }, translate('attempt.error', { message: attempt.error || translate('attempt.errorUnknown') })),
        isActive(attempt) && !choosing && el('span', { className: 'mr-hint' }, translate(attempt.phase === 'prompt' ? 'attempt.code' : 'attempt.waiting')),
        code && el('div', { className: 'mr-status' }, translate('attempt.codeLabel'), el('span', { className: 'mr-code-value' }, code.code)),
        link && !choosing && el('div', { className: 'mr-actions' },
          el('a', { className: 'mr-link', href: link.url, target: '_blank', rel: 'noopener noreferrer' }, translate('link.open')),
          btn(translate('btn.copyLink'), () => { try { navigator.clipboard?.writeText(link.url) } catch {} }, { kind: 'link' })),
        attempt.phase === 'prompt' && attempt.prompt && el(PromptForm, { store, attempt, translate, key: attempt.prompt.id }),
        el('div', { className: 'mr-actions' },
          isActive(attempt) && btn(translate('btn.cancel'), () => store.cancel(), { kind: 'link', disabled: store.busy }),
          attempt.phase === 'error' && btn(translate('btn.retry'), () => store.startLogin(attempt.routeId), { kind: 'primary', disabled: store.busy }),
          !isActive(attempt) && btn(translate('btn.close'), () => store.dismiss(), { kind: 'link', disabled: store.busy })))
    }

    // 対になる API 枠のカードに差し込む「サブスク」欄。
    function SubscriptionSection({ routeId, label }) {
      const translate = useT()
      const store = useAuth()
      const route = store.state?.routes?.find(item => item.routeId === routeId)
      const attempt = store.state?.attempt?.routeId === routeId ? store.state.attempt : null
      const name = label || route?.label || routeId
      let body
      if (!store.state) body = store.error
        ? el('div', { className: 'mr-actions' }, el('span', { className: 'mr-status mr-status-warn' }, translate('sub.loadError', { message: store.error })), btn(translate('btn.reload'), () => store.refresh()))
        : el('span', { className: 'mr-hint' }, translate('sub.loading'))
      else if (!route) body = el('span', { className: 'mr-hint' }, translate('sub.none'))
      else if (attempt) body = el(AttemptView, { store, attempt, translate })
      else if (!route.canLogin) body = el('span', { className: 'mr-hint' }, translate('sub.noOauth'))
      else if (route.registered && route.credentialType === 'api_key') body = el('div', { className: 'mr-field' },
        el('span', { className: 'mr-status mr-status-warn' }, el('span', { className: 'mr-dot mr-dot-warn' }), translate('sub.apiKeyStored')),
        el('div', { className: 'mr-actions' },
          btn(translate('btn.reloginFromKey'), () => store.startLogin(routeId), { kind: 'primary', disabled: store.busy }),
          btn(translate('btn.deleteKey'), () => { if (confirmed(translate('confirm.deleteKey', { name }))) store.logout(routeId) }, { kind: 'danger', disabled: store.busy })))
      else if (route.registered) body = el('div', { className: 'mr-field' },
        el('span', { className: 'mr-status mr-status-ok' }, el('span', { className: 'mr-dot mr-dot-ok' }), translate('sub.loggedIn')),
        el('div', { className: 'mr-actions' },
          btn(translate('btn.relogin'), () => store.startLogin(routeId), { disabled: store.busy }),
          btn(translate('btn.logout'), () => { if (confirmed(translate('confirm.logout', { name }))) store.logout(routeId) }, { kind: 'danger', disabled: store.busy })))
      else body = el('div', { className: 'mr-field' },
        el('span', { className: 'mr-status' }, el('span', { className: 'mr-dot' }), translate('sub.notLoggedIn')),
        el('div', { className: 'mr-actions' }, btn(translate('btn.login'), () => store.startLogin(routeId), { kind: 'primary', disabled: store.busy })))
      return el('div', { className: 'mr-sub', 'data-mr-subscription': routeId },
        el('div', { className: 'mr-sub-head' },
          el('span', { className: 'mr-sub-title' }, translate('sub.title', { name })),
          el('p', { className: 'mr-hint' }, translate('sub.hint'))),
        store.state && store.error && el('p', { className: 'mr-error' }, store.error),
        body,
        el('p', { className: 'mr-hint' }, translate('sub.note.relogin')),
        routeId === 'anthropic' && el('p', { className: 'mr-hint' }, translate('sub.note.claudeCode')),
        el('div', { className: 'mr-divider' }),
        el(ModelToggles, { routeId, kind: 'oauth' }))
    }

    // カード見出しの下の状態行。DSH の点は API キーだけを表すため、OAuth を含めた実際の状態をここで示す。
    //  apiRouteId: カードの API 枠(無ければ OAuth だけ)。keyConfigured: DSH が渡す API キーの状態。
    //  keyless: カスタム枠など、キーの有無で判定できない枠。状態の文言を出さず、スイッチだけにする。
    // 各枠の横に、その枠のオン・オフ(このプラグインのルートのみ)を置く。
    function CardStatus({ apiRouteId, keyConfigured, oauthRouteId, keyless }) {
      const translate = useT()
      const models = useModels()
      const auth = useAuth()
      const groups = models.state?.groups
      // DSH 標準のルート(DeepSeek など)はこのプラグインの一覧に無いため、DSH が渡すキーの状態だけで示す。
      const builtin = apiRouteId && BUILTIN_KEY_ROUTES.includes(apiRouteId)
      const apiGroup = apiRouteId ? groups?.find(group => group.routeId === apiRouteId) : null
      if (apiRouteId && !apiGroup && !builtin) return null
      const oauthGroup = oauthRouteId ? groups?.find(item => item.routeId === oauthRouteId) : null
      const own = [apiGroup, oauthGroup].filter(Boolean)
      const kindLabel = group => translate(group.kind === 'subscription' ? 'models.oauth' : 'models.api')
      // オフにしてもカードは残る(モデル0件のルートとして残す)ため、確かめずに切り替える。
      const toggle = (group, next) => models.setRoute(group.routeId, next)
      const switchOf = group => group ? el(ModelSwitch, { checked: group.enabled, label: translate('routes.enable', { name: group.service + ' (' + kindLabel(group) + ')' }), disabled: models.busy, onChange: next => toggle(group, next) }) : null
      const items = []
      let usable = false
      if (apiRouteId) {
        if (apiGroup && !apiGroup.enabled) items.push({ key: 'api', group: apiGroup, label: translate('status.api'), ok: false, text: translate('status.disabled') })
        else if (keyless) items.push({ key: 'api', group: apiGroup, label: translate('models.api'), ok: true, text: '' })
        else {
          const known = typeof keyConfigured === 'boolean' ? keyConfigured : apiGroup?.registered ?? null
          if (known === true) usable = true
          items.push({ key: 'api', group: apiGroup, label: translate('status.api'), ok: known === true, pending: typeof known !== 'boolean', text: translate(known === true ? 'status.keySet' : known === false ? 'status.keyMissing' : 'status.unknown') })
        }
      }
      if (oauthRouteId) {
        const route = auth.state?.routes?.find(item => item.routeId === oauthRouteId)
        const loggedIn = route ? (route.registered === true && route.credentialType !== 'api_key') : oauthGroup?.registered ?? null
        if (oauthGroup && !oauthGroup.enabled) items.push({ key: 'oauth', group: oauthGroup, label: translate('status.oauth'), ok: false, text: translate('status.disabled') })
        else {
          if (loggedIn === true) usable = true
          items.push({ key: 'oauth', group: oauthGroup, label: translate('status.oauth'), ok: loggedIn === true, pending: typeof loggedIn !== 'boolean', text: translate(loggedIn === true ? 'status.loggedIn' : loggedIn === false ? 'status.notLoggedIn' : 'status.unknown') })
        }
      }
      // 全部オフのサービスには案内を出さない(オフにしたのは利用者の意思)。
      const anyOn = items.some(item => !item.group || item.group.enabled)
      const settled = !keyless && anyOn && items.every(item => !item.pending)
      return el('div', { className: 'mr-card-status', 'data-mr-status': apiRouteId || oauthRouteId },
        el('div', { className: 'mr-status-items' }, items.map(item => el('span', { key: item.key, className: 'mr-status-item' },
          el('span', { className: 'mr-dot' + (item.ok ? ' mr-dot-ok' : '') }), el('span', { className: 'mr-status-label' }, item.label), item.text,
          own.length ? el('span', { className: 'mr-status-switch' }, switchOf(item.group)) : null))),
        settled && !usable && el('p', { className: 'mr-hint' }, translate(oauthRouteId ? 'status.unusablePair' : 'status.unusable')),
        models.state && models.error && el('p', { className: 'mr-error' }, models.error))
    }

    // サブスク用の別の行は、カードの中から自分の行を隠す(公式のスロットは各カードへの追加だけで、行を消す口がない)。
    // 状態を読み込めたときだけ隠す: 読めないのに隠すと、ログインの手段がなくなるため。
    function HideRow() {
      const store = useAuth()
      const ref = useRef(null)
      const ready = !!store.state
      useEffect(() => {
        const row = ref.current?.closest?.('li') || ref.current?.parentElement
        if (!ready || !row) return undefined
        const previous = row.style.display
        row.style.display = 'none'
        row.setAttribute('data-model-routes-hidden', '')
        return () => { row.style.display = previous; row.removeAttribute('data-model-routes-hidden') }
      }, [ready])
      return el('span', { ref, hidden: true, 'data-mr-hide': '' })
    }

    // settings.models.provider-card: 各プロバイダのカードに差し込まれる。props.provider.provider がルートID。
    // 編集を開いたときだけ表示する(閉じている間は何も出さない)。
    //  - API 枠(Claude など): API のモデルの表示トグル + 対になる OAuth 欄(ログインとモデルのトグル)
    //  - API だけのサービス(Gemini など)・カスタム枠: モデルの表示トグルだけ
    //  - OAuth 枠の行: 隠す(API 枠のカードにまとめるため)
    function ProviderCardExtension(props) {
      const routeId = props?.provider?.provider
      if (SUBSCRIPTION_ROUTES.includes(routeId)) return el(SubscriptionRow, { routeId })
      if (!routeId) return null
      // DSH 標準のルートは状態行だけ。モデルの表示はこのプラグインの管理外。
      if (BUILTIN_KEY_ROUTES.includes(routeId)) return el(CardStatus, { apiRouteId: routeId, keyConfigured: props?.keyConfigured })
      const partner = SUBSCRIPTION_OF_API[routeId]
      return el('div', { className: 'mr-card-slot' },
        // カスタム枠はキー不要のもの(Ollama など)があり、キーの有無で判定できないため出さない。
        // カスタム枠はキー不要のもの(Ollama など)があるため、状態の文言を出さずスイッチだけにする。
        el(CardStatus, BADGES.api.ids.includes(routeId) ? { apiRouteId: routeId, keyConfigured: props?.keyConfigured, oauthRouteId: partner } : { apiRouteId: routeId, keyless: true }),
        el(WhenEditing, null,
          el('div', { className: 'mr-extras' },
            el('div', { className: 'mr-sub' }, el(ModelToggles, { routeId, kind: partner ? 'api' : undefined })),
            partner ? el(SubscriptionSection, { routeId: partner }) : null)))
    }
    // OAuth 枠の行: 対になる API 枠のカードへまとめて隠す(API 枠はオフでもカードが残る)。
    function SubscriptionRow() {
      return el(HideRow)
    }

    // ───────────── Antigravity(自前の接続) ─────────────
    // Antigravity はこのプラグインの接続処理(lib/agy)で使う。DSH のカード一覧には乗らないため、モデル画面の末尾に同じ見た目のカードを置く。
    // ホストの sortModelsNewestFirst と同じ規則: 系列ごとにまとめ(系列は最初に出た順)、新しい版から。日付付きは同じ版の後ろ。
    function versionOf(id) {
      const text = String(id).toLowerCase()
      const slash = text.indexOf('/')
      const family = slash > 0 ? text.slice(0, slash) : (/^[a-z]+/.exec(text)?.[0] ?? text)
      const tokens = text.slice(slash + 1).split(/[^a-z0-9.]+/).filter(Boolean)
      const version = []
      let date = ''
      for (const token of tokens) {
        if (/^(19|20)\d{6}$/.test(token)) { date = token; break }
        if (/^(19|20)\d{2}$/.test(token)) { date = tokens.slice(tokens.indexOf(token)).join('-'); break }
        const match = /^[a-z]*(\d+(?:\.\d+)*)[a-z]?$/.exec(token)
        if (match) { version.push(...match[1].split('.').map(Number)); continue }
        if (version.length) break
      }
      return { family, version, date }
    }
    function sortModelsByVersion(models) {
      const firstSeen = new Map()
      const keyed = models.map(model => { const info = versionOf(model.id); if (!firstSeen.has(info.family)) firstSeen.set(info.family, firstSeen.size); return { model, ...info } })
      const byVersion = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i] === undefined) return 1; if (b[i] === undefined) return -1; if (a[i] !== b[i]) return b[i] - a[i] } return 0 }
      keyed.sort((a, b) => (firstSeen.get(a.family) - firstSeen.get(b.family))
        || (a.version.length && b.version.length ? byVersion(a.version, b.version) : (b.version.length - a.version.length))
        || (a.date ? 1 : 0) - (b.date ? 1 : 0)
        || (b.date > a.date ? 1 : b.date < a.date ? -1 : 0)
        || String(a.model.id).localeCompare(String(b.model.id)))
      return keyed.map(item => item.model)
    }
    const agyStore = {
      service: null, state: null, error: null, busy: false, timer: null, ticks: 0, subs: new Set(),
      bind(service) { this.service = service; this.state = null; this.error = null; if (service && this.subs.size) this.refresh(); else this.emit() },
      emit() { for (const fn of [...this.subs]) fn() },
      subscribe(fn) {
        this.subs.add(fn)
        // ログイン待ちの間は 2 秒ごと、それ以外は 30 秒ごとに読み直す。
        if (this.subs.size === 1) { this.refresh(); this.timer = setInterval(() => { this.ticks += 1; if (this.state?.login?.phase === 'waiting' || this.ticks % 15 === 0) this.refresh() }, 2000) }
        return () => { this.subs.delete(fn); if (!this.subs.size && this.timer !== null) { clearInterval(this.timer); this.timer = null } }
      },
      async call(method, ...args) {
        if (typeof this.service?.[method] !== 'function') throw new Error(t('store.disconnected'))
        const result = await this.service[method](...args)
        if (!result || result.ok !== true) throw new Error(result?.error?.message || t('store.failed'))
        return result.value
      },
      async refresh() {
        if (!this.service) return
        const before = this.state?.login?.phase
        try { this.state = await this.call('agyState'); this.error = null } catch (error) { this.error = error?.message || String(error) }
        // ログインが終わったら、モデル選択とチェーンの選択肢にも反映する。
        if (before === 'waiting' && this.state?.login?.phase === 'done') { modelsStore.refresh(); setupStore.refresh() }
        this.emit()
      },
      async act(value) {
        if (this.busy) return null
        this.busy = true; this.emit()
        try { this.state = await this.call('agyAction', value); this.error = null } catch (error) { this.error = error?.message || String(error) }
        this.busy = false; this.emit()
        return this.state
      },
      toggle(modelId, visible) { return this.act({ action: visible ? 'show' : 'hide', modelId }) },
      setEnabled(enabled) { return this.act({ action: 'setEnabled', enabled }) },
      async login() {
        // ブラウザ版は、クリックの瞬間に空のタブを開いておく(あとから開くとポップアップとして遮断されるため)。
        let tab = null
        if (!isDesktop() && typeof window !== 'undefined' && typeof window.open === 'function') { try { tab = window.open('', '_blank') } catch {} }
        const state = await this.act({ action: 'login' })
        const url = state?.login?.url
        if (!url) { try { tab?.close() } catch {} return }
        try { if (tab && !tab.closed) tab.location.href = url; else if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener,noreferrer') } catch {}
      },
    }
    function useAgy() {
      const [, force] = useState(0)
      useEffect(() => agyStore.subscribe(() => force(n => n + 1)), [])
      return agyStore
    }
    function AgyCard() {
      const translate = useT()
      const store = useAgy()
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      if (!store.state) return store.error ? el('div', { className: 'mr-card', 'data-mr-agy': 'error' }, el('span', { className: 'mr-card-name' }, translate('agy.title')), el('p', { className: 'mr-error' }, store.error)) : null
      const head = el('div', { className: 'mr-card-head' },
        el('span', { className: 'mr-card-name' }, translate('agy.title')),
        btn(translate('agy.edit'), () => setOpen(!open)))
      const accounts = store.state.accounts || []
      const active = accounts.find(account => account.active)
      const models = store.state.models || []
      const visible = models.filter(model => !model.hidden)
      // オフはホストの印で決める(一覧が読めないときも正しく出す)。印が無ければ、全モデルを隠しているかで判断する。
      const enabled = store.state.disabled ? false : models.length === 0 || visible.length > 0
      const signedIn = accounts.some(account => account.signedIn)
      const login = store.state.login
      const status = el('div', { className: 'mr-card-status', 'data-mr-status': 'agy' },
        el('div', { className: 'mr-status-items' },
          el('span', { className: 'mr-status-item' },
            el('span', { className: 'mr-dot' + (signedIn && enabled ? ' mr-dot-ok' : '') }),
            el('span', { className: 'mr-status-label' }, translate('agy.accounts')),
            !enabled ? translate('status.disabled') : signedIn ? translate('agy.accountCount', { count: accounts.length }) + (active?.email ? ' ・ ' + translate('agy.activeAccount', { email: active.email }) : '') : translate('agy.noAccount'),
            models.length || store.state.disabled ? el('span', { className: 'mr-status-switch' }, el(ModelSwitch, { checked: enabled, label: translate('routes.enable', { name: 'Antigravity' }), disabled: store.busy, onChange: next => store.setEnabled(next) })) : null)),
        !enabled && el('p', { className: 'mr-hint' }, translate('agy.offHint')),
        !signedIn && !open && el('p', { className: 'mr-hint' }, translate('agy.signInHint')),
        store.state.unusable?.length ? el('div', { className: 'mr-actions', 'data-mr-agy-unusable': '' },
          el('span', { className: 'mr-hint' }, translate('agy.unusable', { count: store.state.unusable.length, names: store.state.unusable.join(', ') })),
          btn(translate('agy.resetUnusable'), () => store.act({ action: 'resetUnusable' }), { kind: 'link', disabled: store.busy })) : null,
        store.error && el('p', { className: 'mr-error' }, store.error))
      if (!open) return el('div', { className: 'mr-card', 'data-mr-agy': 'closed' }, head, status)
      const needle = query.trim().toLowerCase()
      const listed = needle ? models.filter(model => (model.id + ' ' + model.name).toLowerCase().includes(needle)) : models
      const accountList = el('div', { className: 'mr-sub' },
        el('span', { className: 'mr-sub-title' }, translate('agy.accountsTitle')),
        el('p', { className: 'mr-hint' }, translate('agy.accountsHint')),
        accounts.length ? el('ul', { className: 'mr-model-list' }, accounts.map(account => el('li', { key: account.n, className: 'mr-model-row' },
          el('span', { className: 'mr-model-name' }, el('span', null, account.email || translate('oauth.account', { n: account.n }), account.active ? el('span', { className: 'mr-kind' }, translate('oauth.active')) : null)),
          el('span', { className: 'mr-status' },
            el('span', { className: 'mr-dot' + (account.signedIn ? ' mr-dot-ok' : account.needsLogin ? ' mr-dot-warn' : '') }), translate(account.signedIn ? 'oauth.signedIn' : account.needsLogin ? 'agy.needsLogin' : 'oauth.signedOut'),
            !account.active && btn(translate('oauth.use'), () => store.act({ action: 'switch', n: account.n }), { disabled: store.busy }),
            btn(translate('oauth.remove'), () => { if (confirmed(translate('oauth.confirmRemove', { label: account.email || translate('oauth.account', { n: account.n }) }))) store.act({ action: 'remove', n: account.n }) }, { kind: 'danger', disabled: store.busy }))))) : null,
        el('div', { className: 'mr-actions' },
          btn(translate('agy.login'), () => store.login(), { kind: signedIn ? undefined : 'primary', disabled: store.busy || login?.phase === 'waiting' }),
          login?.phase === 'waiting' && btn(translate('btn.cancel'), () => store.act({ action: 'cancel' }), { kind: 'link', disabled: store.busy })),
        login?.phase === 'waiting' && el('div', { className: 'mr-actions' }, el('span', { className: 'mr-hint' }, translate('agy.loginOpened')), login.url && el('a', { className: 'mr-link', href: login.url, target: '_blank', rel: 'noopener noreferrer' }, translate('link.open'))),
        login?.phase === 'done' && el('span', { className: 'mr-status mr-status-ok' }, el('span', { className: 'mr-dot mr-dot-ok' }), translate('agy.loginDone', { email: login.email || '' })),
        login?.phase === 'error' && el('p', { className: 'mr-error' }, translate('attempt.error', { message: login.error || translate('attempt.errorUnknown') })))
      const toggles = el('div', { className: 'mr-sub' }, el('div', { className: 'mr-models' },
        el('div', { className: 'mr-models-head' }, el('span', { className: 'mr-field-label' }, translate('models.title'), el('span', { className: 'mr-kind' }, translate('models.oauth')))),
        el('p', { className: 'mr-hint' }, models.length > SEARCH_THRESHOLD ? translate('models.count', { shown: visible.length, total: models.length }) : translate('models.hint')),
        models.length > SEARCH_THRESHOLD && el('input', { className: 'mr-input', type: 'search', value: query, placeholder: translate('models.search'), 'aria-label': translate('models.search'), autoComplete: 'off', spellCheck: false, onChange: event => setQuery(event.target.value) }),
        models.length === 0 ? el('p', { className: 'mr-hint' }, translate('models.none'))
          : listed.length === 0 ? el('p', { className: 'mr-hint' }, translate('models.noMatch'))
          : el('ul', { className: 'mr-model-list' }, listed.map(model => el('li', { key: model.id, className: 'mr-model-row' },
            el('span', { className: 'mr-model-name' }, el('span', null, model.name || model.id), el('span', { className: 'mr-model-id' }, model.id)),
            el(ModelSwitch, { checked: !model.hidden, label: translate('models.show', { name: model.name || model.id }), disabled: store.busy, onChange: next => store.toggle(model.id, next) }))))))
      return el('div', { className: 'mr-card', 'data-mr-agy': 'open' }, head, status, el('div', { className: 'mr-extras' }, accountList, toggles))
    }

    // ───────────── 設定「モデルルート」ページ(代替チェーン・アカウント・用途別) ─────────────
    const setupStore = {
      service: null, state: null, error: null, busy: false, notice: '', subs: new Set(),
      bind(service) { this.service = service; this.state = null; this.error = service ? null : t('store.disconnected'); if (service && this.subs.size) this.refresh(); else this.emit() },
      emit() { for (const fn of [...this.subs]) fn() },
      subscribe(fn) { this.subs.add(fn); if (this.subs.size === 1) this.refresh(); return () => { this.subs.delete(fn) } },
      async call(method, ...args) {
        if (typeof this.service?.[method] !== 'function') throw new Error(t('store.disconnected'))
        const result = await this.service[method](...args)
        if (!result || result.ok !== true) throw new Error(result?.error?.message || t('store.failed'))
        return result.value
      },
      async refresh() {
        if (!this.service) return
        try { this.state = await this.call('getSetup'); this.error = null } catch (error) { this.error = error?.message || String(error) }
        this.emit()
      },
      async act(method, notice, ...args) {
        if (this.busy) return false
        this.busy = true; this.notice = ''; this.emit()
        let done = false
        try { this.state = await this.call(method, ...args); this.error = null; this.notice = notice || ''; done = true } catch (error) { this.error = error?.message || String(error) }
        this.busy = false; this.emit()
        // 追加アカウントは、モデル画面のカードにも出るため読み直す。
        if (done && (method === 'addAccount' || method === 'removeAccount')) modelsStore.refresh()
        return done
      },
    }
    function useSetup() {
      const [, force] = useState(0)
      useEffect(() => setupStore.subscribe(() => force(n => n + 1)), [])
      return setupStore
    }
    // サービスとモデルを選ぶ2つの欄。サービスを選ぶと、その一覧の先頭(新しいもの)を選ぶ。
    function ModelPicker({ value, catalog, onChange, disabled, translate }) {
      const provider = catalog.find(item => item.provider === value?.provider)
      return el('span', { className: 'mr-step' },
        el('select', { className: 'mr-select', value: value?.provider || '', disabled, 'aria-label': translate('chains.selectProvider'),
          onChange: event => { const next = catalog.find(item => item.provider === event.target.value); onChange(next ? { provider: next.provider, model: next.models[0]?.id || '' } : null) } },
          el('option', { value: '' }, translate('chains.selectProvider')),
          // 保存済みの選択が今の一覧に無い(キー未登録の追加アカウントなど)ときも、消さずにそのまま見せる。
          value?.provider && !provider && el('option', { value: value.provider }, translate('chains.unlisted', { name: accountName(catalog, value.provider) })),
          catalog.map(item => el('option', { key: item.provider, value: item.provider }, item.name))),
        el('select', { className: 'mr-select', value: value?.model || '', disabled: disabled || !provider, 'aria-label': translate('chains.selectModel'), onChange: event => onChange({ provider: value.provider, model: event.target.value }) },
          el('option', { value: '' }, translate('chains.selectModel')),
          value?.model && !provider?.models?.some(model => model.id === value.model) && el('option', { value: value.model }, value.model),
          (provider?.models || []).map(model => el('option', { key: model.id, value: model.id }, model.name))))
    }
    // 追加アカウントのルート(anthropic-api-2)は、一覧に無くても「Claude #2」と読めるようにする。
    function accountName(catalog, id) {
      const match = /^(.*)-(\d)$/.exec(id || '')
      const base = match && catalog.find(item => item.provider === match[1])
      return base ? base.name + ' #' + match[2] : id
    }
    const providerName = (catalog, id) => catalog.find(item => item.provider === id)?.name || accountName(catalog, id)
    function ChainsTab({ store, translate }) {
      const state = store.state
      const [draft, setDraft] = useState(null)
      const chains = draft || state.chains
      const catalog = state.catalog || []
      const edit = next => setDraft(next)
      const update = (index, patch) => edit(chains.map((chain, i) => i === index ? { ...chain, ...patch } : chain))
      const move = (list, from, to) => { const next = list.slice(); const [item] = next.splice(from, 1); next.splice(to, 0, item); return next }
      const addChain = () => {
        const used = new Set(chains.map(chain => chain.id))
        let n = 1; while (used.has(n === 1 ? 'main' : 'chain-' + n)) n++
        edit([...chains, { id: n === 1 ? 'main' : 'chain-' + n, name: n === 1 ? translate('chains.defaultName') : translate('chains.defaultName') + ' ' + n, steps: [], accounts: true }])
      }
      const save = async () => { if (await store.act('saveChains', translate('chains.saved'), { chains })) setDraft(null) }
      const describe = item => providerName(catalog, item.provider) + (item.account ? ' (' + translate('oauth.account', { n: item.account }) + ')' : '') + ' / ' + item.model
      return el('div', { className: 'mr-extras' },
        el('p', { className: 'mr-hint' }, translate('chains.hint')),
        chains.length === 0 && el('p', { className: 'mr-hint' }, translate('chains.none')),
        chains.map((chain, index) => {
          const result = state.results?.[chain.id]
          return el('div', { key: chain.id, className: 'mr-card', 'data-mr-chain': chain.id },
            el('div', { className: 'mr-card-head' },
              el('input', { className: 'mr-input', value: chain.name, 'aria-label': translate('chains.name'), onChange: event => update(index, { name: event.target.value }) }),
              btn(translate('chains.remove'), () => edit(chains.filter((_, i) => i !== index)), { kind: 'danger', disabled: store.busy })),
            chain.steps.map((step, i) => el('div', { key: i + ':' + step.provider + ':' + step.model, className: 'mr-step' },
              el('span', { className: 'mr-step-label' }, i === 0 ? translate('chains.primary') : i === 1 ? translate('chains.secondary') : translate('chains.step', { n: i + 1 })),
              el(ModelPicker, { value: step, catalog, translate, disabled: store.busy, onChange: next => update(index, { steps: chain.steps.map((item, j) => j === i ? (next || item) : item) }) }),
              btn('↑', () => update(index, { steps: move(chain.steps, i, i - 1) }), { kind: 'link', disabled: store.busy || i === 0 }),
              btn('↓', () => update(index, { steps: move(chain.steps, i, i + 1) }), { kind: 'link', disabled: store.busy || i === chain.steps.length - 1 }),
              btn(translate('chains.removeStep'), () => update(index, { steps: chain.steps.filter((_, j) => j !== i) }), { kind: 'link', disabled: store.busy }))),
            el('div', { className: 'mr-actions' }, btn(translate('chains.addStep'), () => update(index, { steps: [...chain.steps, { provider: '', model: '' }] }), { disabled: store.busy })),
            el('label', { className: 'mr-check' }, el('input', { type: 'checkbox', checked: chain.accounts !== false, disabled: store.busy, onChange: event => update(index, { accounts: event.target.checked }) }), translate('chains.accounts')),
            result && el('p', { className: 'mr-hint' }, result.provider
              ? translate('chains.last', { target: describe(result) }) + (result.tried?.length ? ' ' + translate('chains.lastFallback', { tried: result.tried.map(item => describe(item) + ' ' + (item.code || '')).join(' → ') }) : '')
              : translate('chains.lastFailed', { tried: (result.tried || []).map(item => describe(item) + ' ' + (item.code || '')).join(' → ') })))
        }),
        el('div', { className: 'mr-actions' },
          btn(translate('chains.add'), addChain, { disabled: store.busy }),
          btn(translate('chains.save'), save, { kind: 'primary', disabled: store.busy || !draft }),
          draft && el('span', { className: 'mr-hint' }, translate('chains.unsaved'))))
    }
    // サブスク(OAuth)の複数アカウント。使用中のアカウントが未ログインなら、その場でログインできる。
    function OauthAccounts({ store, translate }) {
      const auth = useAuth()
      const services = store.state.oauth || []
      if (!services.length) return null
      return el('div', { className: 'mr-extras', 'data-mr-oauth': '' },
        el('span', { className: 'mr-sub-title' }, translate('oauth.title')),
        el('p', { className: 'mr-hint' }, translate('oauth.hint')),
        services.map(service => {
          const attempt = auth.state?.attempt?.routeId === service.routeId ? auth.state.attempt : null
          const active = service.accounts.find(account => account.active)
          const nameOf = account => account.label || translate('oauth.account', { n: account.n })
          return el('div', { key: service.routeId, className: 'mr-card', 'data-mr-oauth-route': service.routeId },
            el('div', { className: 'mr-card-head' }, el('span', { className: 'mr-card-name' }, service.label),
              service.accounts.length < 9 && btn(translate('oauth.add'), async () => { if (await store.act('oauthAction', translate('oauth.addedHint'), { action: 'add', routeId: service.routeId })) authStore.refresh() }, { disabled: store.busy })),
            service.error && el('p', { className: 'mr-error' }, service.error),
            el('ul', { className: 'mr-model-list' }, service.accounts.map(account => el('li', { key: account.n, className: 'mr-model-row' },
              el('span', { className: 'mr-model-name' }, el('span', null, nameOf(account), account.active ? el('span', { className: 'mr-kind' }, translate('oauth.active')) : null)),
              el('span', { className: 'mr-status' },
                el('span', { className: 'mr-dot' + (account.signedIn ? ' mr-dot-ok' : '') }), translate(account.signedIn ? 'oauth.signedIn' : 'oauth.signedOut'),
                !account.active && btn(translate('oauth.use'), async () => { if (await store.act('oauthAction', '', { action: 'switch', routeId: service.routeId, n: account.n })) authStore.refresh() }, { disabled: store.busy }),
                account.active && !account.signedIn && !attempt && btn(translate('oauth.login'), () => authStore.startLogin(service.routeId), { kind: 'primary', disabled: auth.busy }),
                service.accounts.length > 1 && btn(translate('oauth.remove'), async () => { if (confirmed(translate('oauth.confirmRemove', { label: nameOf(account) })) && await store.act('oauthAction', '', { action: 'remove', routeId: service.routeId, n: account.n })) authStore.refresh() }, { kind: 'danger', disabled: store.busy }))))),
            attempt && el(AttemptView, { store: auth, attempt, translate }),
            active && !active.signedIn && attempt?.phase === 'done' && el('p', { className: 'mr-hint' }, translate('attempt.done')))
        }))
    }
    function AccountsTab({ store, translate }) {
      const services = store.state.accounts || []
      return el('div', { className: 'mr-extras' },
        el(OauthAccounts, { store, translate }),
        el('div', { className: 'mr-divider' }),
        el('span', { className: 'mr-sub-title' }, translate('tab.accounts') + ' (API)'),
        el('p', { className: 'mr-hint' }, translate('accounts.hint')),
        services.map(service => {
          const next = [2, 3, 4, 5, 6, 7, 8, 9].find(n => !service.accounts.some(account => account.n === n))
          return el('div', { key: service.routeId, className: 'mr-card', 'data-mr-accounts': service.routeId },
            el('div', { className: 'mr-card-head' }, el('span', { className: 'mr-card-name' }, service.service),
              next && btn(translate('accounts.add', { n: next }), () => store.act('addAccount', '', service.routeId), { disabled: store.busy })),
            el('ul', { className: 'mr-model-list' }, service.accounts.map(account => el('li', { key: account.routeId, className: 'mr-model-row' },
              el('span', { className: 'mr-model-name' }, el('span', null, account.label), el('span', { className: 'mr-model-id' }, translate('accounts.keyName', { env: account.keyEnv }))),
              el('span', { className: 'mr-status' }, el('span', { className: 'mr-dot' + (account.registered ? ' mr-dot-ok' : '') }), translate(account.registered ? 'accounts.registered' : 'accounts.missing'),
                account.n > 1 && btn(translate('accounts.remove'), () => { if (confirmed(translate('accounts.confirmRemove', { label: account.label }))) store.act('removeAccount', '', account.routeId) }, { kind: 'danger', disabled: store.busy }))))))
        }),
        el('p', { className: 'mr-hint' }, translate('accounts.oauthNote')))
    }
    // 用途別モデル。提供元の一覧(新しい順)から選び、用途ごとのスイッチで道具として使うかを決める。
    // 新しく選んだ用途は無効のまま(スイッチを入れるまで道具にならない)。
    function MediaTab({ store, translate }) {
      const state = store.state
      const [draft, setDraft] = useState(null)
      const media = draft || state.media || {}
      const save = async () => { if (await store.act('saveMedia', translate('chains.saved'), { media })) setDraft(null) }
      const reload = () => store.act('reloadMediaModels', translate('media.reloaded'))
      const set = (kind, next) => { const copy = { ...media }; if (next) copy[kind] = next; else delete copy[kind]; setDraft(copy) }
      return el('div', { className: 'mr-extras' },
        el('p', { className: 'mr-hint' }, translate('media.hint')),
        el('div', { className: 'mr-actions' }, btn(translate('media.reload'), reload, { disabled: store.busy })),
        el('ul', { className: 'mr-model-list' }, (state.mediaKinds || []).map(kind => {
          const catalog = state.mediaCatalog?.[kind] || []
          const current = media[kind]
          const name = translate('media.' + kind)
          // enabled が無いのは、スイッチができる前に選んだ用途(ホストも有効として扱う)。
          const on = !!current && current.enabled !== false
          return el('li', { key: kind, className: 'mr-model-row', 'data-mr-media': kind },
            el('span', { className: 'mr-model-name' }, name),
            el('span', { className: 'mr-step' },
              catalog.length || current
                ? el(ModelPicker, { value: current, catalog, translate, disabled: store.busy, onChange: next => set(kind, next ? { ...next, enabled: on } : null) })
                : el('span', { className: 'mr-hint' }, translate('media.noModels')),
              // 解除が無い行も同じ幅を空けて、行どうしの欄の位置をそろえる。
              current ? btn(translate('media.clear'), () => set(kind, null), { kind: 'link', disabled: store.busy }) : el('span', { className: 'mr-media-spacer', 'aria-hidden': 'true' }, btn(translate('media.clear'), () => {}, { kind: 'link', disabled: true })),
              el(ModelSwitch, { checked: on, label: translate('media.enabled', { name }), title: translate('media.enabled', { name }), disabled: store.busy || !current?.model, onChange: on => set(kind, { ...current, enabled: !!on }) })))
        })),
        el('div', { className: 'mr-actions' },
          btn(translate('chains.save'), save, { kind: 'primary', disabled: store.busy || !draft }),
          draft && el('span', { className: 'mr-hint' }, translate('chains.unsaved'))))
    }
    function ModelRoutesPage() {
      const translate = useT()
      const store = useSetup()
      const [tab, setTab] = useState('chains')
      const tabs = [['chains', 'tab.chains'], ['accounts', 'tab.accounts'], ['media', 'tab.media']]
      const body = !store.state
        ? el('p', { className: store.error ? 'mr-error' : 'mr-hint' }, store.error ? translate('page.error', { message: store.error }) : translate('page.loading'))
        : el(tab === 'accounts' ? AccountsTab : tab === 'media' ? MediaTab : ChainsTab, { store, translate })
      return el('div', { className: 'mr-page', 'data-mr-page': '' },
        el('h2', { className: 'mr-page-title' }, translate('page.title')),
        el('div', { className: 'mr-tabs', role: 'tablist' }, tabs.map(([id, key]) => el('button', { key: id, type: 'button', role: 'tab', className: 'mr-tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, translate(key)))),
        body,
        store.state && store.error && el('p', { className: 'mr-error' }, store.error),
        store.notice && el('p', { className: 'mr-hint', role: 'status' }, store.notice))
    }

    // ───────────── 登録 ─────────────
    const inject = ['remote', 'slots', 'locale']
    async function apply(ctx) {
      const effect = (fn, label) => { if (typeof ctx.effect === 'function') ctx.effect(fn, label); else fn() }
      // 辞書を DSH の locale サービスへ登録する(言語ごとに独立。未対応の言語は en にフォールバック)。
      localeService = ctx.locale || ctx.get?.('locale') || null
      if (localeService?.register) {
        for (const lang of Object.keys(DICT)) {
          try { effect(() => localeService.register(NS, lang, DICT[lang]), 'model-routes: dictionary ' + lang) } catch (error) { try { console.warn('dsh-model-routes: 辞書を登録できません', lang, error) } catch {} }
        }
      }
      effect(() => () => { localeService = null }, 'model-routes: locale')
      effect(installStyles, 'model-routes: styles')
      const slots = ctx.slots || ctx.get?.('slots')
      if (slots) {
        // 各プロバイダのカード(設定のモデル画面)へ「サブスク」欄を差し込む。キーは llm-pi-ai の設定名前空間。
        // DSH 標準の DeepSeek の行は別の名前空間(llm-deepseek)なので、状態行のために別に登録する。
        for (const key of ['llm-pi-ai', 'llm-deepseek']) {
          const card = () => slots.register({ name: 'settings.models.provider-card', key }, ProviderCardExtension)
          effect(() => slots.inject('settings.models.provider-card', card), 'model-routes: provider card ' + key)
        }
        // 設定「モデルルート」ページ(「モデル」のすぐ下)。
        effect(() => slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'model-routes', order: 11, label: () => t('page.title') }, ModelRoutesPage)), 'model-routes: settings page')
        // Antigravity のカード。DSH のカード一覧に乗らないため、モデル画面の末尾に置く。
        effect(() => slots.inject('settings.models.footer', () => slots.register({ name: 'settings.models.footer', id: 'model-routes-agy' }, AgyCard)), 'model-routes: antigravity card')
      }
      // ログイン操作はホストの modelRoutesAuth サービスへ(DSH内部通信)。繋がらなくても、他の表示は動く。
      try {
        const remote = ctx.remote || ctx.get?.('remote')
        if (typeof remote?.$mount === 'function') {
          const unmount = await remote.$mount(CONTRIBUTION)
          const service = ctx.get?.('remote.modelRoutesAuth')
          if (!service) { unmount(); throw new Error('modelRoutesAuth RPC が見つかりません') }
          authStore.bind(service)
          modelsStore.bind(ctx.get?.('remote.modelRoutesModels') || null)
          setupStore.bind(ctx.get?.('remote.modelRoutesSetup') || null)
          agyStore.bind(ctx.get?.('remote.modelRoutesSetup') || null)
          effect(() => () => { authStore.bind(null); modelsStore.bind(null); setupStore.bind(null); agyStore.bind(null); unmount() }, 'model-routes: internal RPC')
        }
      } catch (error) { try { console.warn('dsh-model-routes: ログイン用の内部通信に接続できません', error) } catch {} }
    }
    exports.apply = apply
    exports.inject = inject
    exports.__test = { OauthAccounts, ModelRoutesPage, ChainsTab, AccountsTab, MediaTab, setupStore, AgyCard, agyStore, sortModelsByVersion, BUILTIN_KEY_ROUTES, CardStatus, SubscriptionRow, API_OF_SUBSCRIPTION, WhenEditing, ModelToggles, ModelSwitch, modelsStore, useModels, DICT, BADGES, badgeCss, baseCss, installStyles, authStore, CONTRIBUTION, ProviderCardExtension, SubscriptionSection, HideRow, SUBSCRIPTION_OF_API, useAuth, t, fallbackT, methodLabel, PromptForm, AttemptView }
    return module.exports
  },
})
