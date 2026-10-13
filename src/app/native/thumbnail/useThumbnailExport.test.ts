// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { textLayer, thumbnailFixture } from '../../../core/thumbnail/fixtures';
import type { ThumbnailDocument } from '../../../core/thumbnail/model';
import type { ThumbnailExportStatus } from './thumbnailApi';
import { summarizeExportAll, useThumbnailExport } from './useThumbnailExport';
import type { ThumbnailSessionHook } from './useThumbnailSession';

function threePages(): ThumbnailDocument {
  const document = thumbnailFixture();
  document.pages[0]!.layers = [textLayer('a')];
  document.pages.push({ id: 'page-b', name: '案B', hueShift: 0, layers: [textLayer('b')] }, { id: 'page-c', name: '案C', hueShift: 0, layers: [textLayer('c')] });
  return document;
}
const status = (executionId: string, pageId: string, pageName: string, phase: ThumbnailExportStatus['phase'], extra: Partial<ThumbnailExportStatus> = {}): ThumbnailExportStatus =>
  ({ executionId, jobId: `job-${executionId}`, pageId, pageName, main: pageId === 'page-a', revision: 0, contentHash: 'h', format: 'png', phase, ...extra });
/** 書き出しの API の代わり。案ごとに「始める → 1 回目の照会で完了」。同時に 2 本走らせたら記録する。 */
function server(document: ThumbnailDocument, overLimit: string[] = []) {
  const log: string[] = [], jobs = new Map<string, { pageId: string; format: string; polls: number }>();
  let running = 0, overlap = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost'), route = url.pathname.replace('/api/thumbnail', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const name = (pageId: string) => document.pages.find(page => page.id === pageId)!.name;
    if (route === '/export') {
      if (running > 0) overlap = true;
      running += 1; jobs.set(body.executionId, { pageId: body.pageId, format: body.format, polls: 0 }); log.push(`start ${body.pageId} ${body.format}`);
      return new Response(JSON.stringify(status(body.executionId, body.pageId, name(body.pageId), 'checking', { format: body.format })));
    }
    if (route === '/export/status') {
      const executionId = url.searchParams.get('executionId')!, job = jobs.get(executionId)!;
      job.polls += 1;
      if (job.polls === 1) running -= 1;
      const extension = job.format === 'png' ? '.png' : '.jpg', base = job.pageId === 'page-a' ? 'サムネ_p' : `サムネ_p_${name(job.pageId)}`;
      return new Response(JSON.stringify(status(executionId, job.pageId, name(job.pageId), 'complete',
        { format: job.format as 'png', fileName: `サムネ/${base}${extension}`, bytes: 10, overLimit: job.format === 'png' && overLimit.includes(job.pageId) })));
    }
    throw new Error(`想定外の経路: ${route}`);
  }));
  return { log, overlap: () => overlap };
}
/**
 * 取消を確かめるための書き出しの API。開始の応答は hold が解けるまで返さない。照会は completeAfter 回目で完了、取消を受けたら次の照会で cancelled。
 * 取消は「cancel <案>」として記録する（要求 ID は案に読み替える）。
 */
