// クォータ取得側(usage-bars)のサービス定義。使用量バーの取得元IDと、
// 設定画面で入力する認証情報の名前を1か所にまとめる。
export const QUOTA_SOURCES = {
  codex: { labels: { ja: 'Codex', en: 'Codex', zh: 'Codex' }, auth: 'oauth', keyNames: [], route: 'subscription' },
  claude: { labels: { ja: 'Claude', en: 'Claude', zh: 'Claude' }, auth: 'oauth', keyNames: [], route: 'subscription' },
  gemini: { labels: { ja: 'Gemini', en: 'Gemini', zh: 'Gemini' }, auth: 'oauth', keyNames: [] },
  antigravity: { labels: { ja: 'Antigravity', en: 'Antigravity', zh: 'Antigravity' }, auth: 'local', keyNames: [] },
  commandcode: { labels: { ja: 'Command Code', en: 'Command Code', zh: 'Command Code' }, auth: 'apiKey', keyNames: ['COMMANDCODE_API_KEY'], route: 'api' },
  deepseek: { labels: { ja: 'DeepSeek', en: 'DeepSeek', zh: 'DeepSeek' }, auth: 'apiKey', keyNames: ['DEEPSEEK_API_KEY'] },
  openrouter: { labels: { ja: 'OpenRouter', en: 'OpenRouter', zh: 'OpenRouter' }, auth: 'apiKey', keyNames: ['OPENROUTER_API_KEY'] },
  zai: { labels: { ja: 'Z.ai', en: 'Z.ai', zh: 'Z.ai' }, auth: 'apiKey', keyNames: ['Z_AI_API_KEY'] },
  kimik2: { labels: { ja: 'Kimi K2', en: 'Kimi K2', zh: 'Kimi K2' }, auth: 'apiKey', keyNames: ['KIMI_K2_API_KEY'] },
  amp: { labels: { ja: 'Amp', en: 'Amp', zh: 'Amp' }, auth: 'cookie', keyNames: ['AMP_COOKIE'] },
  copilot: { labels: { ja: 'GitHub Copilot', en: 'GitHub Copilot', zh: 'GitHub Copilot' }, auth: 'apiKey', keyNames: ['COPILOT_API_KEY'] },
  cursor: { labels: { ja: 'Cursor', en: 'Cursor', zh: 'Cursor' }, auth: 'cookie', keyNames: ['CURSOR_COOKIE'] },
  factory: { labels: { ja: 'Factory', en: 'Factory', zh: 'Factory' }, auth: 'apiKey', keyNames: ['FACTORY_API_KEY', 'FACTORY_COOKIE'] },
  jetbrains: { labels: { ja: 'JetBrains', en: 'JetBrains', zh: 'JetBrains' }, auth: 'local', keyNames: [] },
  kilo: { labels: { ja: 'Kilo', en: 'Kilo', zh: 'Kilo' }, auth: 'apiKey', keyNames: ['KILO_API_KEY'] },
  kimi: { labels: { ja: 'Kimi', en: 'Kimi', zh: 'Kimi' }, auth: 'cookie', keyNames: ['KIMI_AUTH_TOKEN'] },
  kiro: { labels: { ja: 'Kiro', en: 'Kiro', zh: 'Kiro' }, auth: 'local', keyNames: [] },
  minimax: { labels: { ja: 'MiniMax', en: 'MiniMax', zh: 'MiniMax' }, auth: 'apiKey', keyNames: ['MINIMAX_API_KEY'] },
  ollama: { labels: { ja: 'Ollama', en: 'Ollama', zh: 'Ollama' }, auth: 'cookie', keyNames: ['OLLAMA_COOKIE'] },
  opencode: { labels: { ja: 'OpenCode', en: 'OpenCode', zh: 'OpenCode' }, auth: 'cookie', keyNames: ['OPENCODE_COOKIE', 'OPENCODE_WORKSPACE_ID'], route: 'api' },
  vertexai: { labels: { ja: 'Vertex AI', en: 'Vertex AI', zh: 'Vertex AI' }, auth: 'local', keyNames: [] },
  warp: { labels: { ja: 'Warp', en: 'Warp', zh: 'Warp' }, auth: 'apiKey', keyNames: ['WARP_API_KEY'] },
}

// route はモデル登録側のどの枠に対応するか。null/未指定はモデル登録の対象外。
// モデル登録側のプロバイダID → クォータ取得元ID。登録だけして使用量を
// 取得しないプロバイダ(xai など)は null。
export const PRESET_QUOTA = {
  claude: 'claude',
  openai: 'codex',
  google: 'gemini',
  xai: null,
  opencode: 'opencode',
  commandcode: 'commandcode',
}
