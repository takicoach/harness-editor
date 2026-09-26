import { describe, it, expect } from 'vitest';
import {
  parseMainLayoutData,
  parseSegmentLayoutsData,
  serializeMainLayoutData,
  parseMainLayoutFile,
  parseLayoutKeyframesData,
} from './mainLayoutData';
import { DEFAULT_MAIN_LAYOUT } from './mainLayout';
import { DEFAULT_COLOR_GRADE } from './colorGrade';

describe('serializeMainLayoutData', () => {
  it('完全既定（全画面・黒）は null（ファイル不要）', () => {
    expect(serializeMainLayoutData(DEFAULT_MAIN_LAYOUT)).toBeNull();
  });
  it('背景だけ既定でないならファイルを残す（縮小時に見えるため）', () => {
    const s = serializeMainLayoutData({ ...DEFAULT_MAIN_LAYOUT, background: '#ffffff' });
    expect(s).not.toBeNull();
    expect(s).toContain('MAIN_LAYOUT');
    expect(s).toContain('#ffffff');
  });
  it('非恒等は MAIN_LAYOUT を出力', () => {
    const s = serializeMainLayoutData({
      position: { x: 0.5, y: -0.25 },
      scale: 1.4,
      background: '#000000',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
    expect(s).toContain('MAIN_LAYOUT');
    expect(s).toContain('1.4');
  });
});

describe('parseMainLayoutData', () => {
  it('null は既定', () => {
    expect(parseMainLayoutData(null)).toEqual(DEFAULT_MAIN_LAYOUT);
  });
  it('壊れたソースは既定へフォールバック', () => {
    expect(parseMainLayoutData('export const NOPE =;')).toEqual(DEFAULT_MAIN_LAYOUT);
  });
  it('serialize→parse で往復保持（クランプ込み）', () => {
    const layout = {
      position: { x: 0.5, y: -0.25 },
      scale: 1.4,
      background: '#112233',
      rotation: 0,
      flipH: false,
      flipV: false,
    };
    const src = serializeMainLayoutData(layout);
    expect(src).not.toBeNull();
    expect(parseMainLayoutData(src)).toEqual(layout);
  });
  it('範囲外はクランプ（pos -1..1 / scale 0.1..5）', () => {
    const src = 'export const MAIN_LAYOUT = { position: { x: 9, y: -9 }, scale: 99, background: "#000000" };\n';
    expect(parseMainLayoutData(src)).toEqual({
      position: { x: 1, y: -1 },
      scale: 5,
      background: '#000000',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });
  it('background に引用符を含んでも JSON.stringify で安全に往復する', () => {
    const layout = {
      position: { x: 0, y: 0 },
      scale: 1.2,
      background: 'rgb(0,0,0) /* "x" */',
      rotation: 0,
      flipH: false,
      flipV: false,
    };
    const src = serializeMainLayoutData(layout);
    expect(src).not.toBeNull();
    expect(parseMainLayoutData(src)).toEqual(layout);
  });
});

describe('mainLayoutData 回転・反転', () => {
  it('rotation/flip を含むレイアウトを往復できる', () => {
    const layout = { position: { x: 0.2, y: 0 }, scale: 1.5, background: '#000000', rotation: 90, flipH: true, flipV: false };
    const src = serializeMainLayoutData(layout);
    expect(src).not.toBeNull();
    expect(src).toContain('rotation: 90');
    expect(src).toContain('flipH: true');
    // SEGMENT_LAYOUTS の型注釈に `flipV?: boolean` が常に出るため、MAIN_LAYOUT の行だけで判定する。
    const mainLayoutLine = (src ?? '').split('\n').find((l) => l.startsWith('export const MAIN_LAYOUT')) ?? '';
    expect(mainLayoutLine).not.toContain('flipV');
    expect(parseMainLayoutData(src)).toEqual(layout);
  });
  it('既定の rotation/flip はシリアライズに出さない(バイト同値)', () => {
    const layout = { position: { x: 0.2, y: 0 }, scale: 1.5, background: '#000000', rotation: 0, flipH: false, flipV: false };
    const src = serializeMainLayoutData(layout) ?? '';
    // SEGMENT_LAYOUTS の型注釈に `rotation`/`flip` の語が常に出るため、MAIN_LAYOUT の行だけで判定する。
    const mainLayoutLine = src.split('\n').find((l) => l.startsWith('export const MAIN_LAYOUT')) ?? '';
    expect(mainLayoutLine).not.toContain('rotation');
    expect(mainLayoutLine).not.toContain('flip');
  });
  it('rotation/flip が無い既存ソースは既定へフォールバック', () => {
    const legacy = `export const MAIN_LAYOUT = { position: { x: 0.2, y: 0 }, scale: 1.5, background: '#000000' };\n`;
    expect(parseMainLayoutData(legacy)).toEqual({ position: { x: 0.2, y: 0 }, scale: 1.5, background: '#000000', rotation: 0, flipH: false, flipV: false });
  });
  it('回転のみ(全画面)でも非恒等としてファイルを出す', () => {
    const layout = { ...DEFAULT_MAIN_LAYOUT, rotation: 45 };
    expect(serializeMainLayoutData(layout)).not.toBeNull();
  });
});

describe('mainLayoutData 区間ごと(SEGMENT_LAYOUTS)', () => {
  const base = { position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 0, flipH: false, flipV: false };
  const seg = { position: { x: 0.5, y: 0 }, scale: 2, rotation: 90, flipH: true, flipV: false };

  it('非 null のとき MAIN_LAYOUT と SEGMENT_LAYOUTS を両方出力', () => {
    const s = serializeMainLayoutData({ ...base, scale: 1.5 }, { 3: seg });
    expect(s).not.toBeNull();
    expect(s).toContain('export const MAIN_LAYOUT');
    expect(s).toContain('export const SEGMENT_LAYOUTS');
    expect(s).toContain('3: {');
    expect(s).toContain('rotation: 90');
    expect(s).toContain('flipH: true');
  });
  it('個別指定を往復できる（parse で復元）', () => {
    const s = serializeMainLayoutData({ ...base, scale: 1.5 }, { 3: seg }) ?? '';
    expect(parseSegmentLayoutsData(s)).toEqual({ 3: seg });
  });
  it('全体と実質同一の冗長エントリは出さない', () => {
    const s = serializeMainLayoutData({ ...base, scale: 1.5 }, { 3: { position: { x: 0, y: 0 }, scale: 1.5, rotation: 0, flipH: false, flipV: false } }) ?? '';
    expect(s).toContain('SEGMENT_LAYOUTS: Record<number');
    expect(s).not.toContain('3:'); // 冗長なので出ない
  });
  it('完全既定（恒等＋既定背景＋個別ゼロ）は null', () => {
    expect(serializeMainLayoutData(base, {})).toBeNull();
  });
  it('個別指定だけあれば恒等 base でもファイルを出す', () => {
    expect(serializeMainLayoutData(base, { 3: seg })).not.toBeNull();
  });
  it('SEGMENT_LAYOUTS 不在のソースは空マップ', () => {
    expect(parseSegmentLayoutsData(`export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: '#000' };\n`)).toEqual({});
    expect(parseSegmentLayoutsData(null)).toEqual({});
  });
  it('parse は NaN/範囲外をガード（クランプ・既定フォールバック）', () => {
    const src = `export const SEGMENT_LAYOUTS = { 5: { position: { x: 9, y: -9 }, scale: 99, rotation: 999, flipH: true } };\n`;
    expect(parseSegmentLayoutsData(src)).toEqual({ 5: { position: { x: 1, y: -1 }, scale: 5, rotation: 180, flipH: true, flipV: false } });
  });
});

describe('parseMainLayoutFile（1回の eval で両方 parse）', () => {
  it('null は既定 layout・空 segmentLayouts・空 layoutKeyframes', () => {
    expect(parseMainLayoutFile(null)).toEqual({ layout: DEFAULT_MAIN_LAYOUT, segmentLayouts: {}, layoutKeyframes: [], colorGrade: DEFAULT_COLOR_GRADE });
  });
  it('壊れたソースは既定へフォールバック', () => {
    expect(parseMainLayoutFile('export const NOPE =;')).toEqual({
      layout: DEFAULT_MAIN_LAYOUT,
      segmentLayouts: {}, layoutKeyframes: [], colorGrade: DEFAULT_COLOR_GRADE,
    });
  });
  it('serializeMainLayoutData の出力を round-trip できる（MAIN_LAYOUT・SEGMENT_LAYOUTS 両方）', () => {
    const layout = { position: { x: 0.5, y: -0.25 }, scale: 1.4, background: '#112233', rotation: 0, flipH: false, flipV: false };
    const seg = { position: { x: 0.5, y: 0 }, scale: 2, rotation: 90, flipH: true, flipV: false };
    const src = serializeMainLayoutData(layout, { 3: seg });
    expect(src).not.toBeNull();
    expect(parseMainLayoutFile(src)).toEqual({ layout, segmentLayouts: { 3: seg }, layoutKeyframes: [], colorGrade: DEFAULT_COLOR_GRADE });
  });
  it('parseMainLayoutData / parseSegmentLayoutsData と同じ結果を返す（既存 API との整合）', () => {
    const src = `export const MAIN_LAYOUT = { position: { x: 0.2, y: 0 }, scale: 1.5, background: '#000000' };
export const SEGMENT_LAYOUTS = { 5: { position: { x: 9, y: -9 }, scale: 99, rotation: 999, flipH: true } };\n`;
    const combined = parseMainLayoutFile(src);
    expect(combined.layout).toEqual(parseMainLayoutData(src));
    expect(combined.segmentLayouts).toEqual(parseSegmentLayoutsData(src));
  });
});

describe('mainLayoutData × motion（保存往復）', () => {
  it('SEGMENT_LAYOUTS の motion を書き出して往復できる', async () => {
    const { serializeMainLayoutData, parseMainLayoutFile } = await import('./mainLayoutData');
    const base = { position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 0, flipH: false, flipV: false };
    const src = serializeMainLayoutData(base, {
      3: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false, motion: { preset: 'zoomIn', intensity: 0.7, to: { scale: 1.5 } } },
    });
    expect(src).not.toBeNull();
    const parsed = parseMainLayoutFile(src);
    expect(parsed.segmentLayouts[3]?.motion).toEqual({ preset: 'zoomIn', intensity: 0.7, to: { scale: 1.5 } });
  });
});

describe('mainLayoutData × layoutKeyframes（大域配列・originalFrame アンカー・保存往復）', () => {
  const base = { position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 0, flipH: false, flipV: false };
  const kfs = [
    { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    { originalFrame: 30, x: 0.5, y: -0.25, scale: 2, rotation: 90 },
  ];

  it('LAYOUT_KEYFRAMES を書き出して往復できる（保存・リロード復元）', () => {
    const src = serializeMainLayoutData(base, {}, kfs);
    expect(src).not.toBeNull();
    expect(src).toContain('LAYOUT_KEYFRAMES');
    expect(parseLayoutKeyframesData(src)).toEqual(kfs);
  });

  it('キーフレーム指定だけがあれば恒等 base・個別レイアウト無しでもファイルを出す', () => {
    expect(serializeMainLayoutData(base, {}, kfs)).not.toBeNull();
  });

  it('2点未満のエントリは落とす（不完全なキーフレームは無効）', () => {
    const src = serializeMainLayoutData(base, {}, [kfs[0]!]) ?? '';
    expect(parseLayoutKeyframesData(src)).toEqual([]);
  });

  it('完全既定（恒等＋既定背景＋個別ゼロ＋キーフレーム無し）は null', () => {
    expect(serializeMainLayoutData(base, {}, [])).toBeNull();
  });

  it('LAYOUT_KEYFRAMES 不在/壊れたソースは空配列', () => {
    expect(parseLayoutKeyframesData(null)).toEqual([]);
    expect(parseLayoutKeyframesData('export const NOPE =;')).toEqual([]);
    expect(parseLayoutKeyframesData(`export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: '#000' };\n`)).toEqual([]);
  });

  it('parseMainLayoutFile の戻り値には layoutKeyframes も含む（project.ts の唯一の呼び出し元が単一 eval で保存・書き出しに反映できるよう1回の parse で全部返す）', () => {
    const src = serializeMainLayoutData(base, {}, kfs) ?? '';
    const parsed = parseMainLayoutFile(src);
    expect(parsed.layoutKeyframes).toEqual(kfs);
  });
});

describe('mainLayoutData × COLOR_GRADE（カラー補正・F-2）', () => {
  it('無補正・恒等レイアウトならファイル自体を出さない（旧案件に 1 バイトも生えない）', () => {
    expect(serializeMainLayoutData(DEFAULT_MAIN_LAYOUT, {}, [], DEFAULT_COLOR_GRADE)).toBeNull();
    // 引数省略時も同じ（既存呼び出し元の後方互換）。
    expect(serializeMainLayoutData(DEFAULT_MAIN_LAYOUT)).toBeNull();
  });

  it('補正だけ非既定ならファイルを出し、往復で保持する', () => {
    const grade = { brightness: 25, contrast: -10, saturation: 40, temperature: -5 };
    const src = serializeMainLayoutData(DEFAULT_MAIN_LAYOUT, {}, [], grade);
    expect(src).not.toBeNull();
    expect(src).toContain('export const COLOR_GRADE = {');
    expect(parseMainLayoutFile(src).colorGrade).toEqual(grade);
  });

  it('ファイルを出すときは無補正でも COLOR_GRADE を必ず export する（import 解決）', () => {
    const layout = { ...DEFAULT_MAIN_LAYOUT, scale: 1.5 };
    const src = serializeMainLayoutData(layout, {}, [], DEFAULT_COLOR_GRADE);
    expect(src).not.toBeNull();
    expect(src).toContain('export const COLOR_GRADE = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };');
  });

  it('COLOR_GRADE を持たない旧ファイルは無補正として読める', () => {
    const legacy = `export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1.2, background: '#000000' };\n`;
    expect(parseMainLayoutFile(legacy).colorGrade).toEqual(DEFAULT_COLOR_GRADE);
  });

  it('範囲外・型違いはクランプ／既定へ倒す', () => {
    const src = `export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: '#000000' };
export const COLOR_GRADE = { brightness: 999, contrast: -999, saturation: 'x', temperature: 12 };\n`;
    expect(parseMainLayoutFile(src).colorGrade).toEqual({
      brightness: 100, contrast: -100, saturation: 0, temperature: 12,
    });
  });

  it('NaN は握り潰さず fail-loud（値が黙って既定へ倒れない）', () => {
    const src = `export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: '#000000' };
export const COLOR_GRADE = { brightness: NaN, contrast: 0, saturation: 0, temperature: 0 };\n`;
    expect(() => parseMainLayoutFile(src)).toThrow();
  });
});
