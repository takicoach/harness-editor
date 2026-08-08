export { AGENT_LOOP_PROMPT, dedicatedLoopPrompt } from '../../shared/agentPrompts';

/** MCP サーバーの URL（いま開いているオリジンから組む＝ポート変更に自動追随）。 */
export function mcpUrl(): string {
  return `${window.location.origin}/mcp`;
}

// CopyRow（この動画専属の待機プロンプト勧誘コピー行）は feat/simplified-ai-tab で
// AI タブの UI 簡素化に伴い削除。呼び出し元は ClaudePanel.tsx の cl-dedicated-recruit
// ブロックのみだった（対応する CSS: .cl-setup-copyrow / .cl-setup-code / .cl-setup-copy
// も styles.css から削除済み）。復元する場合は git 履歴からこのコミットの前を参照。
