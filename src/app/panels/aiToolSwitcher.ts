/**
 * AI タブのツール切替に関する純関数。
 * xterm を含む AiTerminal.tsx は jsdom で描画できず e2e 専任になるため、
 * 判定ロジックだけをここへ切り出して unit で押さえる。
 */
// server/aiTools.ts ではなく shared から読む（server 側は node:fs 等を引くため
// ブラウザのバンドルに載せられない）。
import { isAiToolId, type AiToolId } from '../../shared/aiToolId';

export interface ToolInfo {
  id: AiToolId;
  label: string;
  installed: boolean;
  versionOk: boolean;
  installable: boolean;
}

/** 実際に起動できるツール（導入済みかつ版 OK）。 */
export function usableTools(tools: ToolInfo[]): ToolInfo[] {
  return tools.filter((t) => t.installed && t.versionOk);
}

/**
 * 切替 UI を出すか。**使える物が 2 つ以上のときだけ出す** —
 * Claude しか入っていない利用者の画面を現状から変えないため（スペック完成条件 1）。
 */
export function shouldShowToolSwitcher(tools: ToolInfo[]): boolean {
  return usableTools(tools).length >= 2;
}

/**
 * 初期選択。localStorage の保存値を信用しきらず、使えないなら先頭へ落とす。
 * 不正な文字列は isAiToolId で弾く。
 */
export function pickInitialTool(tools: ToolInfo[], saved: string | null): AiToolId | null {
  const usable = usableTools(tools);
  if (usable.length === 0) return null;
  if (saved !== null && isAiToolId(saved)) {
    const hit = usable.find((t) => t.id === saved);
    if (hit !== undefined) return hit.id;
  }
  return usable[0]?.id ?? null;
}
