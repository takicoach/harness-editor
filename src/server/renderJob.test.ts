// src/server/renderJob.test.ts — 主要ケース（FakeProcess は denoiseJob.test.ts と同じ makeFakeProc ヘルパを定義）
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { RenderJobManager, quoteForCmdShell, type FakeProcess } from './renderJob';

function makeFakeProc(pid?: number): FakeProcess {
  const em = new EventEmitter() as FakeProcess;
  em.stdout = new Readable({ read() {} });
  em.stderr = new Readable({ read() {} });
  em.kill = vi.fn(() => true);
  em.pid = pid;
  return em;
}

describe('RenderJobManager', () => {
  it('needsInstall=false なら render プロセスを直接 spawn し、進捗行で rendering+progress を emit する', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const rename = vi.fn();
    const m = new RenderJobManager({ spawn, rename, unlink: vi.fn(), killGroup: vi.fn() });
    const events: unknown[] = [];
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/pj/out/.tmp.mp4', finalOutput: '/pj/out/video.mp4' });
    m.subscribe('p1', (ev) => events.push(ev));
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ command: 'npx', args: ['remotion', 'render', 'MainVideo', '/pj/out/.tmp.mp4'], cwd: '/pj' }));
    procs[0]!.stdout.emit('data', Buffer.from('Bundling...'));
    expect(m.get('p1')!.phase).toBe('bundling');
    procs[0]!.stdout.emit('data', Buffer.from('Rendered 50/100'));
    expect(m.get('p1')!.phase).toBe('rendering');
    expect(m.get('p1')!.progress).toEqual({ frames: 50, total: 100, percent: 50 });
    procs[0]!.emit('exit', 0);
    expect(rename).toHaveBeenCalledWith('/pj/out/.tmp.mp4', '/pj/out/video.mp4');
    expect(m.get('p1')).toBeUndefined(); // done 後 cleanup
    expect(events.at(-1)).toEqual({ phase: 'done' });
  });

  it('post あり: render 成功 → ffmpeg を spawn（finalizing）→ 成功で post.output を rename・tmp を unlink', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const rename = vi.fn();
    const unlink = vi.fn();
    const m = new RenderJobManager({ spawn, rename, unlink, killGroup: vi.fn() });
    const events: { phase: string }[] = [];
    m.start('p1', {
      projectDir: '/pj', needsInstall: false,
      tmpOutput: '/pj/out/.tmp.mp4', finalOutput: '/pj/out/video.mp4',
      post: { command: 'ffmpeg', args: ['-i', '/pj/out/.tmp.mp4', '/pj/out/.tmp.mp4.final.mp4'], output: '/pj/out/.tmp.mp4.final.mp4' },
    });
    m.subscribe('p1', (ev) => events.push(ev));
    procs[0]!.emit('exit', 0);
    expect(rename).not.toHaveBeenCalled();
    expect(m.get('p1')!.phase).toBe('finalizing');
    expect(spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: 'ffmpeg' }));
    procs[1]!.emit('exit', 0);
    expect(rename).toHaveBeenCalledWith('/pj/out/.tmp.mp4.final.mp4', '/pj/out/video.mp4');
    expect(unlink).toHaveBeenCalledWith('/pj/out/.tmp.mp4');
    expect(events.at(-1)).toEqual({ phase: 'done' });
  });

  it('render exit 0 でも出力ファイルが無ければ render-no-output で failed（post へ進まない）', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const m = new RenderJobManager({
      spawn, rename: vi.fn(), unlink: vi.fn(), killGroup: vi.fn(),
      exists: vi.fn(() => false),
    });
    const events: { phase: string; error?: { code: string } }[] = [];
    m.start('p1', {
      projectDir: '/pj', needsInstall: false,
      tmpOutput: '/pj/out/.tmp.mp4', finalOutput: '/pj/out/video.mp4',
      post: { command: 'ffmpeg', args: [], output: '/pj/out/.tmp.mp4.final.mp4' },
    });
    m.subscribe('p1', (ev) => events.push(ev));
    procs[0]!.emit('exit', 0);
    expect(spawn).toHaveBeenCalledTimes(1); // ffmpeg は起動しない
    expect(m.get('p1')!.phase).toBe('failed');
    expect(events.at(-1)!.error!.code).toBe('render-no-output');
  });

  it('post 失敗は finalize-failed（stderr 末尾つき）で failed', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup: vi.fn() });
    const events: { phase: string; error?: { code: string; message: string } }[] = [];
    m.start('p1', {
      projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f',
      post: { command: 'ffmpeg', args: [], output: '/t.final.mp4' },
    });
    m.subscribe('p1', (ev) => events.push(ev));
    procs[0]!.emit('exit', 0);
    procs[1]!.stderr.emit('data', Buffer.from('Invalid argument'));
    procs[1]!.emit('exit', 1);
    expect(events.at(-1)!.error!.code).toBe('finalize-failed');
    expect(events.at(-1)!.error!.message).toContain('Invalid argument');
  });

  it('finalizing 中の cancel は tmp と post.output を両方 unlink する', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(7); procs.push(p); return p; });
    const unlink = vi.fn();
    const killGroup = vi.fn();
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink, killGroup });
    m.start('p1', {
      projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f',
      post: { command: 'ffmpeg', args: [], output: '/t.final.mp4' },
    });
    procs[0]!.emit('exit', 0);
    m.cancel('p1');
    expect(unlink).toHaveBeenCalledWith('/t');
    expect(unlink).toHaveBeenCalledWith('/t.final.mp4');
  });

  it('needsInstall=true なら npm install → exit 0 で render を spawn する', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup: vi.fn() });
    m.start('p1', { projectDir: '/pj', needsInstall: true, tmpOutput: '/t', finalOutput: '/f' });
    expect(spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'npm', args: ['install', '--ignore-scripts'], cwd: '/pj' }));
    procs[0]!.emit('exit', 0);
    expect(spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: 'npx' }));
  });

  it('npm install 失敗は npm-install-failed で failed', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup: vi.fn() });
    const events: { phase: string; error?: { code: string } }[] = [];
    m.start('p1', { projectDir: '/pj', needsInstall: true, tmpOutput: '/t', finalOutput: '/f' });
    m.subscribe('p1', (ev) => events.push(ev));
    procs[0]!.emit('exit', 1);
    expect(events.at(-1)!.error!.code).toBe('npm-install-failed');
  });

  it('render 非0終了は stderr 末尾を message に含めて failed', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup: vi.fn() });
    const events: { phase: string; error?: { code: string; message: string } }[] = [];
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' });
    m.subscribe('p1', (ev) => events.push(ev));
    procs[0]!.stderr.emit('data', Buffer.from('Error: composition not found'));
    procs[0]!.emit('exit', 1);
    const last = events.at(-1)!;
    expect(last.error!.code).toBe('render-failed');
    expect(last.error!.message).toContain('composition not found');
  });

  it('cancel は SIGTERM + tmp 削除 + cancelled emit', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const unlink = vi.fn();
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink, killGroup: vi.fn() });
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' });
    expect(m.cancel('p1')).toBe(true);
    expect(procs[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(unlink).toHaveBeenCalledWith('/t');
  });

  it('pid ありの proc を cancel すると killGroup(pid) が呼ばれる（proc.kill は呼ばれない）', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(4321); procs.push(p); return p; });
    const killGroup = vi.fn();
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup });
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' });
    expect(m.cancel('p1')).toBe(true);
    expect(killGroup).toHaveBeenCalledWith(4321);
    expect(procs[0]!.kill).not.toHaveBeenCalled();
  });

  it('killGroup が throw したら proc.kill にフォールバックする', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(4321); procs.push(p); return p; });
    const killGroup = vi.fn(() => { throw new Error('ESRCH'); });
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup });
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' });
    expect(m.cancel('p1')).toBe(true);
    expect(killGroup).toHaveBeenCalledWith(4321);
    expect(procs[0]!.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('pid 無しは killGroup を呼ばず proc.kill のみ', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const killGroup = vi.fn();
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup });
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' });
    expect(m.cancel('p1')).toBe(true);
    expect(killGroup).not.toHaveBeenCalled();
    expect(procs[0]!.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('render 失敗後もジョブは保持され、discard で破棄される（SSE 観測まで保持）', () => {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => { const p = makeFakeProc(); procs.push(p); return p; });
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup: vi.fn() });
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' });
    procs[0]!.emit('exit', 1);
    const job = m.get('p1');
    expect(job).toBeDefined();
    expect(job!.phase).toBe('failed');
    expect(job!.error?.code).toBe('render-failed');
    m.discard('p1');
    expect(m.get('p1')).toBeUndefined();
  });

  it('同一 projectId の二重 start は throw（already-running）', () => {
    const spawn = vi.fn(() => makeFakeProc());
    const m = new RenderJobManager({ spawn, rename: vi.fn(), unlink: vi.fn(), killGroup: vi.fn() });
    m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' });
    expect(() => m.start('p1', { projectDir: '/pj', needsInstall: false, tmpOutput: '/t', finalOutput: '/f' })).toThrow('already-running');
  });
});

