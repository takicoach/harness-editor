import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenePlan } from '../../core/sequence/scenePlan';
import type { SequenceAsset } from '../../core/sequence/model';
import type { NativeExportStatus } from '../../shared/nativeExport';
import { buildAudioDocument } from './createDocuments';
import { assertExportFreeSpace, EXPORT_SPACE_MARGIN_BYTES, exportFreeSpaceRequirement } from './exportSpace';
import { runSequenceExport } from './exportRunner';

vi.mock('./exportSpace', async (load) => {
  const actual = await load<typeof import('./exportSpace')>();
  return { ...actual, assertExportFreeSpace: vi.fn(actual.assertExportFreeSpace) };
});
vi.mock('../resolveNativeChromium', () => ({ resolveNativeChromiumBin: () => ({ ok: true, bin: '/unused-chromium' }) }));
const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({ chromium: { launch } }));

const hour: SequenceAsset = { id: 'media-hour', kind: 'media', name: 'hour.mp3', file: '.harness/assets/h.mp3', fingerprint: 'a'.repeat(64),
  streams: [{ index: 0, kind: 'audio', codec: 'mp3', duration: { num: 3600, den: 1 }, sampleRate: 44100, channels: 1 }] };
const PCM_HOUR = 3600 * 48000 * 8;

describe('書き出し前の空き容量（設計 M7b）', () => {
  it('60分の音声作品: 混合後の一時音声 ＋ 元音声の PCM ＋ 余白（およそ 3.1GB）', () => {
    const plan = new ScenePlan(buildAudioDocument('hour', hour));
    expect(plan.document.sequenceEndFrame).toBe(108_000);
    expect(exportFreeSpaceRequirement(plan)).toBe(PCM_HOUR * 2 + EXPORT_SPACE_MARGIN_BYTES);
    expect(exportFreeSpaceRequirement(plan) / 1024 ** 3).toBeCloseTo(3.07, 2);
  });
  it('消音したクリップの元音声は数えない', () => {
    const doc = buildAudioDocument('hour', hour);
    const clip = doc.clips[0]!;
    if (clip.content.kind === 'audio') clip.content.settings.muted = true;
    expect(exportFreeSpaceRequirement(new ScenePlan(doc))).toBe(PCM_HOUR + EXPORT_SPACE_MARGIN_BYTES);
  });
  it('空きが足りなければ理由（必要・空き）を出して止め、足りれば見積もりを返す', async () => {
    const plan = new ScenePlan(buildAudioDocument('hour', hour));
    await expect(assertExportFreeSpace('/any', plan, async () => ({ bavail: 1024 ** 2, bsize: 1024 })))
      .rejects.toThrow('書き出しに必要な空き容量が足りません（必要: 約 3.1 GB・空き: 1.0 GB）');
    await expect(assertExportFreeSpace('/any', plan, async () => ({ bavail: 8 * 1024 ** 2, bsize: 1024 }))).resolves.toBe(exportFreeSpaceRequirement(plan));
  });
  it('書き出しの本体は、音声の準備や描画を始める前に確かめる', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'export-space-'));
    try {
      vi.mocked(assertExportFreeSpace).mockRejectedValueOnce(new Error('書き出しに必要な空き容量が足りません（テスト）'));
      const status: NativeExportStatus = { id: 'job', projectId: 'hour', revision: 0, contentHash: 'x', executionId: null, phase: 'queued', completedFrames: 0, totalFrames: 108_000, createdAt: new Date().toISOString() };
      await expect(runSequenceExport({ plan: new ScenePlan(buildAudioDocument('hour', hour)), projectDirectory: directory, directory, origin: 'http://fixture.invalid', status, signal: new AbortController().signal }))
        .rejects.toThrow('空き容量が足りません');
      expect(assertExportFreeSpace).toHaveBeenCalledWith(directory, expect.any(ScenePlan));
      expect(status.phase).toBe('preparing');
      expect(launch).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
