import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFastCut } from './fastCutPlan';

/** テロップ等が空の最小プロジェクトを作る（cuts=残す区間の指定）。 */
function makeProject(opts: { telops?: boolean; cuts?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-fastcut-')));
  mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'videoConfig.ts'),
    [
      "export type VideoFormat = 'youtube' | 'short' | 'square';",
      "export const FORMAT: VideoFormat = 'youtube';",
      'export const FPS = 30;',
      'export const DURATION_FRAMES = 300;',
      "export const VIDEO_FILE = 'main.mp4';",
      'const RESOLUTION_MAP = {',
      '  youtube: { width: 3840, height: 2160 },',
      '  short: { width: 1080, height: 1920 },',
      '  square: { width: 1080, height: 1080 },',
      '} as const;',
      'export const RESOLUTION = RESOLUTION_MAP[FORMAT];',
    ].join('\n'),
  );
  const telops = opts.telops === true
    ? '[{ id: 1, startFrame: 0, endFrame: 30, text: "あ", template: 1 }]'
    : '[]';
  writeFileSync(
    join(dir, 'src', 'テロップテンプレート', 'telopData.ts'),
    [
      'export const FPS = 30;',
      'export const TOTAL_FRAMES = 300;',
      `export const telopData = ${telops};`,
    ].join('\n'),
  );
  if (opts.cuts !== false) {
    writeFileSync(
      join(dir, 'src', 'cutData.ts'),
      'export const cutData = [\n' +
        '  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },\n' +
        '  { id: 2, originalStart: 200, originalEnd: 300, playbackStart: 100, playbackEnd: 200 },\n' +
        '];\n',
    );
  }
  writeFileSync(
    join(dir, 'transcript.json'),
    JSON.stringify({ engine: 'none', language: 'ja', duration_ms: 10000, words: [], segments: [] }),
  );
  return dir;
}

describe('planFastCut', () => {
  it('カットだけのプロジェクトは ffmpeg 引数とフィルタスクリプトを組み立てる', () => {
    const dir = makeProject();
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
      });
      expect(plan).not.toBeNull();
      // 残すのは [0,100) と [200,300)＝200 フレーム。
      expect(plan?.totalFrames).toBe(200);
      expect(plan?.target).toEqual({ width: 3840, height: 2160 });
      expect(plan?.args.join(' ')).toContain(join(dir, 'public', 'main.mp4'));
      expect(written).not.toBeNull();
      const w = written as unknown as { path: string; data: string };
      expect(w.path).toBe(join(dir, 'out', 'cut-filter.txt'));
      expect(w.data).toContain('concat=n=2:v=1:a=1[outv][outa]');
      // 等倍なのでスケールフィルタは入らない。
      expect(w.data).not.toContain('scale=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1080p を選ぶと concat の後段に縮小を 1 回だけ挟む', () => {
    const dir = makeProject();
    try {
      let data = '';
      planFastCut(dir, { resolution: '1080p', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_p, d) => { data = d; },
      });
      expect(data).toContain('[catv]scale=1920:1080:flags=lanczos[outv]');
      expect(data.match(/scale=/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('テロップが 1 つでもあれば null（通常の書き出し経路へ戻す）', () => {
    const dir = makeProject({ telops: true });
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('読み取れないプロジェクトは null（黙って通常経路へ）', () => {
    expect(planFastCut('/does/not/exist', { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
      hardware: true,
      writeFile: () => { /* 呼ばれない */ },
    })).toBeNull();
  });
});
