// src/server/eventsApi.test.ts — GET /api/events(?id=) の多重化・初期スナップショット・
// terminal 後の再購読・heartbeat・close 時の購読解除/selfWrite クリアを検証する。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ServerResponse } from 'node:http';

vi.mock('./watchProject', () => ({
  watchProject: vi.fn(() => vi.fn()),
}));
vi.mock('./projectsWatch', () => ({
  watchAllProjectsStatus: vi.fn(() => vi.fn()),
}));

import { handleEventsSse, handleEventsSync } from './eventsApi';
import { HttpError } from './http';
import { watchProject } from './watchProject';
import { watchAllProjectsStatus } from './projectsWatch';
import { instructionInbox } from './instructionInbox';
import { renderJobs } from './renderApi';
import { denoiseJobs } from './denoiseApi';
import { normalizeJobs } from './normalizeApi';
import { previewProxyJobs } from './previewProxyApi';
import { transcribeJobs } from './transcribeApi';
import type { RenderJob, RenderJobEvent } from './renderJobTypes';

/** SSE 用の fake ServerResponse。writeHead/write/end を記録する。 */
function makeSseRes(): { res: ServerResponse; messages(): Array<{ ch: string; msg: unknown }>; ended(): boolean } {
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
    messages: () =>
      writes
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice('data: '.length).trim()) as { ch: string; msg: unknown }),
    ended: () => ended,
  };
}

