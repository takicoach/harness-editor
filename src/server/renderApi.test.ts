// src/server/renderApi.test.ts — reveal のプラットフォーム分岐と handleRenderPost の分岐を検証。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ServerResponse } from 'node:http';
import { revealInFinder, handleRenderPost, handleRenderSse, renderJobs, tmpOutputName } from './renderApi';
import type { RenderJob, RenderJobEvent } from './renderJob';

/** writeHead の status とレスポンス本文を捕捉するモック ServerResponse。 */
function makeRes(): { res: ServerResponse; status(): number; body(): unknown } {
  let status = 0;
  let body = '';
  const res = {
    writeHead(s: number) { status = s; return res; },
    end(chunk?: string) { if (chunk) body = chunk; return res; },
    write() { return true; },
    get writableEnded() { return false; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => (body ? JSON.parse(body) : undefined) };
}

/** body を async iterate できる fake IncomingMessage（空 body = 従来 POST の後方互換）。 */
function makeReq(bodyText = ''): never {
  const chunks = bodyText === '' ? [] : [Buffer.from(bodyText, 'utf8')];
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as never;
}
const dummyReq = makeReq();
const tmpDirs: string[] = [];
function makeProjectDir(withNodeModules: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-render-'));
  tmpDirs.push(dir);
  if (withNodeModules) mkdirSync(join(dir, 'node_modules'), { recursive: true });
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('revealInFinder', () => {
  it('darwin は open -R <path> を fire-and-forget で spawn する', () => {
    const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
    const spawnFn = vi.fn(() => child);
    revealInFinder('/pj/out/video.mp4', 'darwin', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('open', ['-R', '/pj/out/video.mp4'], expect.objectContaining({ stdio: 'ignore' }));
    expect(child.unref).toHaveBeenCalled();
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('win32 は explorer /select,<path> を spawn する', () => {
    const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
    const spawnFn = vi.fn(() => child);
    revealInFinder('C:\\pj\\out\\video.mp4', 'win32', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('explorer', ['/select,C:\\pj\\out\\video.mp4'], expect.objectContaining({ stdio: 'ignore' }));
  });

  it('その他 OS は xdg-open <dir> を spawn する', () => {
    const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
    const spawnFn = vi.fn(() => child);
    const p = '/pj/out/video.mp4';
    revealInFinder(p, 'linux', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', [dirname(p)], expect.objectContaining({ stdio: 'ignore' }));
  });
});

/** SSE 用の fake ServerResponse。writeHead/write/end を記録する。 */
function makeSseRes(): { res: ServerResponse; writes(): unknown[]; ended(): boolean } {
  const writes: string[] = [];
  let ended = false;
  const res = {
    writeHead() { return res; },
    write(chunk: string) { writes.push(chunk); return true; },
    end() { ended = true; return res; },
    get writableEnded() { return ended; },
  } as unknown as ServerResponse;
  return {
    res,
    writes: () => writes
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice('data: '.length).trim())),
    ended: () => ended,
  };
}

/** req.on('close', ...) を記録するだけの fake IncomingMessage。 */
function makeSseReq(): { req: never; closeHandlers: Array<() => void> } {
  const closeHandlers: Array<() => void> = [];
  const req = {
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return req;
    },
  };
  return { req: req as never, closeHandlers };
}

describe('handleRenderSse', () => {
  it('live 購読中に failed イベントを受けると unsub 後 discard を呼ぶ', () => {
    const projectId = `p-sse-live-failed-${Date.now()}`;
    const preparingJob: RenderJob = { projectId, startedAt: Date.now(), phase: 'preparing' };
    vi.spyOn(renderJobs, 'get').mockReturnValue(preparingJob);
    let capturedFn: ((ev: RenderJobEvent) => void) | undefined;
    const unsub = vi.fn();
    vi.spyOn(renderJobs, 'subscribe').mockImplementation((_id, fn) => {
      capturedFn = fn;
      return unsub;
    });
    const discardSpy = vi.spyOn(renderJobs, 'discard').mockImplementation(() => {});

    const { res, writes, ended } = makeSseRes();
    const { req } = makeSseReq();

    handleRenderSse(req, res, projectId);

    // snapshot（非 terminal）が送られ、subscribe が呼ばれている前提を確認
    expect(writes().some((w) => (w as { type: string }).type === 'snapshot')).toBe(true);
    expect(capturedFn).toBeDefined();
    expect(discardSpy).not.toHaveBeenCalled();

    // running 中に失敗イベントを emit
    capturedFn!({ phase: 'failed', error: { code: 'render-failed', message: 'boom' } });

    expect(discardSpy).toHaveBeenCalledWith(projectId);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(ended()).toBe(true);
    expect(writes().some((w) => (w as { type: string }).type === 'done')).toBe(true);
  });
});

describe('tmpOutputName', () => {
  it('projectId のパス区切りをサニタイズする', () => {
    expect(tmpOutputName('sub/proj', 123)).toBe('.sme-render-tmp-sub_proj-123.mp4');
    expect(tmpOutputName('a\\b', 1)).toBe('.sme-render-tmp-a_b-1.mp4');
  });
});

describe('handleRenderPost', () => {
  it('既にジョブが走っていれば 409 already-running を返す', async () => {
    vi.spyOn(renderJobs, 'exists').mockReturnValue(true);
    const startSpy = vi.spyOn(renderJobs, 'start');
    const dir = makeProjectDir(true);
    const { res, status, body } = makeRes();
    await handleRenderPost(dummyReq, res, 'p1', dir);
    expect(status()).toBe(409);
    expect(body()).toEqual({ error: 'already-running' });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('node_modules があれば needsInstall=false で out/ を作り tmp/final パスを渡す', async () => {
    vi.spyOn(renderJobs, 'exists').mockReturnValue(false);
    const startSpy = vi.spyOn(renderJobs, 'start').mockReturnValue({ projectId: 'p1', startedAt: 123, phase: 'preparing' });
    const dir = makeProjectDir(true);
    const { res, status, body } = makeRes();
    await handleRenderPost(dummyReq, res, 'p1', dir);
    expect(existsSync(join(dir, 'out'))).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const opts = startSpy.mock.calls[0]![1];
    expect(opts.needsInstall).toBe(false);
    expect(opts.finalOutput).toBe(join(dir, 'out', 'video.mp4'));
    expect(opts.tmpOutput).toMatch(new RegExp(`out/\\.sme-render-tmp-p1-\\d+\\.mp4$`));
    expect(dirname(opts.tmpOutput)).toBe(join(dir, 'out'));
    expect(status()).toBe(200);
    // fastCut=false: この fixture はテロップ等があるため通常の Remotion 経路。
    expect(body()).toEqual({ ok: true, startedAt: 123, fastCut: false });
  });

  it('node_modules が無ければ needsInstall=true を渡す', async () => {
    vi.spyOn(renderJobs, 'exists').mockReturnValue(false);
    const startSpy = vi.spyOn(renderJobs, 'start').mockReturnValue({ projectId: 'p1', startedAt: 1, phase: 'preparing' });
    const dir = makeProjectDir(false);
    const { res } = makeRes();
    await handleRenderPost(dummyReq, res, 'p1', dir);
    expect(startSpy.mock.calls[0]![1].needsInstall).toBe(true);
  });

  it('空 body は既定プリセット（中間 1.5 倍 SS・video.mp4・ffmpeg 仕上げ付き）で開始する', async () => {
    vi.spyOn(renderJobs, 'exists').mockReturnValue(false);
    const startSpy = vi.spyOn(renderJobs, 'start').mockReturnValue({ projectId: 'p1', startedAt: 1, phase: 'preparing' });
    const dir = makeProjectDir(true);
    const { res } = makeRes();
    await handleRenderPost(makeReq(), res, 'p1', dir);
    const opts = startSpy.mock.calls[0]![1];
    expect(opts.extraArgs).toEqual(['--crf', '14', '--scale', '1.5']);
    expect(opts.finalOutput).toBe(join(dir, 'out', 'video.mp4'));
    expect(opts.post!.command).toBe('ffmpeg');
    expect(opts.post!.output).toBe(`${opts.tmpOutput}.final.mp4`);
    expect(opts.post!.args.join(' ')).toContain('-crf 18');
  });

  it('720p/light の body は中間等倍・video-720p.mp4・仕上げ CRF 28 になる', async () => {
    vi.spyOn(renderJobs, 'exists').mockReturnValue(false);
    const startSpy = vi.spyOn(renderJobs, 'start').mockReturnValue({ projectId: 'p1', startedAt: 1, phase: 'preparing' });
    const dir = makeProjectDir(true);
    const { res } = makeRes();
    await handleRenderPost(makeReq(JSON.stringify({ resolution: '720p', quality: 'light' })), res, 'p1', dir);
    const opts = startSpy.mock.calls[0]![1];
    expect(opts.extraArgs).toEqual(['--crf', '14', '--scale', '1.5']);
    expect(opts.finalOutput).toBe(join(dir, 'out', 'video-720p.mp4'));
    expect(opts.post!.args.join(' ')).toContain('-crf 24');
  });

  it('不正な body は 400 invalid-render-options', async () => {
    vi.spyOn(renderJobs, 'exists').mockReturnValue(false);
    const startSpy = vi.spyOn(renderJobs, 'start');
    const dir = makeProjectDir(true);
    for (const bad of ['{not json', JSON.stringify({ resolution: '4k', quality: 'high' })]) {
      const { res, status, body } = makeRes();
      await handleRenderPost(makeReq(bad), res, 'p1', dir);
      expect(status()).toBe(400);
      expect(body()).toEqual({ error: 'invalid-render-options' });
    }
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('過大な body は 413 render-body-too-large で開始しない', async () => {
    vi.spyOn(renderJobs, 'exists').mockReturnValue(false);
    const startSpy = vi.spyOn(renderJobs, 'start');
    const dir = makeProjectDir(true);
    const { res, status, body } = makeRes();
    // 1MiB 上限を超える body（プリセットオプションは本来数KB）
    const huge = JSON.stringify({ pad: 'a'.repeat(2 * 1024 * 1024) });
    await handleRenderPost(makeReq(huge), res, 'p1', dir);
    expect(status()).toBe(413);
    expect(body()).toEqual({ error: 'render-body-too-large' });
    expect(startSpy).not.toHaveBeenCalled();
  });
});
