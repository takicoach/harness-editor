// src/server/backgroundInstall.test.ts — 新規プロジェクトの npm install 自動導線
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { triggerBackgroundInstall } from './backgroundInstall';
import type { FakeProcess } from './spawnShell';

function makeFakeProc(): FakeProcess {
  const em = new EventEmitter() as FakeProcess;
  em.stdout = new Readable({ read() {} });
  em.stderr = new Readable({ read() {} });
  em.kill = vi.fn(() => true);
  em.unref = vi.fn();
  return em;
}

describe('triggerBackgroundInstall', () => {
  it('node_modules が無ければ npm install を spawn する（stdout/stderr は drain）', () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const log = vi.fn();
    const logError = vi.fn();
    triggerBackgroundInstall('/pj/new-1', {
      existsSync: () => false,
      spawn,
      log,
      logError,
    });
    expect(spawn).toHaveBeenCalledWith({ command: 'npm', args: ['install', '--ignore-scripts'], cwd: '/pj/new-1' });
    // M-3: POSIX detached の子プロセスがイベントループを掴んだままにならないよう unref する。
    expect(proc.unref).toHaveBeenCalled();
    // drain listener が付いている（呼んでもクラッシュしない）
    expect(() => proc.stdout.emit('data', Buffer.from('added 100 packages'))).not.toThrow();
    expect(() => proc.stderr.emit('data', Buffer.from('warn'))).not.toThrow();
    proc.emit('exit', 0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/pj/new-1'));
  });

  it('node_modules が既にあればスキップする（spawn しない）', () => {
    const spawn = vi.fn(() => makeFakeProc());
    triggerBackgroundInstall('/pj/new-2', { existsSync: () => true, spawn, log: vi.fn(), logError: vi.fn() });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('同一プロジェクトへの多重呼び出しは install 中なら1回しか spawn しない', () => {
    const spawn = vi.fn(() => makeFakeProc());
    triggerBackgroundInstall('/pj/new-3', { existsSync: () => false, spawn, log: vi.fn(), logError: vi.fn() });
    triggerBackgroundInstall('/pj/new-3', { existsSync: () => false, spawn, log: vi.fn(), logError: vi.fn() });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('install が終わった後は再度呼ばれれば再度 spawn できる（in-progress フラグの解除）', () => {
    const proc1 = makeFakeProc();
    const proc2 = makeFakeProc();
    const spawn = vi.fn().mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);
    triggerBackgroundInstall('/pj/new-4', { existsSync: () => false, spawn, log: vi.fn(), logError: vi.fn() });
    proc1.emit('exit', 0);
    triggerBackgroundInstall('/pj/new-4', { existsSync: () => false, spawn, log: vi.fn(), logError: vi.fn() });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('exit コード非0は logError へ終了コードを記録する', () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const logError = vi.fn();
    triggerBackgroundInstall('/pj/new-5', { existsSync: () => false, spawn, log: vi.fn(), logError });
    proc.emit('exit', 1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('1'));
  });

  it('spawn 自体が例外を投げても呼び出し元へは伝播しない（致命的でない）', () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const logError = vi.fn();
    expect(() =>
      triggerBackgroundInstall('/pj/new-6', { existsSync: () => false, spawn, log: vi.fn(), logError }),
    ).not.toThrow();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('プロセスの error イベントも捕捉して logError へ渡す（in-progress は解除される）', () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const logError = vi.fn();
    triggerBackgroundInstall('/pj/new-7', { existsSync: () => false, spawn, log: vi.fn(), logError });
    proc.emit('error', new Error('spawn EACCES'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});
