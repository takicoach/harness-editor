// src/server/renderProgress.test.ts
import { describe, it, expect } from 'vitest';
import { parseRenderProgress } from './renderProgress';

describe('parseRenderProgress', () => {
  it('Rendered N/M 行から進捗を抽出する', () => {
    expect(parseRenderProgress('Rendered 123/456')).toEqual({ frames: 123, total: 456, percent: 27 });
  });
  it('CR 上書き・ANSI エスケープ混入チャンクでも最後の進捗を返す', () => {
    const chunk = 'Rendered 10/456\r\x1b[32mRendered 20/456\x1b[0m\r';
    expect(parseRenderProgress(chunk)).toEqual({ frames: 20, total: 456, percent: 4 });
  });
  it('進捗行が無いチャンクは null（スピナー表示にフォールバック）', () => {
    expect(parseRenderProgress('Bundling code...')).toBeNull();
    expect(parseRenderProgress('')).toBeNull();
  });
  it('total=0 は null（ゼロ除算防止）', () => {
    expect(parseRenderProgress('Rendered 0/0')).toBeNull();
  });
  it('100% を超えない', () => {
    expect(parseRenderProgress('Rendered 456/456')!.percent).toBe(100);
  });
});
