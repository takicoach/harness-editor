import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { textLayer } from '../src/core/thumbnail/fixtures';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';
import { importSequenceAsset } from '../src/server/sequence/assets';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

test('キャンバスは原本の経路で描き、元の動画が無いコマには「元の動画が見つかりません」を出す', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-canvas'), ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  const source = join(project.dir, 'clip.mp4');
  execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const video = await importSequenceAsset(project.dir, source, 'clip.mp4'), stream = video.streams.find(item => item.kind === 'video')!;
  try {
    await openThumbnailMode(page, project.id);
    const state = await thumbnailState(request, project.id), pageId = state.document.pages[0]!.id;
    const registered = await request.post(`/api/thumbnail/register?id=${project.id}`, { data: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), assetIds: [video.id] } });
    expect(registered.ok(), await registered.text()).toBe(true);
    await thumbnailCommand(request, project.id, { type: 'batch', commands: [
      { type: 'add-layer', pageId, layer: { id: 'frame', name: 'コマ', hidden: false, locked: false, visual: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1 },
        content: { kind: 'video-frame', assetId: video.id, streamIndex: stream.index, fingerprint: video.fingerprint, sourceTime: { num: 1, den: 20 } } } },
      { type: 'add-layer', pageId, layer: textLayer('title', 'キャンバス') }] });
    const frame = page.frameLocator('.native-thumbnail iframe[data-native-preview]');
    await expect(page.locator('.native-thumbnail iframe[data-native-preview]')).toHaveAttribute('src', /thumbnail=1/);
    await expect(frame.locator('[data-native-clip="title"]')).toBeAttached({ timeout: 30_000 });
    await expect(frame.locator('[data-native-clip="frame"] canvas')).toBeAttached({ timeout: 30_000 });
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b7-canvas.png') });
    rmSync(join(project.dir, video.file));
    await page.reload();
    await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect(page.getByText('元の動画が見つかりません')).toBeVisible();
    await expect(frame.locator('[data-native-clip="title"]')).toBeAttached({ timeout: 30_000 });
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
