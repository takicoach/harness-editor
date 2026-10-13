import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';
import { importSequenceAsset } from '../src/server/sequence/assets';
import { SequenceStore } from '../src/server/sequence/store';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailState } from './thumbnailHelpers';

test('素材: 図形を足し、案件の画像を置き、動画のコマを選んで背景にする', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-materials'), ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  const clip = join(project.dir, 'clip.mp4'), logo = join(project.dir, 'logo.png');
  execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', logo]);
  const video = await importSequenceAsset(project.dir, clip, 'clip.mp4'), image = await importSequenceAsset(project.dir, logo, 'logo.png');
  // 動画側の文書に素材として載せる（引き出しは動画の素材一覧を見る）。
  const store = new SequenceStore(project.dir), saved = store.load()!;
  store.save({ document: { ...saved.document, revision: saved.document.revision + 1, assets: [video, image] }, executionId: 'materials', expectedSavedRevision: saved.savedRevision });
  const layers = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers;
  try {
    await openThumbnailMode(page, project.id);
    await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: '素材' }).click();
    const drawer = page.getByRole('complementary', { name: '素材' });
    await drawer.getByRole('button', { name: '丸を足す' }).click();
    await expect.poll(async () => (await layers()).map(layer => layer.content.kind === 'shape' ? layer.content.shape.kind : layer.content.kind)).toEqual(['ellipse']);
    await drawer.getByRole('button', { name: 'logo.pngを素材として置く' }).click();
    await expect.poll(async () => (await layers()).at(-1)?.content).toEqual({ kind: 'image', assetId: image.id, role: 'element' });
    await drawer.getByRole('button', { name: 'clip.mp4のコマを選ぶ' }).click();
    for (let step = 0; step < 5; step++) await drawer.getByRole('button', { name: '次のコマ' }).click();
    await expect(drawer.getByLabel('選んでいるコマの時刻')).toHaveText('0:00.05');
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b14-frame-picker.png') });
    await drawer.getByRole('button', { name: 'このコマを背景にする' }).click();
    const streamIndex = video.streams.find(item => item.kind === 'video')!.index;
    await expect.poll(async () => (await layers())[0]?.content).toEqual({ kind: 'video-frame', assetId: video.id, streamIndex, fingerprint: video.fingerprint, sourceTime: { num: 11, den: 20 } });
    const frameId = (await layers())[0]!.id;
    await expect(page.frameLocator('.native-thumbnail iframe[data-native-preview]').locator(`[data-native-clip="${frameId}"] canvas`)).toBeAttached();
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