describe('quoteForCmdShell', () => {
  it('空白を含む引数を quote する（最頻: C:\\Users\\John Doe）', () => {
    expect(quoteForCmdShell(['C:\\Users\\John Doe\\out\\a.mp4'])).toEqual(['"C:\\Users\\John Doe\\out\\a.mp4"']);
  });

  it('cmd 予約文字（& ( ) % 等）を含む空白なしパスも quote する', () => {
    expect(quoteForCmdShell(['C:\\pj\\R&D\\out\\a.mp4'])).toEqual(['"C:\\pj\\R&D\\out\\a.mp4"']);
    expect(quoteForCmdShell(['C:\\pj\\swing(2026)\\a.mp4'])).toEqual(['"C:\\pj\\swing(2026)\\a.mp4"']);
    expect(quoteForCmdShell(['C:\\pj\\50%off\\a.mp4'])).toEqual(['"C:\\pj\\50%off\\a.mp4"']);
    expect(quoteForCmdShell(['a^b', 'c|d', 'e<f>g', 'h!i', 'j;k', 'l=m'])).toEqual([
      '"a^b"', '"c|d"', '"e<f>g"', '"h!i"', '"j;k"', '"l=m"',
    ]);
  });

  it('安全な引数はそのまま通す', () => {
    expect(quoteForCmdShell(['remotion', 'render', 'MainVideo', 'C:\\pj\\out\\a.mp4'])).toEqual([
      'remotion', 'render', 'MainVideo', 'C:\\pj\\out\\a.mp4',
    ]);
  });
});
