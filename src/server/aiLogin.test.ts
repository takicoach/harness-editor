import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiToolBin from './aiToolBin';
import { AI_TOOLS } from './aiTools';
import { aiLoginState, LOGIN_STATUS_ARGS } from './aiLogin';

const ctx = { editorDir: '/tmp/editor', env: {} as NodeJS.ProcessEnv };
afterEach(() => { vi.restoreAllMocks(); });

describe('ログイン状態', () => {
  it('確認のコマンドの終了コード: 0 は ok、0 以外は missing、起動できない・終わらないは unknown', async () => {
    vi.spyOn(aiToolBin, 'resolveToolForPty').mockResolvedValue({ file: '/bin/claude', args: [], path: '/bin/claude', source: 'path' });
    const run = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValueOnce(null);
    expect(await aiLoginState('claude', ctx, run)).toBe('ok');
    expect(await aiLoginState('claude', ctx, run)).toBe('missing');
    expect(await aiLoginState('claude', ctx, run)).toBe('unknown');
    expect(run).toHaveBeenCalledWith('/bin/claude', [...(LOGIN_STATUS_ARGS.claude ?? [])], expect.any(Object));
  });
  it('見つからなければ unknown、試験の偽の AI は ok（確認しない）', async () => {
    const run = vi.fn();
    vi.spyOn(aiToolBin, 'resolveToolForPty').mockResolvedValueOnce(null);
    expect(await aiLoginState('claude', ctx, run)).toBe('unknown');
    vi.spyOn(aiToolBin, 'resolveToolForPty').mockResolvedValueOnce({ file: process.execPath, args: ['fake.mjs'], path: 'fake.mjs', source: 'test-override' });
    expect(await aiLoginState('claude', ctx, run)).toBe('ok');
    expect(run).not.toHaveBeenCalled();
  });
  it('Codex はエディタ専用の CODEX_HOME で確かめる', async () => {
    vi.spyOn(aiToolBin, 'resolveToolForPty').mockResolvedValue({ file: '/bin/codex', args: [], path: '/bin/codex', source: 'path' });
    vi.spyOn(AI_TOOLS.codex as Required<typeof AI_TOOLS.codex>, 'prepare').mockReturnValue({ env: { CODEX_HOME: '/tmp/editor-codex-home' }, notes: [] });
    const run = vi.fn().mockResolvedValue(0);
    await aiLoginState('codex', ctx, run);
    if (LOGIN_STATUS_ARGS.codex) expect(run.mock.calls[0]![2]).toMatchObject({ CODEX_HOME: '/tmp/editor-codex-home' });
  });
  it('実際の起動と同じ環境で確かめる: 課金系の環境変数を除き、PATH に CLI の場所を足す', async () => {
    vi.spyOn(aiToolBin, 'resolveToolForPty').mockResolvedValue({ file: '/opt/x/bin/claude', args: [], path: '/opt/x/bin/claude', source: 'path' });
    const run = vi.fn().mockResolvedValue(0);
    await aiLoginState('claude', { editorDir: '/tmp/editor', env: { ANTHROPIC_API_KEY: 'sk-x', PATH: '/usr/bin:/bin' } }, run);
    const env = run.mock.calls[0]![2] as NodeJS.ProcessEnv;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH?.split(':')).toContain('/opt/x/bin');
    expect(env.PATH?.split(':')).toContain('/usr/bin');
  });
});
