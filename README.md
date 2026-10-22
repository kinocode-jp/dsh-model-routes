# @kinocode/dsh-model-routes

DeepSeek Harness で各種 LLM（Claude, OpenAI, Gemini, Grok, OpenCode 等）の **「OAuth 枠」**(サブスクのログイン)と **「API キー枠」** を独立登録し、公式にない独自モデル（OpenCode, CommandCode, Grok, ローカル Ollama/vLLM 等）も自由に追加でき、モデル一覧での **表示・非表示** を自在に制御できるマルチプロバイダ・モデルルート管理プラグインです。

## 枠の分け方と表示名

| 枠 | 認証 | 表示名 | 対象 |
|---|---|---|---|
| API (`api`) | APIキーだけ。`apiKeyEnv` を必ず持つ | サービス名だけ(例: `Claude`) | Claude、OpenAI、Grok、Gemini、OpenCode Zen、Command Code |
| OAuth (`subscription`) | OAuth ログインだけ。APIキー名は持たない | `サービス名 (OAuth)`(例: `Claude (OAuth)`) | Claude、OpenAI (Codex)、Grok |

- **APIキーでしか使えないサービスは OAuth 枠に置きません。** Gemini と OpenCode Zen は、DSH が使う pi-ai に OAuth ログインがないため API 枠だけです。
- 共有カタログの `validateCatalog()` が、OAuth 枠に APIキー名がある、OAuth 枠のプロバイダに OAuth ログインがない、API 枠に `apiKeyEnv` がない、表示名の付け方が違う、のどれかを検出します。
- 1つのルートが同時に使えるのは1つの認証だけなので、内部ではサービスごとに「OAuth」と「API」の2ルートを持ちます(`anthropic` と `anthropic-api` など)。
- OpenCode の旧ルート `opencode-api`(接続先 `api.opencode.ai/v1`)は廃止し、pi-ai 同梱の OpenCode Zen(`opencode` / `https://opencode.ai/zen/v1`)に一本化しました。

## 設定の「モデル」画面

DSH 標準のモデル画面には API キー欄しかなく、OAuth のログインを行う画面も、モデルごとの表示を決める画面もありません。また、行の見出しの点(緑・赤)は API キーの有無だけを表すため、OAuth でログイン済みでも赤く見えます。このプラグインは、各サービスの行に次を足します。

```
Claude  ●                           [編集]
  ● API キー 登録済み   ● OAuth ログイン済み   ← 状態行(閉じていても常に出す)
  └ 編集を開くと
     API キー(DSH 標準の入力欄)
     モデル一覧に表示するモデル [API]      ← オン/オフのスイッチ
     Claude (OAuth)                        ← ログイン状態・ログイン/ログアウト
       モデル一覧に表示するモデル [OAuth]  ← オン/オフのスイッチ
```