/** req.on('close', ...) を記録するだけの fake IncomingMessage。 */
function makeSseReq(): { req: never; close(): void } {
  const closeHandlers: Array<() => void> = [];
  const req = {
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return req;
    },
  };
  return { req: req as never, close: () => closeHandlers.forEach((h) => h()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(instructionInbox, 'list').mockReturnValue([]);
  vi.spyOn(instructionInbox, 'subscribe').mockReturnValue(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('connects other channels immediately and isolates a failed delayed render restore',async()=>{
  const {res,messages,ended}=makeSseRes(),{req,close}=makeSseReq();
  let reject!:(error:Error)=>void;const restore=()=>new Promise<unknown[]>((_resolve,fail)=>{reject=fail;});
  handleEventsSse(req,res,'/root','p',undefined,restore);
  expect(messages().some(item=>item.ch==='projects')).toBe(true);expect(messages().some(item=>item.ch==='denoise')).toBe(true);
  expect(messages().some(item=>item.ch==='render')).toBe(false);expect(ended()).toBe(false);
  reject(new Error('corrupted history'));await vi.waitFor(()=>expect(messages()).toContainEqual({ch:'render',msg:{type:'done',phase:'failed',error:{code:'restore-failed',message:'Error: corrupted history'}}}));
  expect(ended()).toBe(false);close();
});

it('does not overwrite a newer render event with a delayed restored snapshot',async()=>{
  const {res,messages}=makeSseRes(),{req,close}=makeSseReq();let listener!:(event:RenderJobEvent)=>void,resolve!:(messages:unknown[])=>void;
  vi.spyOn(renderJobs,'subscribe').mockImplementation((_id,fn)=>{listener=fn;return ()=>{};});
  handleEventsSse(req,res,'/root','p',undefined,()=>new Promise(done=>{resolve=done;}));
  listener({phase:'preparing'} as RenderJobEvent);resolve([{type:'idle'}]);await Promise.resolve();
  expect(messages().filter(item=>item.ch==='render')).toEqual([{ch:'render',msg:{type:'event',event:{phase:'preparing'}}}]);close();
});

describe('handleEventsSse — id 無し（ホーム画面）', () => {
  it('projects チャネルのみ配線する（watch/claude/job 系は張らない）', () => {
    const { res, messages } = makeSseRes();
    const { req } = makeSseReq();

    handleEventsSse(req, res, '/root', null);

    expect(watchAllProjectsStatus).toHaveBeenCalledTimes(1);
    expect(watchProject).not.toHaveBeenCalled();
    const chs = messages().map((m) => m.ch);
    expect(chs).toEqual(['projects']);
    expect(messages()[0]).toEqual({ ch: 'projects', msg: { type: 'open' } });
  });
});

describe('handleEventsSse — id 有り（エディタ画面）', () => {
  it('全チャネル（projects/watch/claude/render/denoise/normalize/preview-proxy/transcribe）を配線する', () => {
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(undefined);
    vi.spyOn(renderJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(denoiseJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'subscribe').mockReturnValue(vi.fn());

    const { res, messages } = makeSseRes();
    const { req } = makeSseReq();

    handleEventsSse(req, res, '/root', 'p1');

    expect(watchAllProjectsStatus).toHaveBeenCalledTimes(1);
    expect(watchProject).toHaveBeenCalledTimes(1);
    const chs = messages().map((m) => m.ch);
    expect(chs).toEqual(
      expect.arrayContaining(['projects', 'watch', 'claude', 'render', 'denoise', 'normalize', 'preview-proxy', 'transcribe']),
    );
    // ジョブ系はジョブ無し = idle。
    for (const ch of ['render', 'denoise', 'normalize', 'preview-proxy', 'transcribe']) {
      expect(messages()).toContainEqual({ ch, msg: { type: 'idle' } });
    }
  });

  it('claude チャネルは接続時に list(id) を update として一括送信する', () => {
    vi.spyOn(instructionInbox, 'list').mockReturnValue([
      { id: 'i1', projectId: 'p1', projectDir: '/root/p1', text: 'hi', context: { frame: 0, timeSec: 0, selection: null }, status: 'pending', reply: null, createdAt: 1, updatedAt: 1 },
    ]);
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(undefined);
    vi.spyOn(renderJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(denoiseJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'subscribe').mockReturnValue(vi.fn());

    const { res, messages } = makeSseRes();
    const { req } = makeSseReq();

    handleEventsSse(req, res, '/root', 'p1');

    expect(messages()).toContainEqual({ ch: 'claude', msg: { type: 'update', record: expect.objectContaining({ id: 'i1' }) } });
  });

  it('claude チャネルの subscribe は該当 projectId のレコードのみ送る', () => {
    let capturedFn: ((record: unknown) => void) | undefined;
    vi.spyOn(instructionInbox, 'subscribe').mockImplementation((fn) => {
      capturedFn = fn as (record: unknown) => void;
      return vi.fn();
    });
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(undefined);
    vi.spyOn(renderJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(denoiseJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'subscribe').mockReturnValue(vi.fn());

    const { res, messages } = makeSseRes();
    const { req } = makeSseReq();
    handleEventsSse(req, res, '/root', 'p1');

    expect(capturedFn).toBeDefined();
    capturedFn!({ id: 'i2', projectId: 'other', text: 'x' });
    capturedFn!({ id: 'i3', projectId: 'p1', text: 'y' });

    expect(messages()).not.toContainEqual(expect.objectContaining({ ch: 'claude', msg: expect.objectContaining({ record: expect.objectContaining({ id: 'i2' }) }) }));
    expect(messages()).toContainEqual({ ch: 'claude', msg: { type: 'update', record: { id: 'i3', projectId: 'p1', text: 'y' } } });
  });

  it('render ジョブが既に走っていれば snapshot を送る', () => {
    const job: RenderJob = { projectId: 'p1', startedAt: 100, phase: 'rendering' };
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(job);
    vi.spyOn(renderJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(denoiseJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'subscribe').mockReturnValue(vi.fn());

    const { res, messages } = makeSseRes();
    const { req } = makeSseReq();
    handleEventsSse(req, res, '/root', 'p1');

    expect(messages()).toContainEqual({ ch: 'render', msg: { type: 'snapshot', job } });
  });

  it('terminal（failed）イベント観測で discard するが、再 subscribe はしない（I-1 修正後は 1 回の subscribe で足りる）', () => {
    const preparingJob: RenderJob = { projectId: 'p1', startedAt: 1, phase: 'preparing' };
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(preparingJob);
    const subscribeSpy = vi.spyOn(renderJobs, 'subscribe');
    let capturedFn: ((ev: RenderJobEvent) => void) | undefined;
    subscribeSpy.mockImplementation((_id, fn) => {
      capturedFn = fn;
      return vi.fn();
    });
    const discardSpy = vi.spyOn(renderJobs, 'discard').mockImplementation(() => {});
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(denoiseJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'subscribe').mockReturnValue(vi.fn());

    const { res, messages, ended } = makeSseRes();
    const { req } = makeSseReq();
    handleEventsSse(req, res, '/root', 'p1');

    expect(capturedFn).toBeDefined();
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    capturedFn!({ phase: 'failed', error: { code: 'render-failed', message: 'boom' } });

    expect(discardSpy).toHaveBeenCalledWith('p1');
    // terminal でも接続自体は閉じない（統合接続は張りっぱなし）。
    expect(ended()).toBe(false);
    expect(messages()).toContainEqual({ ch: 'render', msg: { type: 'done', phase: 'failed', error: { code: 'render-failed', message: 'boom' } } });
    // I-1 修正前は「次のジョブに備えて」unsubscribe→再 subscribe していたが、Manager の
    // cleanup() が subs を消さなくなったため、1 回の subscribe が次のジョブの emit も
    // 引き続き受け取れる。再 subscribe は起きない。
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('handleEventsSse — I-1 回帰: 同一プロジェクトへの複数接続', () => {
  // Channel wiring across repeated terminal events. The actual native facade's
  // discard/subscription lifecycle is covered separately in legacyNativeRenderJobs.test.ts.
  it('2接続 subscribe → job1 done（片方が discard）→ job2 start/done → 両接続が受信する', () => {
    vi.restoreAllMocks();
    const listeners=new Set<(event:RenderJobEvent)=>void>();
    vi.spyOn(renderJobs,'getSnapshot').mockReturnValue(undefined);
    vi.spyOn(renderJobs,'subscribe').mockImplementation((_id,listener)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};});
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(denoiseJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(instructionInbox, 'list').mockReturnValue([]);
    vi.spyOn(instructionInbox, 'subscribe').mockReturnValue(vi.fn());

    const projectId = `p-i1-regress-${Date.now()}`;
    try {
      // 接続時点ではジョブ無し（idle）。
      const { res: res1, messages: messages1 } = makeSseRes();
      const { req: req1 } = makeSseReq();
      handleEventsSse(req1, res1, '/root', projectId);

      const { res: res2, messages: messages2 } = makeSseRes();
      const { req: req2 } = makeSseReq();
      handleEventsSse(req2, res2, '/root', projectId);

      expect(messages1()).toContainEqual({ ch: 'render', msg: { type: 'idle' } });
      expect(messages2()).toContainEqual({ ch: 'render', msg: { type: 'idle' } });

      for(const listener of listeners)listener({phase:'cancelled'});

      const done1 = { ch: 'render', msg: { type: 'done', phase: 'cancelled', error: undefined } };
      expect(messages1()).toContainEqual(done1);
      expect(messages2()).toContainEqual(done1);

      // job2: 同じ2接続が job1 の discard 後も生きていることを確認する（本バグの核心）。
      for(const listener of listeners)listener({phase:'cancelled'});

      const done2 = { ch: 'render', msg: { type: 'done', phase: 'cancelled', error: undefined } };
      // toContainEqual は「含む」判定なので、2回目の done も両方の接続に届いたことを
      // 呼び出し回数で確認する（1回目と同じペイロードのため個数で判定）。
      expect(messages1().filter((m) => m.ch === 'render' && (m.msg as { type: string }).type === 'done')).toHaveLength(2);
      expect(messages2().filter((m) => m.ch === 'render' && (m.msg as { type: string }).type === 'done')).toHaveLength(2);
      expect(messages1()).toContainEqual(done2);
      expect(messages2()).toContainEqual(done2);
    } finally {
      listeners.clear();
    }
  });
});

describe('handleEventsSse — close', () => {
  it('close で全チャネルの watcher を停止し selfWrite をクリアする', () => {
    const stopWatch = vi.fn();
    vi.mocked(watchProject).mockReturnValue(stopWatch);
    const stopProjects = vi.fn();
    vi.mocked(watchAllProjectsStatus).mockReturnValue(stopProjects);

    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(undefined);
    const renderUnsub = vi.fn();
    vi.spyOn(renderJobs, 'subscribe').mockReturnValue(renderUnsub);
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(denoiseJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'subscribe').mockReturnValue(vi.fn());
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'subscribe').mockReturnValue(vi.fn());

    const { res, ended } = makeSseRes();
    const { req, close } = makeSseReq();
    handleEventsSse(req, res, '/root', 'p1');

    close();

    expect(stopWatch).toHaveBeenCalledTimes(1);
    expect(stopProjects).toHaveBeenCalledTimes(1);
    expect(renderUnsub).toHaveBeenCalledTimes(1);
    expect(ended()).toBe(true);
  });
});

describe('handleEventsSync', () => {
  it('preserves a completed render warning in both reconnect messages', () => {
    const job: RenderJob = { projectId: 'completed-output', startedAt: 1, phase: 'done', outputFile: 'video-720p.mp4', warning: 'frame count differs' };
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(job);
    expect(handleEventsSync('completed-output', 'render')).toEqual({ messages: [
      { type: 'snapshot', job },
      { type: 'done', phase: 'done', error: undefined, warning: 'frame count differs' },
    ] });
  });

  it('ジョブ無し（idle）は { messages: [{type:"idle"}] } を返す', () => {
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(undefined);
    expect(handleEventsSync('p1', 'render')).toEqual({ messages: [{ type: 'idle' }] });
  });

  it('running 中ジョブは snapshot のみ返し discard しない', () => {
    const job: RenderJob = { projectId: 'p1', startedAt: 1, phase: 'rendering' };
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(job);
    const discardSpy = vi.spyOn(renderJobs, 'discard').mockImplementation(() => {});
    expect(handleEventsSync('p1', 'render')).toEqual({ messages: [{ type: 'snapshot', job }] });
    expect(discardSpy).not.toHaveBeenCalled();
  });

  it('terminal（failed）ジョブは snapshot+done を返すが discard しない（M-1: sync は読み取り専用）', () => {
    const job: RenderJob = { projectId: 'p1', startedAt: 1, phase: 'failed', error: { code: 'x', message: 'boom' } };
    vi.spyOn(renderJobs, 'getSnapshot').mockReturnValue(job);
    const discardSpy = vi.spyOn(renderJobs, 'discard').mockImplementation(() => {});
    expect(handleEventsSync('p1', 'render')).toEqual({
      messages: [
        { type: 'snapshot', job },
        { type: 'done', phase: 'failed', error: { code: 'x', message: 'boom' } },
      ],
    });
    // terminal ジョブの破棄は接続時 wireJobChannel／ライブイベント経路の2箇所に集約し、
    // sync 経由では discard しない（M-1）。
    expect(discardSpy).not.toHaveBeenCalled();
  });

  it('claude チャネルは list(id) を update の配列として返す（open は含まない）', () => {
    vi.spyOn(instructionInbox, 'list').mockReturnValue([
      { id: 'i1', projectId: 'p1', projectDir: '/root/p1', text: 'hi', context: { frame: 0, timeSec: 0, selection: null }, status: 'pending', reply: null, createdAt: 1, updatedAt: 1 },
    ]);
    const result = handleEventsSync('p1', 'claude');
    expect(result.messages).toEqual([{ type: 'update', record: expect.objectContaining({ id: 'i1' }) }]);
  });

  it('denoise/normalize/preview-proxy/transcribe も対応する', () => {
    vi.spyOn(denoiseJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(normalizeJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(previewProxyJobs, 'get').mockReturnValue(undefined);
    vi.spyOn(transcribeJobs, 'get').mockReturnValue(undefined);
    for (const ch of ['denoise', 'normalize', 'preview-proxy', 'transcribe']) {
      expect(handleEventsSync('p1', ch)).toEqual({ messages: [{ type: 'idle' }] });
    }
  });

  it('projects/watch や未知チャネルは 400 HttpError', () => {
    for (const ch of ['projects', 'watch', 'bogus']) {
      expect(() => handleEventsSync('p1', ch)).toThrow(HttpError);
    }
  });
});
