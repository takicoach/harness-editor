/**
 * AI ツールのアダプタ定義。ツールごとの差分（起動引数・課金系環境変数・
 * 起動前の環境準備）をこの 1 枚に閉じ込め、他のモジュールは AiToolId しか知らない。
 *
 * 安全設計: 起動できるのはこの AI_TOOLS に載っているものだけ（許可リスト）。
 * API 境界では isAiToolId を通し、ユーザー入力の文字列が spawn の引数へ届く経路を作らない。
 */
import { type AiToolId } from '../shared/aiToolId';
import { prepareCodexHome } from './codexHome';
import { AI_TAB_CLIENT_QUERY } from './mcp/aiTabClient';

// クライアント（aiToolSwitcher.ts）は shared 側を直接読む。サーバー側の
// 呼び出し元の利便のためここからも re-export する。
export { type AiToolId, DEFAULT_AI_TOOL, isAiToolId } from '../shared/aiToolId';

export interface PrepareResult {
  /** pty に追加で渡す環境変数。 */
  env: Record<string, string>;
  /** UI に出す注意書き（無ければ空配列）。 */
  notes: string[];
}

export interface AiToolAdapter {
  id: AiToolId;
  /** UI 表示名。 */
  label: string;
  /** which/where で探す実行ファイル名。 */
  binName: string;
  /** ボタン1つ導入の対象なら npm パッケージ、対象外なら null。 */
  installPackage: { name: string; version: string } | null;
  /** 起動前に満たすべき最低版（`<bin> --version` と比較）。不要なら null。 */
  minVersion: string | null;
  /** 既定で pty に渡さない課金系環境変数。 */
  billingEnvKeys: readonly string[];
  /** 起動引数。port は MCP URL 用。 */
  launchArgs(port: number, theme: 'light' | 'dark'): string[];
  /** 起動前の環境準備(副作用があるツールのみ)。 */
  prepare?(ctx: { editorDir: string; env: NodeJS.ProcessEnv }): PrepareResult;
  /** ログインのための起動の引数。null なら作業用と同じ起動（AI の画面がログインを案内する）。 */
  loginArgs: readonly string[] | null;
  /** 終了直前の出力がこれに当たれば「ログインが切れた」とみなす。null なら見分けない。 */
  authFailure: RegExp | null;
}

const CLAUDE: AiToolAdapter = {
  id: 'claude',
  label: 'Claude',
  binName: 'claude',
  installPackage: { name: '@anthropic-ai/claude-code', version: '2.1.220' },
  minVersion: null, // 導入版を固定しているため個別チェック不要
  billingEnvKeys: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AWS_BEARER_TOKEN_BEDROCK',
  ],
  /**
   * MCP はインライン注入＋`--strict-mcp-config` でユーザーの ~/.claude/settings.json を
   * 汚さず、他の MCP も読み込ませない。テーマも `--settings` で注入する（起動時に固定）。
   */
  launchArgs(port, theme) {
    const mcp = JSON.stringify({
      mcpServers: { 'sme-editor': { type: 'http', url: `http://127.0.0.1:${port}/mcp?${AI_TAB_CLIENT_QUERY}` } },
    });
    return ['--mcp-config', mcp, '--strict-mcp-config', '--settings', JSON.stringify({ theme })];
  },
  loginArgs: null,
  authFailure: null,
};

const CODEX: AiToolAdapter = {
  id: 'codex',
  label: 'Codex',
  binName: 'codex',
  installPackage: null, // 「入っているものだけ出す」方針のため自動導入しない
  minVersion: '0.145.0',
  // CODEX_ACCESS_TOKEN は ChatGPT サブスク認証なので除去しない（除去すると無料経路が壊れる）。
  billingEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  /**
   * codex には `--strict-mcp-config` 相当が無く、`-c mcp_servers={}` でも既存サーバーは
   * 消えない（実測）。そのため他 MCP の遮断は引数ではなく prepare の隔離 CODEX_HOME で行う。
   * theme は使わない: `tui.theme` は構文ハイライト専用で TUI の地色を変えられないため
   * （実測）。配色は oscColorReply による OSC 10/11 応答で追従させる。引数に theme を
   * 残すのは、将来 codex が地色設定を持ったときに他を触らず足せるようにするため。
   */
  launchArgs(port, _theme) {
    return ['-c', `mcp_servers.sme-editor.url="http://127.0.0.1:${port}/mcp?${AI_TAB_CLIENT_QUERY}"`];
  },
  prepare(ctx) {
    return prepareCodexHome(ctx.editorDir);
  },
  /**
   * Codex のログアウトは OpenAI 側で合鍵を無効にし、隔離 home の auth.json（~/.codex/auth.json へのリンク）
   * だけを消す。再起動で prepare がリンクを張り直すと無効な合鍵を読み、TUI はログイン画面を出さずに
   * `account/read failed during TUI bootstrap: ... unauthorized (401)` で終わる（2026-10-12 実測・0.161）。
   * `codex login status` はファイルの有無しか見ないので、終了時の出力で見分け、ログインは `codex login` で行う。
   */
  loginArgs: ['login'],
  authFailure: /unauthorized \(401\)|sign in again/i,
};

export const AI_TOOLS: Record<AiToolId, AiToolAdapter> = { claude: CLAUDE, codex: CODEX };