- **状態行**: 見出しの下に「API キー 登録済み/未登録」と、OAuth のあるサービスは「OAuth ログイン済み/未ログイン/無効」を出します。どちらも使えないときは「モデル一覧に出ない」ことと、登録するかオフにする案内を出します。API キーの状態は DSH がカードに渡す値(`keyConfigured`)、OAuth は DSH の資格情報の記録で判定します。DSH 標準の DeepSeek(`deepseek-official`)の行にも、DSH が渡す API キーの状態で出します。カスタム枠(`customProviders`)はキー不要のものがあるため出しません。
- **行は1つ**: Claude・OpenAI・Grok は、API 枠の行に OAuth 側をまとめます。OAuth 用の別の行は、カードの中から隠します(DSH の公式スロット `settings.models.provider-card` を使用。状態を読み込めないときは隠しません)。API 枠をオフにしても API の行は残るため(下の「ルート全体の切り替え」)、OAuth の行はいつも API の行にまとめます。Gemini など API だけのサービスは、モデルの表示スイッチだけを足します。ルート全体の有効・無効は、カードの状態行にある各枠のスイッチで切り替えます。
- **OAuth ログイン**: 「ログイン」で認証ページを開き、表示されたコードを貼ります。ログアウト・再ログイン・取り消しもできます。ログイン処理は DSH の認証サービス(`ctx.authorization`)に任せ、画面とは DSH 内部通信(Typert の `modelRoutesAuth`)でつなぎます。認証コードは記録せず、状態にも出しません。
- **ルート全体の切り替え**: 各カードの状態行で、枠(API / OAuth)ごとの状態の横にオン・オフのスイッチを置きます(DSH 標準の DeepSeek には出しません)。確認なしで切り替えます。オフにした API 枠・カスタム枠は、設定から消さずに**モデル0件のルート**として残します(表示名・接続先・キー名はそのまま)。そのためカードは消えず、「API キー オフ」と表示したまま、同じスイッチで戻せます。OAuth 枠はカードを持たない(API 枠のカードにまとめる)ため、オフにすると設定から外します。画面の末尾に別の欄は作りません。無効な API 枠のキーを編集する場合は、まず有効にしてから、そのサービスの DSH 標準の編集欄を開きます。ここではキーを入力・削除しません。API / OAuth の認証とモデル選択は変更せず、従来の `modelRoutes.setRouteEnabled` をモデル側の内部通信 `modelRoutesModels.setRouteEnabled(routeId, enabled)` から呼びます。
- **モデルの表示**: スイッチをオンにしたモデルだけが、モデル選択の一覧に出ます。保存は `~/.dsh/storages/model-routes/overrides.json` の `models`(設定ファイルは書き換えません)で、押すとすぐ反映します。「既定に戻す」で、そのルートの設定を消します。API 枠は、キー入力欄を残すため、最後の1つは隠せません(OAuth 枠は全部隠せます)。DSH 内部通信は `modelRoutesModels` です。
- **登録した方だけが一覧に出る**: API だけ・OAuth だけ・両方のどれでも、登録した方式のモデルが出ます。両方なら、2つのグループ(`Claude` と `Claude (OAuth)`)が並び、モデル名の横のバッジ(`API` / `OAuth`)でも区別できます。
- **ログインが切れたとき**: エラーに `invalid_grant` と出たら、OAuth 欄で「ログアウト」のあと、もう一度ログインします。
- **認証ページが開かないとき**: Desktop 版は `window.open` で開きます(DSH 本体がシステムブラウザで開きます)。ブラウザ版は、クリックの瞬間に空のタブを先に開き、URL が届いたらそのタブへ移動します。どちらも、欄に「認証ページを開く」のリンクを出します。
- **言語**: ja / en / zh の辞書を DSH の `ctx.locale`(名前空間 `model-routes`)に登録します。言語の切り替えにすぐ追従し、他の言語は en にフォールバックします。ホストのエラー文も DSH の言語設定で返します。
- **見た目**: DSH のモデル設定ページと同じデザイントークン(`--dsw-alias-*`、`--dsw-radius-*`)と寸法で、ライト/ダークに追従します。文字・余白・部品の寸法は設定の「一般」に合わせ、本文 14px/22px、補足 12px/18px、スイッチ 36×20px、ボタンは 36px(角丸12px)または 28px(角丸8px)です。ログイン方法の選択は、pi-ai の選択肢 `{ id, label }` の `id` を返します。

### 更新の反映 / Activation / 更新生效

- **日本語**: 今回はホストの RPC 定義も追加しているため、DSH を再起動し、接続中のブラウザ画面も再読み込みしてください。クライアントだけ更新された場合はルートスイッチを出さず、再起動の案内を表示します。プロバイダの登録方式や資格情報の保存方式は変更しません。
- **English**: All model controls live in the existing **Models** settings page: a status line (API key / OAuth) and, when editing, OAuth and model visibility in the provider cards; route on/off switches on each card’s status line; a turned-off API or custom route stays as a route with no models, so its card remains and shows “Off”; enable an API route before opening its standard DSH key editor. No duplicate secrets panel or new settings category is added. Usage-bars owns quota display/settings and quota-only keys, not model routes or model API keys. Restart DSH **and reload the browser** after this update because the host RPC manifest changed; a client connected to an older host shows a restart hint instead of route switches.
- **中文**: 模型相关操作仅在现有的「模型」设置中：提供商卡片显示 API 密钥 / OAuth 状态行，编辑时提供 OAuth 登录和模型显示开关；各卡片状态行上的开关控制 API/OAuth 渠道的启用状态；关闭的 API 渠道和自定义渠道以“无模型的渠道”保留，卡片不会消失，并显示为“已关闭”；编辑 API 密钥前请先启用渠道，再使用 DSH 标准编辑器。不会增加独立设置分类或重复的密钥面板。使用量设置仅负责配额显示及其专用密钥。本次增加了主机 RPC 定义，更新后须**重启 DSH 并重新加载浏览器**；旧主机连接会显示重启提示，而不提供新开关。

