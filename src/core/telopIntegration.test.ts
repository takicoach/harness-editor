import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProject, serializeProject, type ProjectFiles } from './project';
import { VIDEO_CONFIG_SOURCE } from './__fixtures__/videoConfig.fixture';
import { TELOP_DATA_SOURCE } from './__fixtures__/telopData.fixture';
import { CUT_DATA_SOURCE } from './__fixtures__/cutData.fixture';
import { activeTelopsAt } from '../preview/playbackModel';
import type { TelopSegment } from './types';

const TRANSCRIPT = readFileSync(
  new URL('./__fixtures__/transcript.fixture.json', import.meta.url),
  'utf8',
);

const FILES: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_SOURCE,
  telopDataSource: TELOP_DATA_SOURCE,
  cutDataSource: CUT_DATA_SOURCE,
  transcriptJson: TRANSCRIPT,
  projectConfigJson: null,
  seDataSource: null,
  insertImageDataSource: null,
  titleDataSource: null,
};

describe('telop 統合（loadProject → serialize → 再 loadProject の round-trip）', () => {
  it('テロップ件数・本文が再読込後も保持される', () => {
    const project = loadProject(FILES);
    expect(project.telops).toHaveLength(2);

    const serialized = serializeProject(project);
    const reloaded = loadProject({ ...FILES, telopDataSource: serialized.telopDataSource, cutDataSource: serialized.cutDataSource });

    expect(reloaded.telops).toHaveLength(project.telops.length);
    expect(reloaded.telops.map((t) => t.text)).toEqual(project.telops.map((t) => t.text));
    expect(reloaded.telops.map((t) => t.originalStart)).toEqual(project.telops.map((t) => t.originalStart));
    expect(reloaded.telops.map((t) => t.originalEnd)).toEqual(project.telops.map((t) => t.originalEnd));
  });
});

describe('activeTelopsAt（R-10: 全件描画の回帰網）', () => {
  it('長尺装飾テロップは字幕テロップと重なる区間でも両方 active になる', () => {
    const telops: TelopSegment[] = [
      {
        id: 1,
        startFrame: 0,
        endFrame: 900,
        text: '長尺の装飾テロップ',
        style: 'emphasis',
        template: 1,
        animation: 'fadeOnly',
        highlight: '',
        manual: true,
      },
      {
        id: 2,
        startFrame: 100,
        endFrame: 200,
        text: '字幕テロップ',
        style: 'normal',
        template: 2,
        animation: 'fadeOnly',
        highlight: '',
      },
    ];

    const active = activeTelopsAt(telops, 150);
    expect(active.map((t) => t.id)).toEqual([1, 2]);
  });

  it('重ならない区間では該当テロップのみ active になる', () => {
    const telops: TelopSegment[] = [
      {
        id: 1,
        startFrame: 0,
        endFrame: 900,
        text: '長尺の装飾テロップ',
        style: 'emphasis',
        template: 1,
        animation: 'fadeOnly',
        highlight: '',
        manual: true,
      },
      {
        id: 2,
        startFrame: 950,
        endFrame: 1000,
        text: '字幕テロップ',
        style: 'normal',
        template: 2,
        animation: 'fadeOnly',
        highlight: '',
      },
    ];

    expect(activeTelopsAt(telops, 150).map((t) => t.id)).toEqual([1]);
    expect(activeTelopsAt(telops, 970).map((t) => t.id)).toEqual([2]);
  });
});
