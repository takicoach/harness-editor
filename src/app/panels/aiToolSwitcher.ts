/**
 * AI タブのツール切替に関する純関数。
 * xterm を含む AiTerminal.tsx は jsdom で描画できず e2e 専任になるため、
 * 判定ロジックだけをここへ切り出して unit で押さえる。
 */
// server/aiTools.ts ではなく shared から読む（server 側は node:fs 等を引くため
// ブラウザのバンドルに載せられない）。
import { isAiToolId, type AiToolId } from '../../shared/aiToolId';

export type ToolSource = 'test-override' | 'path' | 'known-dir' | 'managed' | 'login-shell';
export type ToolStatus = 'ready' | 'outdated' | 'missing' | 'unverified';

export interface ToolInfo {
  id: AiToolId;
  label: string;
  installed: boolean;
  versionOk: boolean;
  installable: boolean;
  /** 採用した絶対パス（見つからなければ null）。「見つかった場所」の表示に使う。 */
  path: string | null;
  source: ToolSource | null;
  status: ToolStatus;
}

export type AiToolButtonState = 'ready' | 'outdated' | 'installable' | 'manual' | 'unverified';

/** 自動導入できないツール（codex）の公式導入手順。 */
export const CODEX_INSTALL_URL = 'https://developers.openai.com/codex/cli/';

/** 実際に起動できるツール（導入済みかつ版 OK）。切替 UI の表示条件には使わない。 */
export function usableTools(tools: ToolInfo[]): ToolInfo[] {
  return tools.filter((t) => t.installed && t.versionOk);
}

// 旧 shouldShowToolSwitcher（使える物が2つ以上のときだけ切替 UI を出す）は
// 2026-09-16 の要望で撤廃した。AI タブは常に 2 ボタンを出し、未導入・検出失敗も
// 導線として見せる（設計 E）。「Claude だけの画面を変えない」だったスペック完成条件 1 は
// 今回の要望が上書きした。

/**
 * ボタン 1 つぶんの状態。
 * 「見つからない」（missing）と「確認できない」（unverified）を混ぜない —
 * findTool の rejection は unverified、null は missing。この区別が
 * 「再確認」ボタンを出すかどうかの根拠になる。
 */
export function toolButtonState(tool: ToolInfo): AiToolButtonState {
  if (tool.installed && tool.versionOk) return 'ready';
  if (tool.installed) return 'outdated';
  if (tool.status === 'unverified') return 'unverified';
  return tool.installable ? 'installable' : 'manual';
}

export function toolButtonHint(tool: ToolInfo): string {
  switch (toolButtonState(tool)) {
    case 'ready': return `見つかった場所: ${tool.path ?? '不明'}`;
    case 'outdated': return `版が古いです（${tool.path ?? '場所不明'}）`;
    case 'installable': return 'まだ入っていません。ボタン 1 つで導入できます';
    case 'manual': return '未導入です。導入手順を見る';
    default: return '見つかりません（再確認）';
  }
}

export function pickInitialTool(tools: ToolInfo[], saved: string | null): AiToolId | null {
  const usable = usableTools(tools);
  if (usable.length === 0) return null;
  if (saved !== null && isAiToolId(saved)) {
    const hit = usable.find((t) => t.id === saved);
    if (hit !== undefined) return hit.id;
  }
  return usable[0]?.id ?? null;
}
