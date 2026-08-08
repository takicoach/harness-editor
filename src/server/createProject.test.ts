import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProject,
  defaultTemplateDir,
  detectFormat,
  parseProbeOutput,
  precheckCreateProject,
  rewriteVideoConfig,
  sanitizeProjectName,
} from './createProject';

const PROBED = { fps: 59.94, durationSeconds: 10, width: 1920, height: 1080 };

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sme-create-'));
}

/** アップロード受信済みの一時ファイルを模す（createProject はここから移動する）。 */
let tmpSeq = 0;
function makeTmpVideo(root: string, content = 'x'): string {
  const path = join(root, `upload-${tmpSeq++}.tmp`);
  writeFileSync(path, content);
  return path;
}

describe('sanitizeProjectName', () => {
  it('前後空白を除去し NFC 正規化する', () => {
    expect(sanitizeProjectName(' 2026-07-10-ゴルフ '.normalize('NFD'))).toBe('2026-07-10-ゴルフ');
  });
  it.each(['', 'a/b', 'a\\b', '..', '.hidden', 'x'.repeat(81)])('不正名 %j は 400', (name) => {
    expect(() => sanitizeProjectName(name)).toThrowError(/プロジェクト名/);
  });
});

describe('detectFormat', () => {
  it('横長は youtube、縦長は short、それ以外は square', () => {
    expect(detectFormat(1920, 1080)).toBe('youtube');
    expect(detectFormat(1080, 1920)).toBe('short');
    expect(detectFormat(1080, 1080)).toBe('square');
  });
});

describe('parseProbeOutput', () => {
  it('分数 fps と format 側 duration を解決する', () => {
    const json = JSON.stringify({
      streams: [{ width: 1080, height: 1920, r_frame_rate: '60000/1001' }],
      format: { duration: '12.5' },
    });
    const v = parseProbeOutput(json);
    expect(v.fps).toBeCloseTo(59.94, 2);
    expect(v.durationSeconds).toBe(12.5);
    expect(v.width).toBe(1080);
  });
  it('映像ストリームが無ければ 422', () => {
    expect(() => parseProbeOutput(JSON.stringify({ streams: [] }))).toThrowError(/読み込めません/);
  });
  it('JSON でなければ 422', () => {
    expect(() => parseProbeOutput('not json')).toThrowError(/解析に失敗/);
  });
});

describe('rewriteVideoConfig', () => {
  const src = readFileSync(join(defaultTemplateDir(), 'src', 'videoConfig.ts'), 'utf8');
  it('マーカー領域の4値を書き換える', () => {
    const out = rewriteVideoConfig(src, { format: 'short', fps: 59.94, durationFrames: 749, videoFile: 'main.mov' });
    expect(out).toContain("export const FORMAT: VideoFormat = 'short';");
    expect(out).toContain('export const FPS = 59.94;');
    expect(out).toContain('export const DURATION_FRAMES = 749;');
    expect(out).toContain("export const VIDEO_FILE = 'main.mov';");
  });
  it('マーカーが無ければ 500', () => {
    expect(() => rewriteVideoConfig('// empty', { format: 'youtube', fps: 30, durationFrames: 1, videoFile: 'main.mp4' })).toThrowError(/テンプレート/);
  });
});

describe('precheckCreateProject', () => {
  it('不正名・非動画拡張子・重複を受信前に弾き、正常入力は通す', () => {
    const root = makeRoot();
    try {
      expect(() => precheckCreateProject(root, 'a/b', 'a.mp4')).toThrowError(/プロジェクト名/);
      expect(() => precheckCreateProject(root, 'ok', 'a.txt')).toThrowError(/動画ファイル/);
      createProject(root, { name: 'dup2', videoName: 'a.mp4', videoTmpPath: makeTmpVideo(root) }, { probe: () => PROBED });
      expect(() => precheckCreateProject(root, 'dup2', 'a.mp4')).toThrowError(/すでにあります/);
      expect(() => precheckCreateProject(root, 'fresh', 'a.mp4')).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createProject', () => {
  it('テンプレコピー・動画配置・videoConfig 反映まで行い id を返す', () => {
    const root = makeRoot();
    try {
      const tmp = makeTmpVideo(root, 'movie-bytes');
      const { id } = createProject(
        root,
        { name: 'テスト動画', videoName: 'DJI_0001.MP4', videoTmpPath: tmp },
        { probe: () => PROBED },
      );
      expect(id).toBe('テスト動画');
      const dir = join(root, id);
      expect(readFileSync(join(dir, 'public', 'main.mp4'), 'utf8')).toBe('movie-bytes');
      // 一時ファイルは移動されて残らない
      expect(existsSync(tmp)).toBe(false);
      const vc = readFileSync(join(dir, 'src', 'videoConfig.ts'), 'utf8');
      expect(vc).toContain("FORMAT: VideoFormat = 'youtube'");
      expect(vc).toContain(`DURATION_FRAMES = ${Math.round(10 * 59.94)}`);
      expect(existsSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'))).toBe(true);
      const transcript = JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')) as { words: unknown[]; duration_ms: number };
      expect(transcript.words).toEqual([]);
      expect(transcript.duration_ms).toBe(10000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('同名フォルダがあれば 409', () => {
    const root = makeRoot();
    try {
      const opts = { probe: () => PROBED };
      createProject(root, { name: 'dup', videoName: 'a.mp4', videoTmpPath: makeTmpVideo(root) }, opts);
      expect(() =>
        createProject(root, { name: 'dup', videoName: 'a.mp4', videoTmpPath: makeTmpVideo(root) }, opts),
      ).toThrowError(/すでにあります/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('probe 失敗時は作りかけフォルダを削除してロールバックする', () => {
    const root = makeRoot();
    try {
      expect(() =>
        createProject(
          root,
          { name: 'broken', videoName: 'a.mp4', videoTmpPath: makeTmpVideo(root) },
          { probe: () => { throw new Error('boom'); } },
        ),
      ).toThrowError('boom');
      expect(existsSync(join(root, 'broken'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('動画以外の拡張子は 400', () => {
    const root = makeRoot();
    try {
      expect(() =>
        createProject(
          root,
          { name: 'x', videoName: 'a.txt', videoTmpPath: makeTmpVideo(root) },
          { probe: () => PROBED },
        ),
      ).toThrowError(/動画ファイル/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
