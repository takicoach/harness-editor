import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slidesFixture } from '../../core/slides/fixtures';
import type { SlidesCapture } from './capture';
import { SlidesPreviews } from './previews';
import { createSlidesProject } from './projects';
import { SlidesRenderInputs } from './renderInputs';
import { SlidesService } from './service';
import { SlidesStore } from './store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'slides-previews-')); roots.push(root);
  const { id } = createSlidesProject(root, '講義'), directory = join(root, id);
  new SlidesStore(directory).save({ expectedSavedRevision: 0, executionId: 'seed', document: { ...slidesFixture(), revision: 1 } });
  return { directory, state: new SlidesService().open(directory) };
}

describe('SlidesPreviews', () => {
  it('待っているページを 1 つのブラウザでまとめて撮り、指紋が同じなら撮り直さない', async () => {
    const { directory, state } = setup(), counts: number[] = [], events: string[] = [];
    const capture: SlidesCapture = async (_target, count, shot, onPage) => {
      counts.push(count); expect(shot).toEqual({ format: 'png', scale: 1 / 6 });
      for (let index = 0; index < count; index++) await onPage(index, Buffer.from(`png-${index}`));
    };
    const previews = new SlidesPreviews(capture, new SlidesRenderInputs(), (_directory, event) => events.push(event.type));
    const input = { directory, projectId: '講義', origin: 'http://127.0.0.1:1', state, pageIds: ['page-1', 'page-2'] };
    expect(previews.request(input).map(item => item.ready)).toEqual([false, false]);
    await vi.waitFor(() => expect(events).toEqual(['preview', 'preview']));
    expect(counts).toEqual([2]);
    expect(previews.image(directory, 'page-2', state.pageHashes['page-2']!)?.toString()).toBe('png-1');
    expect(previews.request(input).every(item => item.ready)).toBe(true);
    expect(counts).toEqual([2]);
    expect(previews.image(directory, 'page-2', 'old-hash')).toBeUndefined();
  });
  it('撮影に失敗したら失敗と理由を知らせ（ready:false のまま放置しない）、自動では撮り直さない。retry か時間が経てば撮り直す', async () => {
    const { directory, state } = setup(), events: Array<{ pageId: string; error?: string }> = [];
    let fail = true, calls = 0, clock = 1_000_000;
    const capture: SlidesCapture = async (_target, count, _shot, onPage) => { calls++; if (fail) throw new Error('撮れません'); for (let i = 0; i < count; i++) await onPage(i, Buffer.from('ok')); };
    const previews = new SlidesPreviews(capture, new SlidesRenderInputs(), (_directory, event) => { if (event.type === 'preview') events.push({ pageId: event.pageId, error: event.error }); }, () => clock);
    const input = { directory, projectId: '講義', origin: 'http://x', state, pageIds: ['page-1'] };
    previews.request(input);
    await vi.waitFor(() => expect(events).toEqual([{ pageId: 'page-1', error: expect.stringContaining('撮れません') }]));
    await vi.waitFor(() => expect(previews.get('講義', directory)).toBeUndefined());
    expect(previews.request(input)).toEqual([{ pageId: 'page-1', contentHash: state.pageHashes['page-1'], ready: false, failed: true, error: expect.stringContaining('撮れません') }]);
    expect(calls).toBe(1);
    // 明示の再要求（retry）で撮り直す。
    previews.request({ ...input, retry: true });
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => expect(previews.get('講義', directory)).toBeUndefined());
    expect(previews.request(input)[0]).toMatchObject({ ready: false, failed: true });
    // 時間が経てば、次の依頼で撮り直す。
    fail = false; clock += 60_000;
    expect(previews.request(input)[0]).toMatchObject({ ready: false });
    expect(previews.request(input)[0]!.failed).toBeUndefined();
    await vi.waitFor(() => expect(previews.image(directory, 'page-1', state.pageHashes['page-1']!)?.toString()).toBe('ok'));
    expect(calls).toBe(3);
  });
  it('重い処理の枠が空いていない時は Chromium を起動せず、理由付きで知らせる（あとで頼み直せる）。撮影中は activeCount に数える', async () => {
    const { directory, state } = setup();
    let finish = () => {}, markStarted = () => {}, calls = 0;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const capture: SlidesCapture = async (_target, count, _shot, onPage) => {
      calls++; await new Promise<void>(resolve => { finish = resolve; markStarted(); });
      for (let i = 0; i < count; i++) await onPage(i, Buffer.from('ok'));
    };
    const previews = new SlidesPreviews(capture, new SlidesRenderInputs());
    const input = { directory, projectId: '講義', origin: 'http://x', state, pageIds: ['page-1', 'page-2'] };
    expect(previews.request({ ...input, allowed: false })).toEqual(['page-1', 'page-2'].map(pageId => ({ pageId, contentHash: state.pageHashes[pageId], ready: false, failed: true,
      error: expect.stringContaining('ほかの重い処理') })));
    expect([calls, previews.activeCount()]).toEqual([0, 0]);
    previews.request(input);
    await started;
    expect(previews.activeCount()).toBe(1);
    finish();
    await vi.waitFor(() => expect(previews.activeCount()).toBe(0));
    expect(previews.request({ ...input, allowed: false }).every(item => item.ready)).toBe(true);
  });
  it('知らないページは 404。撮影に失敗しても次の依頼は受け付ける', async () => {
    const { directory, state } = setup();
    let fail = true;
    const capture: SlidesCapture = async (_target, count, _shot, onPage) => { if (fail) throw new Error('撮れません'); for (let i = 0; i < count; i++) await onPage(i, Buffer.from('ok')); };
    const previews = new SlidesPreviews(capture, new SlidesRenderInputs());
    expect(() => previews.request({ directory, projectId: '講義', origin: 'http://x', state, pageIds: ['nope'] })).toThrow('対象のページが見つかりません');
    previews.request({ directory, projectId: '講義', origin: 'http://x', state, pageIds: ['page-1'] });
    await vi.waitFor(() => expect(previews.get('講義', directory)).toBeUndefined());
    fail = false;
    previews.request({ directory, projectId: '講義', origin: 'http://x', state, pageIds: ['page-1'], retry: true });
    await vi.waitFor(() => expect(previews.image(directory, 'page-1', state.pageHashes['page-1']!)?.toString()).toBe('ok'));
  });
});
