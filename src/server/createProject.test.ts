import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProbeOutput, precheckCreateProject, sanitizeProjectName } from './createProject';

describe('sanitizeProjectName', () => {
  it('前後空白を除去し NFC 正規化する', () => {
    expect(sanitizeProjectName(' 2026-07-10-ゴルフ '.normalize('NFD'))).toBe('2026-07-10-ゴルフ');
  });
  it.each(['', 'a/b', 'a\\b', '..', '.hidden', 'x'.repeat(81)])('不正名 %j は 400', (name) => {
    expect(() => sanitizeProjectName(name)).toThrowError(/プロジェクト名/);
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

describe('precheckCreateProject', () => {
  it('不正名・非動画拡張子・重複を受信前に弾き、正常入力は通す', () => {
    const root = mkdtempSync(join(tmpdir(), 'sme-create-'));
    try {
      expect(() => precheckCreateProject(root, 'a/b', 'a.mp4')).toThrowError(/プロジェクト名/);
      expect(() => precheckCreateProject(root, 'ok', 'a.txt')).toThrowError(/動画・音声・画像のファイルを選んでください/);
      mkdirSync(join(root, 'dup2'));
      expect(() => precheckCreateProject(root, 'dup2', 'a.mp4')).toThrowError(/すでにあります/);
      expect(() => precheckCreateProject(root, 'fresh', 'a.mp4')).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
