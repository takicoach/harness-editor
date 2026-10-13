import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shapeLayer, textLayer, thumbnailFixture } from '../../core/thumbnail/fixtures';
import type { ThumbnailCapture } from './capture';
import { ThumbnailPreviews } from './previews';
import { ThumbnailRenderInputs } from './renderInputs';
import type { ThumbnailEvent, ThumbnailSessionState } from './service';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function project(): string { const directory = mkdtempSync(join(tmpdir(), 'thumb-preview-')); directories.push(directory); return directory; }
function stateWith(hashes: Record<string, string>): ThumbnailSessionState {
  const document = thumbnailFixture();
  document.pages[0]!.layers = [textLayer('t'), shapeLayer('s')];
  document.pages.push({ id: 'page-b', name: '案B', hueShift: 0, layers: [] });
  return { sessionId: 's', document, savedRevision: 0, savedContentHash: 'h', canUndo: false, canRedo: false, dirty: false, pageHashes: hashes };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('ThumbnailPreviews', () => {
  it('案件ごとに 1 件ずつ撮り、同じ案の待ちは最新だけ残す。古い指紋の画像は返さない', async () => {
    const directory = project(), gate = deferred(), captured: string[] = [], events: ThumbnailEvent[] = [], scales: number[] = [];
    const capture: ThumbnailCapture = async (target, plan) => { captured.push(target.jobId); scales.push(plan[0]!.scale!); await gate.promise; return { bytes: Buffer.from(target.jobId), shot: plan[0]! }; };
    const previews = new ThumbnailPreviews(capture, new ThumbnailRenderInputs(), (_directory, event) => events.push(event));
    const ask = (hash: string) => previews.request({ directory, projectId: 'p', origin: 'http://127.0.0.1:1', state: stateWith({ 'page-a': hash, 'page-b': 'b1' }), pageId: 'page-a' });
    expect(ask('a1')).toEqual({ pageId: 'page-a', contentHash: 'a1', ready: false });
    ask('a2'); ask('a3');
    gate.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(captured).toEqual(['preview-a1', 'preview-a3']);
    expect(scales).toEqual([.25, .25]);
    expect(previews.image(directory, 'page-a', 'a3')!.toString()).toBe('preview-a3');
    expect(previews.image(directory, 'page-a', 'a2')).toBeUndefined();
    expect(ask('a3').ready).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'preview', pageId: 'page-a', contentHash: 'a3' });
  });
  it('撮影に失敗しても例外を外へ出さず、画像も残さない', async () => {
    const directory = project(), capture: ThumbnailCapture = async () => { throw new Error('撮れない'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previews = new ThumbnailPreviews(capture, new ThumbnailRenderInputs());
    previews.request({ directory, projectId: 'p', origin: 'o', state: stateWith({ 'page-a': 'x', 'page-b': 'y' }), pageId: 'page-b' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(previews.image(directory, 'page-b', 'y')).toBeUndefined();
    warn.mockRestore();
  });
});
