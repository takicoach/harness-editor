import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as nodeChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInstallJob } from './claudeInstallJob';
import { findTool, clearToolCache } from './aiToolBin';
import { AI_TOOLS } from './aiTools';

// findTool の検出キャッシュ無効化配線を検証する3テスト用（Minor 1 対応）: deps.which を
// 注入するとキャッシュを迂回する仕様になったため（aiToolBin.ts）、ここでは既定経路
// （deps 無し）でキャッシュが効くこと／導入完了・失敗・error で無効化されることを
// execFileSync の呼び出し回数で検証する。vi.spyOn は ESM の named export を再定義できず
// 失敗するため、vi.mock で実体をラップした vi.fn に差し替える（spawn は実体のまま使うので
// このファイルの他のテスト（実プロセス起動）の挙動は変わらない）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

/** 実バイナリを起動しないための偽アダプタ（binName が存在しないので which が即 null を返す）。 */
const FAKE_FIND_TOOL = { ...AI_TOOLS.claude, binName: 'sme-nonexistent-bin-for-install-cache-test' };

describe('claudeInstallJob', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('start で running になり、二重 start は拒否される', () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-install-'));
    // npm の代わりに sleep する偽コマンドで実行（コマンド注入は spawnImpl 差し替えで）
    const job = createInstallJob({
      spawnImpl: () => spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)']),
    });
    expect(job.start(dir).ok).toBe(true);
    expect(job.status().phase).toBe('running');
    const second = job.start(dir);
    expect(second.ok).toBe(false);
    job.killAll();
  });

  it('子プロセスの終了コード 0 で done、非 0 で failed になる', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-install-'));
    const mk = (code: number) =>
      createInstallJob({
        spawnImpl: () =>
          spawn(process.execPath, ['-e', `console.log("line"); process.exit(${code})`]),
      });
    const ok = mk(0);
    ok.start(dir);
    await new Promise((r) => setTimeout(r, 1500));
    expect(ok.status().phase).toBe('done');
    expect(ok.status().log.join('')).toContain('line'); // stdout が drain されている

    const bad = mk(1);
    bad.start(dir);
    await new Promise((r) => setTimeout(r, 1500));
    expect(bad.status().phase).toBe('failed');
  });

  it('導入完了（終了コード 0）で aiToolBin の検出キャッシュを無効化する（Important 2 配線）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-install-'));
    clearToolCache();
    const execSpy = vi.mocked(nodeChildProcess.execFileSync);
    execSpy.mockClear();
    // 1回目: キャッシュに載る。2回目: TTL 内なので which（execFileSync）は再実行されない
    // （キャッシュが効いている）。
    findTool(FAKE_FIND_TOOL, dir);
    findTool(FAKE_FIND_TOOL, dir);
    expect(execSpy).toHaveBeenCalledTimes(1);

    const job = createInstallJob({
      spawnImpl: () => spawn(process.execPath, ['-e', 'process.exit(0)']),
    });
    job.start(dir);
    await new Promise((r) => setTimeout(r, 1000));
    expect(job.status().phase).toBe('done');

    // 導入完了直後: TTL 満了を待たずキャッシュが無効化され、which が再実行される。
    findTool(FAKE_FIND_TOOL, dir);
    expect(execSpy).toHaveBeenCalledTimes(2);
  });

  /**
   * Minor 2: 「失敗なら何も変わっていない」という理由で code!==0 の時だけクリアを
   * 見送っていたが誤り — 途中失敗した npm install は .claude-runtime に部分的な
   * 成果物を残しうる。失敗時も無条件でクリアすることを確認する。
   */
  it('導入失敗（非 0 終了）でも検出キャッシュを無効化する（Minor 2）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-install-'));
    clearToolCache();
    const execSpy = vi.mocked(nodeChildProcess.execFileSync);
    execSpy.mockClear();
    findTool(FAKE_FIND_TOOL, dir);
    findTool(FAKE_FIND_TOOL, dir);
    expect(execSpy).toHaveBeenCalledTimes(1);

    const job = createInstallJob({
      spawnImpl: () => spawn(process.execPath, ['-e', 'process.exit(1)']),
    });
    job.start(dir);
    await new Promise((r) => setTimeout(r, 1000));
    expect(job.status().phase).toBe('failed');

    findTool(FAKE_FIND_TOOL, dir);
    expect(execSpy).toHaveBeenCalledTimes(2);
  });

  it("子プロセスの 'error' イベントでも検出キャッシュを無効化する（Minor 2）", () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-install-'));
    clearToolCache();
    const execSpy = vi.mocked(nodeChildProcess.execFileSync);
    execSpy.mockClear();
    findTool(FAKE_FIND_TOOL, dir);
    findTool(FAKE_FIND_TOOL, dir);
    expect(execSpy).toHaveBeenCalledTimes(1);

    const proc = makeFakeProc(9999);
    const job = createInstallJob({ spawnImpl: () => proc });
    job.start(dir);
    proc.emit('error', new Error('spawn ENOENT'));
    expect(job.status().phase).toBe('failed');

    findTool(FAKE_FIND_TOOL, dir);
    expect(execSpy).toHaveBeenCalledTimes(2);
  });
});

/** pid・kill スパイを持つ最小限の ChildProcess 互換フェイク（renderJob.test.ts と同じ流儀）。 */
function makeFakeProc(pid?: number): ChildProcess {
  const em = new EventEmitter() as unknown as ChildProcess;
  (em as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (em as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (em as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = vi.fn(() => true);
  (em as unknown as { pid?: number }).pid = pid;
  return em;
}

// defer #3: killAll() のプロセスツリー kill（renderJob.ts と同じ DI パターン・意味論）。
describe('claudeInstallJob.killAll — プロセスツリー kill（defer #3）', () => {
  it('pid ありの proc を killAll すると killGroup(pid) が呼ばれる（proc.kill は呼ばれない）', () => {
    const proc = makeFakeProc(4321);
    const killGroup = vi.fn();
    const job = createInstallJob({ spawnImpl: () => proc, killGroup });

    job.start('/tmp/editor-dir');
    job.killAll();

    expect(killGroup).toHaveBeenCalledWith(4321);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('killGroup が throw したら proc.kill にフォールバックする', () => {
    const proc = makeFakeProc(4321);
    const killGroup = vi.fn(() => { throw new Error('ESRCH'); });
    const job = createInstallJob({ spawnImpl: () => proc, killGroup });

    job.start('/tmp/editor-dir');
    job.killAll();

    expect(killGroup).toHaveBeenCalledWith(4321);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('pid 無しは killGroup を呼ばず proc.kill のみ', () => {
    const proc = makeFakeProc(undefined);
    const killGroup = vi.fn();
    const job = createInstallJob({ spawnImpl: () => proc, killGroup });

    job.start('/tmp/editor-dir');
    job.killAll();

    expect(killGroup).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalled();
  });
});
