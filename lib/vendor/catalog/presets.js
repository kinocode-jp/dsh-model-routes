// モデル登録側のプリセット。model-routes と共有する唯一の定義。
//
// 枠の分け方（validateCatalog が検査する）:
//   subscription = OAuth ログインで使う枠。auth: 'oauth'、apiKeyEnv は持たない。
//                  pi-ai に OAuth ログインがあるプロバイダ(OAUTH_PROVIDERS)だけが対象。
//   api          = API キーで使う枠。auth: 'apiKey'、apiKeyEnv を必ず持つ。
// API キーでしか使えないサービス(OpenCode Zen, Gemini API など)を subscription に置かない。
// 1 つのサービスに OAuth と API キーの両方がある場合は、枠を 2 つに分けて登録する。

/** pi-ai に OAuth ログインがあるプロバイダ ID。subscription 枠の provider はここに含まれること。 */
export const OAUTH_PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'github-copilot', 'kimi-coding', 'openrouter', 'meta']

export const PROVIDER_PRESETS = {
  // ==========================================
  // Claude (Anthropic)
  // ==========================================
  claude: {
    id: 'claude',
    name: 'Claude',
    subscription: {
      provider: 'anthropic',
      auth: 'oauth',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'Claude (OAuth)', en: 'Claude (OAuth)', zh: 'Claude (OAuth)' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['Claude (サブスク)', 'Claude (Subscription)', 'Claude (订阅)'],
      apiKeyEnv: null,
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は控えと既定で表示するモデル。
      discovery: { kind: 'catalog', exclude: '-\\d{8}$' },
      models: [
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', defaultVisible: true },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', defaultVisible: true },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', defaultVisible: true },
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', defaultVisible: true },
        { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', defaultVisible: true },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', defaultVisible: true },
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', defaultVisible: false },
        { id: 'claude-opus-5', name: 'Claude Opus 5', defaultVisible: false },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', defaultVisible: false },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', defaultVisible: false },
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', defaultVisible: false },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', defaultVisible: false },
        { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', defaultVisible: false },
        { id: 'claude-fable-5', name: 'Claude Fable 5', defaultVisible: false },
      ],
    },
    api: {
      provider: 'anthropic-api',
      auth: 'apiKey',
      api: 'anthropic-messages',
      baseURL: 'https://api.anthropic.com',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'Claude', en: 'Claude', zh: 'Claude' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['Claude (API)'],
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は控えと既定で表示するモデル。
      discovery: { kind: 'catalog', provider: 'anthropic', exclude: '-\\d{8}$' },
      models: [
        {
          id: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5 (API)',
          contextWindow: 1000000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: true,
        },
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5 (API)',
          contextWindow: 1000000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: true,
        },
        {
          id: 'claude-haiku-5-5',
          name: 'Claude Haiku 5.5 (API)',
          contextWindow: 1000000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: true,
        },
        {
          id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5 (API)',
          contextWindow: 1000000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: true,
        },
        {
          id: 'claude-opus-4-5',
          name: 'Claude Opus 4.5 (API)',
          contextWindow: 200000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: true,
        },
        {
          id: 'claude-haiku-4-5',
          name: 'Claude Haiku 4.5 (API)',
          contextWindow: 200000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: true,
        },
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5 (API)',
          contextWindow: 1000000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: false,
        },
        {
          id: 'claude-opus-5',
          name: 'Claude Opus 5 (API)',
          contextWindow: 1000000,
          maxTokens: 64000,
          input: ['text', 'image'],
          defaultVisible: false,
        },
      ],
    },
  },

  // ==========================================
  // OpenAI / ChatGPT
  // ==========================================
  openai: {
    id: 'openai',
    name: 'OpenAI',
    subscription: {
      provider: 'openai-codex',
      auth: 'oauth',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'OpenAI (OAuth)', en: 'OpenAI (OAuth)', zh: 'OpenAI (OAuth)' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['OpenAI (サブスク/Codex)', 'OpenAI (Subscription/Codex)', 'OpenAI (订阅/Codex)'],
      apiKeyEnv: null,
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は控えと既定で表示するモデル。
      discovery: { kind: 'catalog' },
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', defaultVisible: true },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', defaultVisible: true },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', defaultVisible: true },
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', defaultVisible: false },
        { id: 'gpt-5.5', name: 'GPT-5.5', defaultVisible: false },
      ],
    },
    api: {
      provider: 'openai-api',
      auth: 'apiKey',
      // pi-ai の OpenAI カタログは全モデルが Responses API。
      api: 'openai-responses',
      baseURL: 'https://api.openai.com/v1',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'OpenAI', en: 'OpenAI', zh: 'OpenAI' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['OpenAI (API)'],
      apiKeyEnv: 'OPENAI_API_KEY',
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は控えと既定で表示するモデル。
      discovery: { kind: 'catalog', provider: 'openai', exclude: 'realtime' },
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol (API)', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], defaultVisible: true },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra (API)', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], defaultVisible: true },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna (API)', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], defaultVisible: true },
        { id: 'gpt-6-sol', name: 'GPT-6 Sol (API)', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], defaultVisible: false },
        { id: 'gpt-5.5', name: 'GPT-5.5 (API)', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], defaultVisible: false },
      ],
    },
  },

  // ==========================================
  // Google (Gemini)
  // ==========================================
  google: {
    id: 'google',
    name: 'Gemini',
    api: {
      provider: 'google-api',
      auth: 'apiKey',
      api: 'openai-completions',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'Gemini', en: 'Gemini', zh: 'Gemini' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['Gemini (API)', 'Gemini (サブスク/標準)', 'Gemini (Subscription/Default)', 'Gemini (订阅/标准)'],
      apiKeyEnv: 'GEMINI_API_KEY',
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は控えと既定で表示するモデル。
      discovery: { kind: 'catalog', provider: 'google', exclude: 'deep-research|image|live|computer-use|customtools' },
      models: [
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview (API)', contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'], defaultVisible: true },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (API)', contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'], defaultVisible: true },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (API)', contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'], defaultVisible: false },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (API)', contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'], defaultVisible: false },
      ],
    },
  },

  // ==========================================
  // xAI (Grok)
  // ==========================================
  xai: {
    id: 'xai',
    name: 'Grok',
    subscription: {
      provider: 'xai',
      auth: 'oauth',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'Grok (OAuth)', en: 'Grok (OAuth)', zh: 'Grok (OAuth)' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['Grok (サブスク/OAuth)', 'Grok (Subscription/OAuth)', 'Grok (订阅/OAuth)'],
      apiKeyEnv: null,
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は控えと既定で表示するモデル。
      discovery: { kind: 'catalog' },
      models: [
        { id: 'grok-4.7', name: 'Grok 4.7', defaultVisible: true },
        { id: 'grok-4.6', name: 'Grok 4.6', defaultVisible: true },
        { id: 'grok-4.5', name: 'Grok 4.5', defaultVisible: true },
        { id: 'grok-4.3', name: 'Grok 4.3', defaultVisible: false },
      ],
    },
    api: {
      provider: 'xai-api',
      auth: 'apiKey',
      // pi-ai の xAI カタログは全モデルが Responses API。
      api: 'openai-responses',
      baseURL: 'https://api.x.ai/v1',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'Grok', en: 'Grok', zh: 'Grok' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['Grok (API)'],
      apiKeyEnv: 'XAI_API_KEY',
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は控えと既定で表示するモデル。
      discovery: { kind: 'catalog', provider: 'xai' },
      models: [
        { id: 'grok-4.7', name: 'Grok 4.7 (API)', contextWindow: 500000, maxTokens: 500000, input: ['text', 'image'], defaultVisible: true },
        { id: 'grok-4.6', name: 'Grok 4.6 (API)', contextWindow: 500000, maxTokens: 500000, input: ['text', 'image'], defaultVisible: true },
        { id: 'grok-4.5', name: 'Grok 4.5 (API)', contextWindow: 500000, maxTokens: 500000, input: ['text', 'image'], defaultVisible: true },
        { id: 'grok-4.3', name: 'Grok 4.3 (API)', contextWindow: 1000000, maxTokens: 30000, input: ['text', 'image'], defaultVisible: false },
      ],
    },
  },

  // ==========================================
  // OpenCode
  // ==========================================
  opencode: {
    id: 'opencode',
    name: 'OpenCode Zen',
    // OpenCode Zen は API キー(OPENCODE_API_KEY)だけで使う。OAuth ログインはない。
    // pi-ai 同梱の 'opencode' プロバイダ(https://opencode.ai/zen/v1)をそのまま使うため、
    // api / baseURL は指定しない（モデル ID は pi-ai のカタログにあるものに限る）。
    api: {
      provider: 'opencode',
      auth: 'apiKey',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'OpenCode Zen', en: 'OpenCode Zen', zh: 'OpenCode Zen' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['OpenCode Zen (API)', 'OpenCode (公式/OAuth)', 'OpenCode (OAuth)', 'OpenCode (官方/OAuth)', 'OpenCode (API)'],
      apiKeyEnv: 'OPENCODE_API_KEY',
      // 起動時に DSH(pi-ai)の同梱カタログから全モデルを取得して候補に足す。下の一覧は、取得できないときの控えと既定で表示するモデル。
      discovery: { kind: 'catalog' },
      models: [
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (OpenCode Zen)', defaultVisible: true },
        { id: 'qwen3.8-max', name: 'Qwen 3.8 Max (OpenCode Zen)', defaultVisible: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (OpenCode Zen)', defaultVisible: true },
        { id: 'kimi-k3', name: 'Kimi K3 (OpenCode Zen)', defaultVisible: true },
      ],
    },
  },

  // ==========================================
  // CommandCode / OpenCommand
  // ==========================================
  commandcode: {
    id: 'commandcode',
    name: 'Command Code',
    api: {
      provider: 'commandcode-api',
      auth: 'apiKey',
      api: 'openai-completions',
      // OpenAI 互換の入口は /provider/v1(/v1 は 404)。モデル一覧は認証なしで公開されている。
      baseURL: 'https://api.commandcode.ai/provider/v1',
      // モデル設定画面・モデル選択の表示名。API 枠はサービス名だけ、OAuth 枠は「(OAuth)」付き(全言語共通)。
      labels: { ja: 'Command Code', en: 'Command Code', zh: 'Command Code' },
      // 旧版が付けていた名前。手書きの旧ルートを見分けて引き継ぐために使う。
      legacyLabels: ['Command Code (API)'],
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      // 起動時に {baseURL}/models から全モデルを取得して候補に足す。/chat/completions に対応したものだけ
      // (Claude 系は /messages 専用で、この枠の openai-completions では使えない)。
      // 下の一覧は、取得できないときの控えと既定で表示するモデル(2026-10-22 の公開一覧から)。
      discovery: { kind: 'openai-list', endpoint: '/chat/completions' },
      models: [
        { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, input: ['text'], defaultVisible: true },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, input: ['text'], defaultVisible: true },
        { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', contextWindow: 1000000, input: ['text'], defaultVisible: true },
        { id: 'zai-org/GLM-5.3', name: 'GLM-5.3', contextWindow: 1000000, input: ['text'], defaultVisible: true },
        { id: 'Qwen/Qwen3.8-Max', name: 'Qwen 3.8 Max', contextWindow: 1000000, input: ['text'], defaultVisible: true },
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 1050000, input: ['text', 'image'], defaultVisible: false },
      ],
    },
  },
};
