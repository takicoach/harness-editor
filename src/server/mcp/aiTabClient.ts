/**
 * AI タブから起動した AI は MCP の URL に ?client=ai-tab を付ける（aiTools.launchArgs）。
 * 外から /mcp を使う人の接続と見分け、書き込みの対象確認と在席判定（/api/ai/presence）に使う。
 */
export const AI_TAB_CLIENT_QUERY = 'client=ai-tab';
let lastSeen: number | null = null;
export function isAiTabRequest(url: string | undefined): boolean {
  try { return new URL(url ?? '/', 'http://localhost').searchParams.get('client') === 'ai-tab'; } catch { return false; }
}
/** AI タブの接続から要求が来た時刻を残す。 */
export function noteAiTabMcp(now: number = Date.now()): void { lastSeen = now; }
export function aiTabMcpLastSeen(): number | null { return lastSeen; }
/** 試験用。 */
export function resetAiTabMcp(): void { lastSeen = null; }
