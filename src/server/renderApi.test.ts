// src/server/renderApi.test.ts — reveal のプラットフォーム分岐と handleRenderPost の分岐を検証。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ServerResponse } from 'node:http';
import { revealInFinder, handleRenderReveal, handleRenderPost, handleRenderSse, renderJobs, tmpOutputName } from './renderApi';
import type { RenderJob, RenderJobEvent } from './renderJobTypes';

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
    socket:{localPort:2109},headers:{host:"untrusted.invalid"},
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
  it('reveals the completed 720p output, not an older full-size export', () => {
    const dir = makeProjectDir(false);
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'video.mp4'), 'older output');
    writeFileSync(join(dir, 'out', 'video-720p.mp4'), 'latest output');
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue({ projectId: 'p1', startedAt: 1, phase: 'done', outputFile: 'video-720p.mp4' });
    const reveal = vi.fn();
    const response = makeRes();
    handleRenderReveal(dummyReq, response.res, 'p1', dir, reveal);
    expect(response.status()).toBe(200);
    expect(reveal).toHaveBeenCalledWith(join(dir, 'out', 'video-720p.mp4'), process.platform);
  });

  it('does not substitute an older export when the latest completed output is missing', () => {
    const dir = makeProjectDir(false);
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'video.mp4'), 'older output');
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue({ projectId: 'p1', startedAt: 1, phase: 'done', outputFile: 'video-720p.mp4' });
    const reveal = vi.fn();
    const response = makeRes();
    handleRenderReveal(dummyReq, response.res, 'p1', dir, reveal);
    expect(response.status()).toBe(404);
    expect(reveal).not.toHaveBeenCalled();
  });

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
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(preparingJob);
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

describe('handleRenderPost native route', () => {
  it.each([true,false])('uses native export regardless of old node_modules: %s',async installed=>{
    const dir=makeProjectDir(installed),response=makeRes();
    const start=vi.spyOn(renderJobs,'start').mockReturnValue({projectId:'p1',startedAt:123,phase:'preparing',outputFile:'video.mp4'});
    await handleRenderPost(makeReq(),response.res,'p1',dir);
    expect(start).toHaveBeenCalledWith('p1',{projectDir:dir,origin:'http://127.0.0.1:2109',options:{resolution:'full',quality:'high'}});
    expect(response.status()).toBe(200);expect(response.body()).toMatchObject({ok:true,startedAt:123,outputFile:'video.mp4',native:true,fastCut:false});
  });
  it('passes resolution, quality, filename and ducking to the immutable native preparation',async()=>{
    const dir=makeProjectDir(false),response=makeRes(),options={resolution:'720p',quality:'light',outputName:'素振り result.mp4',ducking:{enabled:true,strength:'strong'}};
    const start=vi.spyOn(renderJobs,'start').mockReturnValue({projectId:'p1',startedAt:1,phase:'preparing'});
    await handleRenderPost(makeReq(JSON.stringify(options)),response.res,'p1',dir);
    expect(response.status()).toBe(200);expect(start).toHaveBeenCalledWith('p1',{projectDir:dir,origin:'http://127.0.0.1:2109',options});
  });
  it('keeps the running-job rejection and does not start a duplicate',async()=>{
    vi.spyOn(renderJobs,'exists').mockReturnValue(true);const start=vi.spyOn(renderJobs,'start'),response=makeRes();
    await handleRenderPost(makeReq(),response.res,'p1',makeProjectDir(false));
    expect(response.status()).toBe(409);expect(response.body()).toEqual({error:'already-running'});expect(start).not.toHaveBeenCalled();
  });
  it.each([undefined,'comparison.mp4'])('preserves existing output bytes: %s',async outputName=>{
    const dir=makeProjectDir(false);mkdirSync(join(dir,'out'));const file=join(dir,'out',outputName??'video.mp4');writeFileSync(file,'keep this video');
    const start=vi.spyOn(renderJobs,'start'),response=makeRes();
    await handleRenderPost(makeReq(JSON.stringify({resolution:'full',quality:'high',...(outputName?{outputName}:{})})),response.res,'p1',dir);
    expect(response.status()).toBe(409);expect(response.body()).toMatchObject({error:'output-exists'});expect(start).not.toHaveBeenCalled();expect(readFileSync(file,'utf8')).toBe('keep this video');
  });
  it.each(['{not json',JSON.stringify({resolution:'4k',quality:'high'}),JSON.stringify({resolution:'full',quality:'high',outputName:'../escape.mp4'})])('rejects malformed options before native preparation: %s',async value=>{
    const start=vi.spyOn(renderJobs,'start'),response=makeRes();await handleRenderPost(makeReq(value),response.res,'p1',makeProjectDir(false));
    expect(response.status()).toBe(400);expect(response.body()).toEqual({error:'invalid-render-options'});expect(start).not.toHaveBeenCalled();
  });
  it('rejects an oversized body before native preparation',async()=>{
    const start=vi.spyOn(renderJobs,'start'),response=makeRes();await handleRenderPost(makeReq(JSON.stringify({pad:'a'.repeat(2*1024*1024)})),response.res,'p1',makeProjectDir(false));
    expect(response.status()).toBe(413);expect(response.body()).toEqual({error:'render-body-too-large'});expect(start).not.toHaveBeenCalled();
  });
  it('does not activate mock warnings on the real native manager',async()=>{
    const start=vi.spyOn(renderJobs,'start').mockReturnValue({projectId:'p1',startedAt:1,phase:'preparing'}),warn=vi.spyOn(renderJobs,'warn');
    await handleRenderPost(makeReq(),makeRes().res,'p1',makeProjectDir(false),false,true);expect(start).toHaveBeenCalled();expect(warn).not.toHaveBeenCalled();
  });
});
