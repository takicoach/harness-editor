import { describe, it, expect } from 'vitest';
import { assetPathFor, assetUrl, buildMaterialRows, MATERIAL_KINDS, thumbSeekTime } from './materialList';

describe('assetPathFor', () => {
  it('種別ごとに prefix を付ける（video は prefix なし）', () => {
    expect(assetPathFor('se', 'beep.mp3')).toBe('se/beep.mp3');
    expect(assetPathFor('image', 'a.png')).toBe('images/a.png');
    expect(assetPathFor('bgm', 'x.mp3')).toBe('BGM/x.mp3');
    expect(assetPathFor('video', 'sub/cam2.mp4')).toBe('sub/cam2.mp4');
  });
});

describe('assetUrl', () => {
  it('projectId と path を URL エンコードして /api/asset を組む', () => {
    expect(assetUrl('p 1', 'se/a b.mp3')).toBe('/api/asset?id=p%201&path=se%2Fa%20b.mp3');
  });
  it('versions に assetPath のトークンがあれば &v= を付ける（同名差し替えのキャッシュバスト）', () => {
    expect(assetUrl('p1', 'BGM/x.mp3', { 'BGM/x.mp3': '10-20' })).toBe(
      '/api/asset?id=p1&path=BGM%2Fx.mp3&v=10-20',
    );
  });
  it('versions にトークンが無ければ従来 URL のまま', () => {
    expect(assetUrl('p1', 'BGM/x.mp3', {})).toBe('/api/asset?id=p1&path=BGM%2Fx.mp3');
    expect(assetUrl('p1', 'BGM/x.mp3', undefined)).toBe('/api/asset?id=p1&path=BGM%2Fx.mp3');
  });
});

describe('buildMaterialRows', () => {
  it('ライブラリ各ファイルを file+assetPath の行にする', () => {
    expect(buildMaterialRows('bgm', ['x.mp3', 'y.mp3'])).toEqual([
      { file: 'x.mp3', assetPath: 'BGM/x.mp3' },
      { file: 'y.mp3', assetPath: 'BGM/y.mp3' },
    ]);
  });
  it('空ライブラリは空配列', () => {
    expect(buildMaterialRows('se', [])).toEqual([]);
  });
});

describe('MATERIAL_KINDS', () => {
  it('4種を se,image,bgm,video の順で持つ', () => {
    expect(MATERIAL_KINDS.map((m) => m.kind)).toEqual(['se', 'image', 'bgm', 'video']);
  });
});

describe('thumbSeekTime', () => {
  it('長尺は 0.5 秒で代表フレームを選ぶ', () => {
    expect(thumbSeekTime(10)).toBe(0.5);
  });
  it('短尺は中央を選ぶ', () => {
    expect(thumbSeekTime(0.4)).toBeCloseTo(0.2);
    expect(thumbSeekTime(1)).toBe(0.5);
  });
  it('0・負・NaN は 0 を返す', () => {
    expect(thumbSeekTime(0)).toBe(0);
    expect(thumbSeekTime(-3)).toBe(0);
    expect(thumbSeekTime(Number.NaN)).toBe(0);
  });
});
