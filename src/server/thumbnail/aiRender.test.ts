import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { thumbnailFixture, VIDEO_ASSET } from '../../core/thumbnail/fixtures';
import type { ThumbnailFramesCapture } from './capture';
import { createThumbnailAiRender, fitLongSide, framesToSequence, ThumbnailAiSourceMissing } from './aiRender';
import { ThumbnailRenderInputs } from './renderInputs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// ThumbnailRenderInputs は realpathSync で場所を引くため、実在する一時フォルダを使う（'/p' のような架空の場所は ENOENT になる）。
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'ai-render-')); dirs.push(dir); return dir; };

describe('fitLongSide', () => {
  it('長辺を合わせ、偶数に丸める', () => {
    expect(fitLongSide({ width: 1920, height: 1080 }, 640)).toEqual({ width: 640, height: 360 });
    expect(fitLongSide({ width: 1080, height: 1920 }, 1280)).toEqual({ width: 720, height: 1280 });
    expect(fitLongSide({ width: 1001, height: 999 }, 640)).toEqual({ width: 640, height: 638 });
  });
});
describe('framesToSequence', () => {
  it('コマ 1 つにつき 1 フレームの映像を並べ、元の秒から始める', () => {
    const stream = VIDEO_ASSET.streams.find(item => item.kind === 'video')!;
    const sequence = framesToSequence(VIDEO_ASSET, stream.index, [{ num: 1, den: 2 }, { num: 3, den: 2 }], { width: 640, height: 360 });
    expect(sequence.sequenceEndFrame).toBe(2);
    expect(sequence.clips.map(clip => [clip.startFrame, clip.durationFrames])).toEqual([[0, 1], [1, 1]]);
    expect(sequence.clips[1]!.content).toMatchObject({ kind: 'video', assetId: VIDEO_ASSET.id, sourceIn: { num: 3, den: 2 }, endBehavior: 'hold' });
    expect(sequence.assets).toEqual([VIDEO_ASSET]);
  });
});
describe('createThumbnailAiRender', () => {
  it('page は案の大きさの描画面で撮り、長辺 1280 に縮める。終わったら入力の登録を外す', async () => {
    const inputs = new ThumbnailRenderInputs(), capture = vi.fn<ThumbnailFramesCapture>(async () => [Buffer.from('png')]), directory = tempDir();
    const render = createThumbnailAiRender({ inputs, capture, verify: async () => '/x' }), document = thumbnailFixture();
    const result = await render.page({ directory, projectId: 'p', origin: 'http://127.0.0.1:1', document, pageId: document.pages[0]!.id, longSide: 1280, signal: new AbortController().signal });
    expect(result).toEqual({ bytes: Buffer.from('png'), width: 1280, height: 720 });
    expect(capture.mock.calls[0]![0].resolution).toEqual({ width: 1280, height: 720 });
    expect(capture.mock.calls[0]![2]).toMatchObject({ format: 'png', scale: 1 });
    // get は未登録だと 404 を投げる（撮影の後に登録が外れている）。
    expect(() => inputs.get(directory, capture.mock.calls[0]![0].jobId)).toThrow('描画する入力が見つかりません');
  });
  it('page は撮影の間は入力が登録されている', async () => {
    const inputs = new ThumbnailRenderInputs(), directory = tempDir(), document = thumbnailFixture();
    const capture = vi.fn<ThumbnailFramesCapture>(async target => { expect(inputs.get(directory, target.jobId).clips.length).toBe(document.pages[0]!.layers.length); return [Buffer.from('png')]; });
    const render = createThumbnailAiRender({ inputs, capture, verify: async () => '/x' });
    await render.page({ directory, projectId: 'p', origin: 'o', document, pageId: document.pages[0]!.id, longSide: 640, signal: new AbortController().signal });
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('元の素材の確かめに失敗したら ThumbnailAiSourceMissing で、撮らない', async () => {
    const capture = vi.fn<ThumbnailFramesCapture>(async () => [Buffer.from('x')]), render = createThumbnailAiRender({ capture, verify: async () => { throw new Error('missing'); } });
    await expect(render.frames({ directory: '/p', projectId: 'p', origin: 'o', asset: VIDEO_ASSET, streamIndex: 0, times: [{ num: 0, den: 1 }], longSide: 640, signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(ThumbnailAiSourceMissing);
    expect(capture).not.toHaveBeenCalled();
  });
});