## 設定「モデルルート」ページ(代替チェーン・アカウント・用途別)

DSH のモデル画面にはタブを足す口が無いため、設定に「モデルルート」ページ(`settings.section`、「モデル」のすぐ下)を足し、その中をタブにしています。設定は `~/.dsh/storages/model-routes/setup.json` に保存します(プロファイルの設定ファイルは書き換えません)。

### 代替チェーン(プライマリ → 別アカウント → セカンダリ)

- チェーンは、このプラグインが登録する仮想プロバイダ `model-routes`(表示名「代替チェーン」)のモデルとして、モデル選択に「代替チェーン › メイン」のように出ます。`ctx.llm.registerAdapter` で登録します。基底には DSH の `LlmAdapter`(`@deepseek-ai/dsh-llm`)を使いますが、このプラグインをプロファイルの外(`link:` で別の場所)に置いていると DSH 内部のパッケージを読み込めないため、そのときは同じ既定の動きを持つ自前の基底(`AdapterBase`)を使います(登録側は型を確かめません。実機で確認済み)。
- 送る順番: 1段目(プライマリ)→ そのサービスの追加アカウント(#2, #3 …)→ 2段目(セカンダリ)→ その追加アカウント → …。「各モデルの別アカウントも順に試す」を外すと、追加アカウントは試しません。
- 各候補へは `ctx.llm.stream()` で送り、最初の本文(文字・推論・ツール呼び出し)が届く前に失敗(制限・枠切れ・認証切れ・サーバーエラーなど、エラーで終わった応答)したら次の候補へ回します。本文が出始めたあとの失敗は切り替えません(書きかけの返答を別のモデルへ引き継げないため)。
- 全候補が失敗したときは、最後の失敗の種類のまま、試した順と理由を文面に並べて返します。
- 文脈の長さ・推論の段階は、最初に解決できた候補のものを使います。
- 直近にどの候補が答えたか(切り替えの経過)を、チェーンの欄に出します。
- 制約: 候補をまたぐと、Anthropic の思考の署名など、プロバイダ固有の再送情報は引き継がれません(DSH の仕様)。

### アカウント(API キーの複数登録)

- API キーで使うサービス(Claude・OpenAI・Gemini・Grok・Command Code)に、2本目以降のキーを登録できます(最大 #9)。追加すると、同じ接続先・同じモデルの表示で、キー名だけ番号付きの別ルートを作ります(例: `anthropic-api-2`、キー名 `ANTHROPIC_API_KEY_2`、表示名「Claude #2」)。
- キーは、モデル画面にできる「Claude #2」カードの「編集」(DSH 標準の欄)で入力します。このページではキーを入力・表示しません。
- 手動の切り替え: モデル選択で「Claude」と「Claude #2」を選び分けます。自動の切り替え: 代替チェーンが順に試します。
- 外しても、保存済みのキーは消しません。
- OpenCode Zen は、DSH 同梱の `opencode` ルートの接続方式に頼るため、同じ形の別ルートを作れず、対象外です。

### アカウント(サブスク・OAuth の複数登録)

- Claude・OpenAI (Codex)・Grok のサブスクに、複数のアカウントを登録できます(最大 9)。
- DSH の pi-ai はログインをサービスごとに1件(資格情報の記録 `llm-pi-ai/<ルートID>`)で持ちます。このプラグインは、使っていないアカウントのログイン記録を同じ資格情報の中に `model-routes/oauth-<ルートID>-<番号>` として保管し、「使う」で切り替えるときに `llm-pi-ai/<ルートID>` と入れ替えます。DSH の接続処理はそのまま使います。
- トークンの自動更新は DSH が使用中の記録に書きます。資格情報の更新通知のたびに、その内容を使用中アカウントの保管先へ写します(内容が同じなら書きません)。
- 「アカウントを追加」は、今のログインを保管してから、新しい番号を使用中(未ログイン)にします。同じ欄の「ログイン」で、そのアカウントでログインします。
- 手動の切り替え: 「使う」。自動の切り替え: 代替チェーンで、そのサービスの候補が失敗したら、ログイン済みの次のアカウントへ切り替えて同じモデルで試します(セカンダリへ行く前)。切り替えたまま使い続けます。
- 1つのサービスで同時に使えるのは「使用中」の1アカウントだけです(DSH の記録が1件のため)。

### 用途別

画像生成・音声入力の文字起こし・読み上げ・動画生成に使うモデルを選んで保存します(`setup.json` の `media`)。一覧に無いモデル ID も入力できます。これを使う道具は、まだありません(次の段階)。

## Antigravity(自前の接続。他のプラグインは不要)

Antigravity(Google Cloud Code Assist の内部 API)を、このプラグインだけで使います。モデル選択では「Antigravity › モデル名」として出ます(プロバイダ ID `antigravity`。dsh-agy の `agy` とは別なので、両方入っていてもぶつかりません)。

- **送受信の形式**: リクエストの組み立て・SSE の読み取り・モデル一覧・識別子は、dsh-agy 0.4.6(MIT, https://github.com/chaos-03x/dsh-agy)から `lib/agy/vendor/` に移植しました(読み込み先だけを書き換え。`LICENSE.dsh-agy` を同梱)。DSH 内部のパッケージに頼る部分は、同じ動きの小さな代わり(`dsh-llm-shim.mjs`)に置き換えています。
- **ここで作ったもの**(`lib/agy/index.mjs`): アカウント(複数)、Google ログイン、トークンの更新、プロジェクト ID の取得、接続処理(DSH の LlmAdapter 相当)、モデルの表示/非表示。
- **ログイン**: 「編集」→「アカウントを追加(ログイン)」で、この機械の一時的な受け口(`http://localhost:<空いている番号>/oauth-callback`)へ戻る Google のログインページを開きます。ログインすると、メールアドレス・プロジェクト ID を取得して保存します。同じメールで再ログインすると、そのアカウントを更新します。
- **保存先**: トークンは DSH の資格情報に `model-routes/agy-<番号>` として保存します。使用中の番号・非表示のモデルは `setup.json` の `agy` です。
- **手動の切り替え**: アカウント一覧の「使う」。**自動の切り替え**: 制限(429)・枠切れ・ログイン切れのとき、本文が出る前なら、ログイン済みの次のアカウントで送り直し、そのアカウントを使用中に残します。要求の誤りなど、アカウントを替えても直らない失敗はそのまま返します。
- **オフ**: 全モデルを非表示にし、オンでオフ前の表示に戻します。
- **モデル一覧**: ログイン前は、どのアカウントでも出す控えの一覧を出します。ログイン・切り替えの直後に、そのアカウントの実際の一覧へ読み直します。一覧に出ていても、アカウント(プラン)によっては会話に使えないモデルがあります(段階付きの `-low` / `-medium` / `-high` など。サーバーは 404 を返します)。その場合は「このモデルは今のアカウントでは使えません」と返すので、`-tiered` などを選んでください。
- **ログイン切れ**: トークンの更新を拒まれたアカウントには印を付け、一覧で「再ログインが必要」と出します。同じメールでログインし直すと消えます。
- **実機での確認**: 2026-10-22 に、Gemini 3.8 Flash(`gemini-3.8-flash-tiered`)で応答を確認しました。わざと壊したアカウントを使用中にして送ると、ログイン切れで次のアカウントへ切り替えて応答し、使用中がそのアカウントに戻ることも確認しました。
- **識別情報**: Antigravity アプリと同じ固定の1種類だけを送ります(dsh-agy の stable モード相当)。アカウントごとに端末の識別情報を偽装・乱数化する機能、枠を使い切らせるための並べ替え、プロキシは持ちません。
- **注意**: Antigravity アプリ用の OAuth クライアントと内部 API を、アプリ以外から使う仕組みです(dsh-agy と同じ)。Google の利用規約上の扱いは保証されず、アカウントが制限される可能性があります。
- 思考予算の細かい設定・使用量の統計・プロキシなど、dsh-agy にある細かい機能は持ちません。

## 提供モデルの取得

カタログに手で書いたモデルだけでは、古くなったり少なすぎたりするため、起動時(と 12 時間ごと)に各枠の提供モデルの一覧を取得し、モデルの表示スイッチの候補に足します。

| 枠 | 取得元 | 外すもの |
|---|---|---|
| Claude (OAuth) / Claude (API) | DSH(pi-ai)の同梱カタログ `anthropic` | 日付付きの別名(`-20251101` など) |
| OpenAI (OAuth) | 同梱カタログ `openai-codex` | なし |
| OpenAI (API) | 同梱カタログ `openai` | `realtime`(音声用) |
| Gemini (API) | 同梱カタログ `google` | `deep-research`・画像・`live`・`computer-use`・`customtools` |
| Grok (OAuth) / Grok (API) | 同梱カタログ `xai` | なし |
| OpenCode Zen | 同梱カタログ `opencode` | なし |
| Command Code | `https://api.commandcode.ai/provider/v1/models`(認証なしの公開一覧) | `supported_endpoints` に `/chat/completions` が無いもの(Claude 系は `/messages` 専用) |

- 同梱カタログは DSH の `llm.discoverModels('llm-pi-ai', { provider })` で読みます。ネットワークは使いません。
- **並びと絞り込み**: 取得したモデルは、系列(gpt / o / claude / gemini …、Command Code はベンダー)ごとにまとめ、その中を新しい版の順(6.1 → 6 → 5.6 → 5.5 …)に並べます。日付付きの版は同じ版の後ろです。同じ版の中は名前順です。取得結果がまだ無いとき(初回の起動直後・取得失敗)も、カタログの控えを同じ規則で並べます。モデルの表示スイッチ・入力欄のモデル選択(各サービスの中の並び)・DSH の取得ダイアログが、すべてこの並びになります(サービスの並びは DSH が決めます)。音声・文字起こし・判定(moderation)・埋め込み・画像生成・検索 API など、会話に使えない種類は外します。
- **DSH 標準の「利用可能なモデルを取得」も同じ並びにする**: このプラグインのルート(独自の接続先)では、DSH は接続先が返した順のまま一覧を出すため、OpenAI などでは並びがばらばらで、会話に使えないモデルも混ざります。llm サービスの `discoverModels` を包み、このプラグインのルートへの問い合わせ結果だけを上の規則で整えます。DSH 本体は変えず、プラグインを外すと元に戻します。
- OpenAI (API) と Grok (API) の通信方式は、同梱カタログに合わせて Responses API(`openai-responses`)です。
- カタログのモデルは「既定で表示するモデル」と「取得できないときの控え」です。取得したモデルのうちカタログに無いものは、既定で非表示として足します。カタログにあっても取得した一覧に無いもの(提供終了)は外します。並びは取得した一覧の順で、オン・オフで並びを分けません。
- 取得結果は `~/.dsh/storages/model-routes/live-models.json` に控え、次の起動では取得が終わるまでそれを使います。取得に失敗したときも、前回の一覧(無ければカタログ)で動きます。
- モデルが 12 件を超える枠では、表示スイッチの上に検索窓と「N 件中 M 件を表示」を出します。
- Command Code の接続先は `https://api.commandcode.ai/provider/v1` です(以前の `/v1` は存在せず 404 でした)。
- 環境変数 `DSH_MODEL_ROUTES_NO_DISCOVERY` があると取得しません(テスト用)。

## 旧ルートの引き継ぎ(配布・更新時に壊れないために)

きれいなプロファイル(`llm-pi-ai` の手書きなし)では、すべてのルートをこのプラグインが作ります。プロファイルに手書きの旧ルート(旧版の設定など)がある場合は、**標準的な形のものだけ**を引き継ぎます。

- 標準的な形 = 表示名が旧名またはカタログの名前で、`api` / `baseURL` / `apiKeyEnv` がカタログと同じ(または無い)、`models` がカタログにあるモデルだけ、かつ `headers` / `apiKey` / `compat` などの独自項目がないもの。
- 引き継ぐと、表示名は新しい名前になり、モデルを絞っていた場合は、その選択をモデルの表示スイッチ(`models`)に変換します。設定ファイルは書き換えません。
- 独自設定のルート(別のエンドポイント、独自ヘッダー、カタログにないモデルなど)には触りません。

## 登録した認証の枠だけをモデル一覧に出す

OAuth 枠は、**ログインしたときだけ**モデル一覧に追加します(ログアウトで外れます)。API 枠は、設定には常に残し(キー入力欄を消さないため)、キー未登録のモデルは DSH 本体が一覧から隠します。

| 枠 | 「登録済み」の条件 |
|---|---|
| OAuth | DSH にログインして、資格情報に `llm-pi-ai/<ルートID>` の記録がある |
| API | `apiKeyEnv` の値が、DSH に保存済みか環境変数にある |
| カスタム (`customProviders`) | `apiKeyEnv` がなければ常に出す(Ollama など)。あれば API と同じ |

- ログインや API キーの登録・削除は、DSH の `credentials/record-updated` / `credentials/reference-updated` イベントですぐ反映します。再起動は要りません。
- 資格情報サービスが無い・読めないときは、判定できないので従来どおり全部出します。
- 従来どおり全部出したいときは、プロファイルに `registeredOnly: false` を書きます。
- 環境変数の変更は DSH が検知できないため、シェルで環境変数だけを変えた場合は、再起動するまで反映されません。
- `modelRoutes.snapshot()` の各枠に `registered`(true/false)を足しています。設定画面用の `modelRoutesModels.getModels()` の各グループにも `registered`(true/false、判定できないときは null)を返します。

## 主な特長

1. **OAuth 枠と API キー枠の完全分離**:
   - **OAuth 側**: API キー不要。Claude Pro/Max や ChatGPT 等のサブスクのログインで動作。
   - **API 側**: OAuth ログイン不要。環境変数（`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` 等）による直接通信。
2. **公式にない独自モデル・カスタムプロバイダ登録 (`customProviders`)**:
   - OpenCode、OpenCommand / CommandCode、Grok をプリセットで完備。
   - 独自の OpenAI 互換 / Anthropic 互換エンドポイント（Ollama、vLLM、自社APIサーバー等）を自由に何個でも追加可能。
3. **モデル一覧の表示・非表示を制御**:
   - プロバイダ単位での有効化/無効化（使わないルートは非表示に）
   - モデル単位でのホワイトリスト（`visibleModels`）やブラックリスト（`hiddenModels`）指定
4. **多言語対応 (日本語 / 英語 / 中国語)**:
   - 設定画面とエラー文は、DSH の言語設定に応じて ja / en / zh が自動で切り替わります。表示名(`Claude` / `Claude (OAuth)`)は全言語で共通です。
5. **Node.js 24 互換性パッチ内蔵**:
   - DSH 内部の `AbortSignal.any` バグを自動修復し、OAuth トークン自動リフレッシュの安全性を確保。
6. **設定画面から枠を切り替え**:
   - DSH 既存の「モデル」設定の各カードのスイッチから、OAuth/API 枠の有効・無効を切り替えられます。オフにしてもカードは残ります。使用量バーの設定にはモデルルート操作を置きません(使用量のサービス一覧は「使用量バー」設定の「サービス」タブで、モデル画面には置きません)。
   - 変更は `~/.dsh/storages/model-routes/overrides.json`（権限600）へ保存し、プロファイルの設定ファイルは書き換えません。
   - このプラグインが作成したルートだけを切り替えます。手動で設定した既存ルートは上書きせず、切り替えも拒否します。
   - モデル登録の API キーは DSH 標準の「モデル」編集欄だけで管理します。使用量バー側のクォータ取得専用キーとは別です。
7. **モデル選択で「OAuth」「API」のバッジを表示**:
   - 入力欄のモデルボタン、メニュー、モデル一覧のモデル名の横に、緑の「OAuth」または橙の「API」を付けます。同じモデル名(Claude Sonnet 5.5 など)でも、どちらの枠か一目で分かります。
   - ログイン画面や DSH 本体は変更しません。モデル名の外側にある `data-provider-id` / `data-model-id`（DSH 公式の装飾フック）へ CSS を足すだけです。
   - 対象は、OAuth 枠が `anthropic` / `openai-codex` / `xai`、API 枠が `anthropic-api` / `openai-api` / `google-api` / `xai-api` / `opencode` / `commandcode-api` と、`-api` で終わるプロバイダ ID です。それ以外(DeepSeek など)には付けません。
8. **設定のモデル画面にまとめる**: OAuth ログインとモデルごとの表示スイッチを、モデル画面の各サービスの行に足します(上の「設定の「モデル」画面」)。独立した説明用の設定項目は作りません。
9. **プロバイダ定義を共有**:
   - モデル一覧・認証情報名・クォータ取得元は `@kinocode/dsh-provider-catalog` に集約しています。
   - 使用量表示プラグイン `@kinocode/dsh-usage-bars` と同じ定義を参照するため、プロバイダ名やキー名がずれません。

---

## インストール

```sh
dsh plugin --profile desktop add link:/Volumes/D/Project/dsh-model-routes
```

共有カタログは `lib/vendor/catalog` に同梱しています（追加の依存パッケージはありません）。カタログを編集したら `npm run sync-catalog` で両プラグインへ同期してください。

---

## 設定例 (`cordis.patch.yml`)

プロファイルの `cordis.patch.yml` で表示したいモデルや非表示にしたいルート、カスタムプロバイダを柔軟に設定できます。

### 1. Claude のモデルを絞り込んで表示する例
```yaml
- id: model-routes
  name: "@kinocode/dsh-model-routes"
  config:
    providers:
      claude:
        subscription:
          enabled: true
          visibleModels:
            - claude-sonnet-5-5
            - claude-opus-5-5
        api:
          enabled: true
          visibleModels:
            - claude-sonnet-5-5
```

### 2. Grok (xAI) や OpenCode、CommandCode の利用例
```yaml
- id: model-routes
  name: "@kinocode/dsh-model-routes"
  config:
    providers:
      # Grok (xAI): API枠を有効化
      xai:
        api:
          enabled: true
          apiKeyEnv: XAI_API_KEY
          visibleModels:
            - grok-4.7
            - grok-3

      # OpenCode Zen: APIキー(OPENCODE_API_KEY)で使う。OAuth ログインはない
      opencode:
        api:
          enabled: true
```

### 3. 公式にない独自モデル・サーバーの追加例 (`customProviders`)
```yaml
- id: model-routes
  name: "@kinocode/dsh-model-routes"
  config:
    customProviders:
      # ローカルの Ollama を登録する例
      ollama-local:
        displayName: "Ollama (ローカル)"
        api: "openai-completions"
        baseURL: "http://localhost:11434/v1"
        enabled: true
        models:
          - id: "qwen2.5-coder:32b"
            name: "Qwen 2.5 Coder 32B"
            contextWindow: 128000
            maxTokens: 8192
            input: [text]

      # 独自の OpenCommand / 互換サーバーを登録する例
      opencommand:
        displayName: "OpenCommand"
        api: "openai-completions"
        baseURL: "https://api.opencommand.example.com/v1"
        apiKeyEnv: "OPENCOMMAND_API_KEY"
        enabled: true
        models:
          - id: "command-r-plus"
            name: "Command R+"
            contextWindow: 128000
            maxTokens: 4096
            input: [text]
```

### 4. デフォルトモデルの指定
```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: anthropic         # OAuth 側
    # provider: anthropic-api   # API側
    # provider: xai-api         # Grok API側
    model: claude-sonnet-5-5
```
