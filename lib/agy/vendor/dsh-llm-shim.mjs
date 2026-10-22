// dsh-agy が DSH の @deepseek-ai/dsh-llm から使っていたものの代わり(プラグインの置き場所からは読み込めないため)。
// ID の型付け関数は、文字列をそのまま返すだけ。
export const CallId = value => value
export const ToolCallId = value => value
export const ReasoningEffortId = value => value
