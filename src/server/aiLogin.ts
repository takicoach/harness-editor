/**
 * AI のログイン状態を CLI で確かめる（AI タブの「使えるまでの案内」）。
 * 事前の確認（T0）で、ログイン済みは終了コード 0、未ログインは 0 以外になることを確かめた。
 * 区別できなかったツールは null にして unknown を返す（起動は止めない）。
 */
import { execFile } from 'node:child_process';
import type { AiLoginState } from '../shared/aiFocus';
import { resolveToolForPty } from './aiToolBin';
import { AI_TOOLS, type AiToolId } from './aiTools';
import { buildPtyPath } from './ptyPath';
import { sanitizeEnv } from './ptySession';

export const LOGIN_STATUS_ARGS: Readonly<Record<AiToolId, readonly string[] | null>> = { claude: ['auth', 'status'], codex: ['login', 'status'] };
export type ExitRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number | null>;
/** 終了コードを返す。起動できない・8 秒で終わらない時は null。 */
export const runForExitCode: ExitRunner = (file, args, env) => new Promise(resolve => {
  const child = execFile(file, args, { env, timeout: 8000 }, error => {
    if (!error) { resolve(0); return; }
    const code = (error as { code?: unknown }).code;
    resolve(typeof code === 'number' ? code : null);
  });
  child.stdin?.end();
});
export async function aiLoginState(tool: AiToolId, ctx: { editorDir: string; env: NodeJS.ProcessEnv }, run: ExitRunner = runForExitCode): Promise<AiLoginState> {
  const args = LOGIN_STATUS_ARGS[tool];
  if (!args) return 'unknown';
  const adapter = AI_TOOLS[tool], loc = await resolveToolForPty(adapter, ctx.editorDir, ctx.env);
  if (!loc) return 'unknown';
  if (loc.source === 'test-override') return 'ok';
  // Codex はエディタ専用の CODEX_HOME で動くので、同じ場所のログインを確かめる。
  // 実際の起動（ptySession）と同じ環境で確かめる: 課金系の環境変数を除き、PATH を補う（Finder 起動でも node 形式の CLI が動くように）。
  const base = sanitizeEnv(ctx.env, adapter.billingEnvKeys).env;
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...(adapter.prepare?.({ editorDir: ctx.editorDir, env: ctx.env }).env ?? {}),
    PATH: buildPtyPath(base.PATH ?? base.Path, loc.file, process.execPath),
  };
  if (process.platform === 'win32') env.Path = env.PATH;
  const code = await run(loc.file, [...loc.args, ...args], env);
  return code === 0 ? 'ok' : code === null ? 'unknown' : 'missing';
}
