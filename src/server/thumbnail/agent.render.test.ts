import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import type { ThumbnailDocument } from '../../core/thumbnail/model';
import { VIDEO_ASSET } from '../../core/thumbnail/fixtures';
import { SequenceStore } from '../sequence/store';
import { ThumbnailAiRequestStore } from './aiRequests';
import { NEW_PAGE } from './aiCommand';
import { ThumbnailAgent } from './agent';
import { ThumbnailAiSourceMissing } from './aiRender';
import { ThumbnailService } from './service';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
/** 字幕は音声のストリームにしか付けられない（validate.ts の文字起こしの検査）ので、見本の動画に音声を足す。 */
const AV_ASSET: SequenceAsset = { ...VIDEO_ASSET, streams: [...VIDEO_ASSET.streams, { index: 1, kind: 'audio', codec: 'aac', duration: { num: 3, den: 1 }, sampleRate: 48000, channels: 2 }] };
const fakeRender = {
  page: vi.fn(async ({ document }: { document: ThumbnailDocument }) => ({ bytes: Buffer.from(`png-${document.revision}`), width: 1280, height: 720 })),
  frames: vi.fn(async ({ times }: { times: readonly unknown[] }) => ({ images: times.map((_t, i) => Buffer.from(`jpg-${i}`)), width: 640, height: 360 })),
};
function setup() {
  root = mkdtempSync(join(tmpdir(), 'thumb-agent-render-'));
  const service = new ThumbnailService(), agent = new ThumbnailAgent({ root: () => root, service, render: fakeRender });
  const make = (projectId: string) => {
    const directory = join(root, projectId); mkdirSync(directory);
    const video: SequenceDocument = { schemaVersion: 2, id: projectId, name: projectId, revision: 0, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30,
      background: '#000000', assets: [AV_ASSET], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
    new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'v', document: video });
    service.create(directory, `c-${projectId}`);
    return directory;
  };
  return { service, agent, make };
}
const textOp = (id: string) => ({ type: 'add-layer', pageId: NEW_PAGE, layer: { id, content: { kind: 'text', text: '飛ぶ' } } });

describe('ThumbnailAgent の frames と preview', () => {
  it('frames: 秒の指定でコマ ID・場所・元の秒を返し、依頼の記録に残す。秒はそのフレームの中央に丸める', async () => {
    const { agent, make } = setup(), a = make('a'), { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    const result = await agent.frames({ projectId: 'a', requestId, assetId: VIDEO_ASSET.id, seconds: [1, 2.5] }, 'http://127.0.0.1:1');
    expect(result.frames.map(frame => frame.frameId)).toEqual(['f1', 'f2']);
    expect(readFileSync(result.frames[0]!.path, 'utf8')).toBe('jpg-0');
    expect(result.frames[0]!.path.startsWith(join(realpathSync(a), '.harness', 'cache', 'thumbnail-ai'))).toBe(true);
    const fps = VIDEO_ASSET.streams.find(s => s.kind === 'video')!.frameRate ?? { num: 30, den: 1 };
    expect(result.frames[0]!.seconds).toBeCloseTo((Math.floor(1 * fps.num / fps.den) + 0.5) * fps.den / fps.num, 6);
    expect(new ThumbnailAiRequestStore(a).get(requestId)!.frames).toHaveLength(2);
  });
  it('frames: 区間を等間隔で撮れる。13 枚以上・使えない動画は断る', async () => {
    const { agent, make } = setup(); make('a');
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    expect((await agent.frames({ projectId: 'a', requestId, assetId: VIDEO_ASSET.id, range: { start: 0, end: 1, count: 3 } }, 'o')).frames).toHaveLength(3);
    await expect(agent.frames({ projectId: 'a', requestId, assetId: VIDEO_ASSET.id, seconds: Array.from({ length: 13 }, (_v, i) => i / 10) }, 'o')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(agent.frames({ projectId: 'a', requestId, assetId: 'nope', seconds: [0] }, 'o')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('frames: 元の動画が無い時は SOURCE_MISSING（元の動画が見つかりません）', async () => {
    fakeRender.frames.mockRejectedValueOnce(new ThumbnailAiSourceMissing(VIDEO_ASSET.id));
    const { agent, make } = setup(); make('a');
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    await expect(agent.frames({ projectId: 'a', requestId, assetId: VIDEO_ASSET.id, seconds: [0] }, 'o')).rejects.toMatchObject({ code: 'SOURCE_MISSING', message: expect.stringContaining('元の動画が見つかりません') });
  });
  it('preview: 文書も版も変えずに PNG を作り、作業の段階を「仕上がりを確認中」にする。範囲外の操作は同じく断る', async () => {
    const { agent, service, make } = setup(), a = make('a'), before = service.open(a);
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    const result = await agent.preview({ projectId: 'a', requestId, ops: [textOp('t1')] }, 'o');
    expect(result).toMatchObject({ width: 1280, height: 720, pageId: NEW_PAGE, revision: before.document.revision, previewsLeft: 4 });
    expect(existsSync(result.path)).toBe(true);
    const after = service.open(a);
    expect([after.document.revision, after.savedContentHash, after.dirty]).toEqual([before.document.revision, before.savedContentHash, before.dirty]);
    expect(new ThumbnailAiRequestStore(a).get(requestId)!.phase).toBe('reviewing');
    await expect(agent.preview({ projectId: 'a', requestId, ops: [{ type: 'delete-page', pageId: before.document.pages[0]!.id }] }, 'o')).rejects.toMatchObject({ code: 'OUT_OF_REQUEST' });
  });
  it('preview: 1 つの依頼で 5 回まで。6 回目は PREVIEW_LIMIT', async () => {
    const { agent, make } = setup(); make('a');
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    for (let i = 0; i < 5; i += 1) await agent.preview({ projectId: 'a', requestId, ops: [textOp('t1')] }, 'o');
    await expect(agent.preview({ projectId: 'a', requestId, ops: [textOp('t1')] }, 'o')).rejects.toMatchObject({ code: 'PREVIEW_LIMIT' });
  });
});