function controlledServer(document: () => ThumbnailDocument, { completeAfter = 2, hold }: { completeAfter?: number; hold?: Promise<void> } = {}) {
  const log: string[] = [], jobs = new Map<string, { pageId: string; pageName: string; polls: number; cancelled: boolean }>();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost'), route = url.pathname.replace('/api/thumbnail', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (route === '/export') {
      const page = document().pages.find(item => item.id === body.pageId);
      log.push(`start ${body.pageId} ${body.format}`);
      if (!page) return new Response(JSON.stringify({ error: '対象の案が見つかりません' }), { status: 404 });
      // 開始の応答を返すまでは、まだ書き出しを知らない（取消は 404）。
      if (hold) await hold;
      jobs.set(body.executionId, { pageId: page.id, pageName: page.name, polls: 0, cancelled: false });
      return new Response(JSON.stringify(status(body.executionId, page.id, page.name, 'checking')));
    }
    if (route === '/export/cancel') {
      const job = jobs.get(body.executionId);
      log.push(`cancel ${job?.pageId ?? 'unknown'}`);
      if (!job) return new Response(JSON.stringify({ error: '書き出しの記録がありません' }), { status: 404 });
      job.cancelled = true;
      return new Response(JSON.stringify(status(body.executionId, job.pageId, job.pageName, 'rendering')));
    }
    if (route === '/export/status') {
      const executionId = url.searchParams.get('executionId')!, job = jobs.get(executionId)!;
      job.polls += 1;
      const phase = job.cancelled ? 'cancelled' : job.polls >= completeAfter ? 'complete' : 'rendering';
      return new Response(JSON.stringify(status(executionId, job.pageId, job.pageName, phase, phase === 'complete' ? { fileName: `サムネ/サムネ_p_${job.pageName}.png`, bytes: 10 } : {})));
    }
    throw new Error(`想定外の経路: ${route}`);
  }));
  return { log };
}
function hook(document: ThumbnailDocument | (() => ThumbnailDocument)) {
  const toasts: string[] = [], read = typeof document === 'function' ? document : () => document;
  const session = { exportTick: 0, readCurrent: () => ({ sessionId: 's', document: read() }) } as unknown as ThumbnailSessionHook;
  const view = renderHook(() => useThumbnailExport({ projectId: 'p', session, flush: async () => true, onToast: message => { toasts.push(message); } }));
  return { ...view, toasts };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(() => vi.unstubAllGlobals());

describe('すべての案を書き出す', () => {
  it('案を 1 本ずつ順に書き出し、終わったら書き出した名前の一覧を 1 回だけ知らせる', async () => {
    const document = threePages(), api = server(document), { result, toasts } = hook(document);
    await act(async () => { await result.current.startAll(); });
    expect(api.log).toEqual(['start page-a png', 'start page-b png', 'start page-c png']);
    expect(api.overlap()).toBe(false);
    expect(toasts).toEqual(['3 枚を書き出しました: サムネ_p.png、サムネ_p_案B.png、サムネ_p_案C.png']);
    expect(result.current.batchResult).toMatchObject({ names: ['サムネ_p.png', 'サムネ_p_案B.png', 'サムネ_p_案C.png'], overLimit: [] });
    expect(result.current.running).toBe(false);
  });
  it('2MB を超えた案は名前を挙げ、JPEG での書き出し直しはその案だけを JPEG で書く', async () => {
    const document = threePages(), api = server(document, ['page-b']), { result } = hook(document);
    await act(async () => { await result.current.startAll(); });
    expect(result.current.batchResult!.overLimit).toEqual([{ pageId: 'page-b', pageName: '案B' }]);
    api.log.length = 0;
    await act(async () => { await result.current.redoOverLimitAsJpeg(); });
    expect(api.log).toEqual(['start page-b jpeg']);
    await waitFor(() => expect(result.current.batchResult).toMatchObject({ names: ['サムネ_p_案B.jpg'], overLimit: [] }));
  });
  it('書き出しの途中で画面を閉じたら、次の案は送らず、走っている 1 件に取消を送る', async () => {
    const document = threePages(), api = controlledServer(() => document), { result, unmount } = hook(document);
    let run!: Promise<void>;
    act(() => { run = result.current.startAll(); });
    await waitFor(() => expect(api.log).toEqual(['start page-a png']));
    unmount();
    await run;
    await sleep(1200);
    expect(api.log).toEqual(['start page-a png', 'cancel page-a']);
  });
  it('開始の応答を待つ間に画面を閉じても、応答の直後に取消を送り、次の案は送らない', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const document = threePages(), api = controlledServer(() => document, { hold }), { result, unmount } = hook(document);
    let run!: Promise<void>;
    act(() => { run = result.current.startAll(); });
    await waitFor(() => expect(api.log).toEqual(['start page-a png']));
    unmount();
    release();
    await run;
    await sleep(1200);
    expect(api.log).toEqual(['start page-a png', 'cancel page-a']);
  });
  it('書き出すと同じファイル名になる案がある古い文書は、名前を示して書き出す前に止める', async () => {
    const document = threePages();
    document.pages[1]!.name = '案a'; document.pages[2]!.name = 'A/B';
    const api = controlledServer(() => document), { result, toasts } = hook(document);
    await act(async () => { await result.current.startAll(); });
    expect(api.log).toEqual([]);
    expect(result.current.error).toBe('案A・案a は書き出すと同じファイル名になります。名前を変えてから書き出してください');
    expect(toasts).toEqual([result.current.error]);
    expect(result.current.running).toBe(false);
  });
  it('途中で案が削除されたら残りを書き出さずに止め、その旨を知らせる', async () => {
    let current = threePages();
    const api = controlledServer(() => current), { result, toasts } = hook(() => current);
    let run!: Promise<void>;
    act(() => { run = result.current.startAll(); });
    await waitFor(() => expect(api.log).toEqual(['start page-a png']));
    current = { ...current, revision: 1, pages: current.pages.filter(page => page.id !== 'page-b') };
    await act(async () => { await run; });
    expect(api.log).toEqual(['start page-a png']);
    expect(toasts).toEqual(['1 枚を書き出しました: サムネ_p_案A.png。途中で案が削除されたので、残りの書き出しは止めました']);
    expect(result.current.running).toBe(false);
  });
  it('開始の応答が戻る前に取り消しても、戻った直後に取消を送り、取り消したと知らせる', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const document = threePages(), api = controlledServer(() => document, { hold }), { result, toasts } = hook(document);
    let run!: Promise<void>;
    act(() => { run = result.current.startAll(); });
    await waitFor(() => expect(api.log).toEqual(['start page-a png']));
    act(() => { result.current.cancel(); });
    release();
    await act(async () => { await run; });
    expect(api.log).toEqual(['start page-a png', 'cancel page-a']);
    expect(toasts).toEqual(['書き出しを取り消しました']);
    expect(result.current.running).toBe(false);
  });
});
describe('summarizeExportAll', () => {
  it('書き出せなかった案と理由も知らせる。取り消したら取り消したと知らせる', () => {
    const done = status('1', 'page-a', '案A', 'complete', { fileName: 'サムネ/サムネ_p.png' });
    const failed = status('2', 'page-b', '案B', 'failed', { error: '画像が見つかりません（photo.png）' });
    expect(summarizeExportAll([done, failed]).message).toBe('1 枚を書き出しました: サムネ_p.png。書き出せなかった案: 案B（画像が見つかりません（photo.png））');
    expect(summarizeExportAll([done, status('3', 'page-b', '案B', 'cancelled')]).message).toBe('1 枚を書き出しました: サムネ_p.png。残りの書き出しは取り消しました');
  });
});
