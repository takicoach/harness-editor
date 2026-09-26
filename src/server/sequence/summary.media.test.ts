import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSequenceImageProject, createSequenceProject } from './create';
import { SequenceStore } from './store';
import { scanProjects } from '../scanProjects';
import { makeMediaSamples, type MediaSamples } from './__fixtures__/mediaSamples';

let samples: MediaSamples, root: string;
beforeAll(async () => {
  samples = makeMediaSamples(await mkdtemp(join(tmpdir(), 'summary-media-samples-')));
  root = await mkdtemp(join(await realpath(tmpdir()), 'summary-media-root-'));
}, 30_000);
afterAll(async () => { await rm(samples.dir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });

it('ホームのカード: 画像の作品は先頭の画像、音声の作品は「音声」の印（設計 M6c）', async () => {
  await createSequenceProject(root, { name: 'audio', videoName: 'talk.wav', sourcePath: samples.wav });
  await createSequenceImageProject(root, { name: 'images', images: [{ name: 'g.png', sourcePath: samples.green }, { name: 'r.png', sourcePath: samples.red }] });
  const images = new SequenceStore(join(root, 'images')).load()!.document;
  const byId = new Map(scanProjects(root).map((item) => [item.id, item]));
  expect(byId.get('audio')).toMatchObject({ audioOnly: true, durationLabel: '0:02' });
  expect(byId.get('audio')!.videoAssetId).toBeUndefined(); expect(byId.get('audio')!.imageAssetId).toBeUndefined();
  expect(byId.get('images')!.imageAssetId).toBe(images.assets.find((asset) => asset.name === 'g.png')!.id);
  expect(byId.get('images')!.audioOnly).toBeUndefined();
});
