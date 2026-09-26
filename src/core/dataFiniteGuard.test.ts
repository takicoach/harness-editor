import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProject, type ProjectFiles } from './project';
import { parseTelopData, formatTelopArray } from './telopData';
import { parseTransitionData } from './transitionData';
import { parseSpeedData } from './speedData';
import { parseMainLayoutData, parseSegmentLayoutsData, parseLayoutKeyframesData } from './mainLayoutData';
import { parseCutData } from './cutData';
import { parseSeData } from './seData';
import { ProjectFileError, type TelopSegment } from './types';

/**
 * 壊れた数値を持つプロジェクトファイルの読み込み（G-5）。
 *
 * `NaN` や `1e400`（=Infinity）は vm 評価を素通りし、そのまま編集状態へ入って
 * 座標計算の全てへ伝播したあと、保存時に `startFrame: NaN` として書き戻される
 * ——つまり**壊れたまま静かに往復する**（この防護を入れる前の実測挙動）。
 * 読み込み時に「どのファイルのどの要素か」を示して止める（fail-loud）ことを固定する。
 */

const VIDEO_CONFIG = readFileSync(
  new URL('../server/__fixtures__/sample-project/src/videoConfig.ts', import.meta.url),
  'utf8',
);
const TRANSCRIPT = readFileSync(new URL('./__fixtures__/transcript.fixture.json', import.meta.url), 'utf8');

function files(telopDataSource: string): ProjectFiles {
  return {
    videoConfigSource: VIDEO_CONFIG,
    telopDataSource,
    cutDataSource: null,
    transcriptJson: TRANSCRIPT,
    projectConfigJson: null,
    seDataSource: null,
    insertImageDataSource: null,
    titleDataSource: null,
  };
}

describe('データファイルの非有限数を読み込み時に弾く', () => {
  it('正常なファイルは従来どおり読める（存在検査）', () => {
    const p = loadProject(files('export const telopData = [{ id: 1, startFrame: 0, endFrame: 30, text: "あ" }];'));
    expect(p.telops).toHaveLength(1);
    expect(p.telops[0]!.originalStart).toBe(0);
  });

  it('telopData の NaN を ProjectFileError で止める', () => {
    expect(() => parseTelopData('export const telopData = [{ id: 1, startFrame: NaN, endFrame: 30, text: "あ" }];', 60, 12000))
      .toThrow(ProjectFileError);
    expect(() => parseTelopData('export const telopData = [{ id: 1, startFrame: NaN, endFrame: 30, text: "あ" }];', 60, 12000))
      .toThrow(/telopData\[0\]\.startFrame/);
  });

  it('オーバーフロー（1e400 = Infinity）も止める', () => {
    expect(() => parseTelopData('export const telopData = [{ id: 1, startFrame: 1e400, endFrame: 30, text: "あ" }];', 60, 12000))
      .toThrow(/Infinity/);
  });

  it('入れ子（position）の NaN も止める', () => {
    expect(() => parseTelopData('export const telopData = [{ id: 1, startFrame: 0, endFrame: 30, text: "あ", position: { x: NaN, y: 0 } }];', 60, 12000))
      .toThrow(/position\.x/);
  });

  it('null の数値も止める', () => {
    expect(() => parseCutData('export const cutData = [{ id: 1, originalStart: null, originalEnd: 10, playbackStart: 0, playbackEnd: 10 }];'))
      .toThrow(/originalStart/);
  });

  it('cutData / seData も同じ守りを持つ', () => {
    expect(() => parseCutData('export const cutData = [{ id: 1, originalStart: 0/0, originalEnd: 10, playbackStart: 0, playbackEnd: 10 }];'))
      .toThrow(ProjectFileError);
    expect(() => parseSeData('export const seData = [{ id: 1, startFrame: NaN, file: "a.mp3" }];'))
      .toThrow(ProjectFileError);
  });

  it('省略（undefined）は正常値として通す', () => {
    expect(() => parseSeData('export const seData = [{ id: 1, startFrame: 0, file: "a.mp3" }];')).not.toThrow();
  });

  it('loadProject 経由でも読み込みが止まる（壊れた値が編集状態へ入らない）', () => {
    expect(() => loadProject(files('export const telopData = [{ id: 1, startFrame: NaN, endFrame: 30, text: "あ" }];')))
      .toThrow(ProjectFileError);
  });
});

/**
 * 前ラウンドで**守られていなかった 4 経路**（evalDataModule を使う残り）。
 * ここが素通りだったため、
 * - transitionData: `durationFrames: NaN` がそのまま EditState へ入り、
 *   保存側の NUMERIC_EDIT_FIELDS が 'sceneTransitions' を含むせいで
 *   「開けるのにテロップ 1 文字の修正すら 400 で保存できない」状態になっていた。
 * - speedData / mainLayoutData: 壊れた数値を**黙って既定へ倒して**いた（見た目は正常に開き、
 *   次の保存でその既定が確定してユーザーの指定値が永久に失われる silent corruption）。
 */
describe('壊れた数値の残り 4 経路（transition / speed / mainLayout / keyframes）', () => {
  it('transitionData の NaN を止める（素通りして保存側だけが 400 になるのを防ぐ）', () => {
    const src = 'export const transitionData = [{ id: 1, at: "head", kind: "fadeBlack", durationFrames: NaN }];';
    expect(() => parseTransitionData(src, 30)).toThrow(ProjectFileError);
    expect(() => parseTransitionData(src, 30)).toThrow(/transitionData\[0\]\.durationFrames/);
  });

  it('transitionData の正常なファイルは従来どおり読める（存在検査）', () => {
    const ok = parseTransitionData(
      'export const transitionData = [{ id: 1, at: "head", kind: "fadeBlack", durationFrames: 15 }];',
      30,
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.durationFrames).toBe(15);
  });

  it('speedData の MAIN_SPEED / SEGMENT_SPEEDS の NaN を止める（既定 1.0 へ黙って倒さない）', () => {
    expect(() => parseSpeedData('export const MAIN_SPEED = NaN;')).toThrow(/MAIN_SPEED/);
    expect(() => parseSpeedData('export const MAIN_SPEED = 1.5;\nexport const SEGMENT_SPEEDS = { 3: NaN };'))
      .toThrow(/SEGMENT_SPEEDS\.3/);
  });

  it('speedData の型違い・不在は従来どおり既定へフォールバックする（後方互換）', () => {
    expect(parseSpeedData(null)).toEqual({ mainSpeed: 1, segmentSpeeds: {} });
    expect(parseSpeedData('export const MAIN_SPEED = "はやい";')).toEqual({ mainSpeed: 1, segmentSpeeds: {} });
    expect(parseSpeedData('export const MAIN_SPEED = 1.5;')).toEqual({ mainSpeed: 1.5, segmentSpeeds: {} });
  });

  it('mainLayoutData の MAIN_LAYOUT / SEGMENT_LAYOUTS の NaN を止める', () => {
    expect(() => parseMainLayoutData('export const MAIN_LAYOUT = { position: { x: NaN, y: 0 }, scale: 1 };'))
      .toThrow(/MAIN_LAYOUT\.position\.x/);
    expect(() => parseSegmentLayoutsData('export const SEGMENT_LAYOUTS = { 2: { position: { x: 0, y: 0 }, scale: 0/0 } };'))
      .toThrow(/SEGMENT_LAYOUTS\.2\.scale/);
  });

  it('LAYOUT_KEYFRAMES の NaN を止める（キーフレームが黙って既定値へ潰れるのを防ぐ）', () => {
    const src =
      'export const LAYOUT_KEYFRAMES = [{ originalFrame: 0, x: 0, y: 0, scale: NaN, rotation: 0 }, { originalFrame: 90, x: 0, y: 0, scale: 2, rotation: 0 }];';
    expect(() => parseLayoutKeyframesData(src)).toThrow(/LAYOUT_KEYFRAMES\[0\]\.scale/);
  });

  it('mainLayoutData の正常なファイルは従来どおり読める（存在検査）', () => {
    const src =
      'export const MAIN_LAYOUT = { position: { x: 0.2, y: 0 }, scale: 1.5, background: "#000" };\n' +
      'export const LAYOUT_KEYFRAMES = [{ originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }, { originalFrame: 90, x: 0, y: 0, scale: 2, rotation: 0 }];';
    expect(parseMainLayoutData(src).scale).toBe(1.5);
    expect(parseLayoutKeyframesData(src)).toHaveLength(2);
  });

  it('mainLayoutData の評価不能（構文エラー）は従来どおり既定へフォールバックする', () => {
    expect(parseMainLayoutData('export const MAIN_LAYOUT = {{{').scale).toBe(1);
    expect(parseLayoutKeyframesData('export const LAYOUT_KEYFRAMES = [[[')).toEqual([]);
  });
});

/**
 * null の扱い（意図的に「あらゆる型の null」を弾く）。
 * 文字列フィールドの null を通すと `formatTelopArray` の中で
 * `Cannot read properties of null (reading 'replace')` が出て**保存が落ちる**（実測）。
 * 読み込み時にファイル名と要素を示して止めるほうが直しやすい、という判断を固定する。
 */
describe('null は数値フィールドでなくても弾く（保存時の TypeError より早く止める）', () => {
  it('文字列フィールドの null も ProjectFileError で止まる', () => {
    expect(() => parseTelopData('export const telopData = [{ id: 1, startFrame: 0, endFrame: 30, text: "あ", highlight: null }];', 60, 12000))
      .toThrow(/telopData\[0\]\.highlight/);
  });

  it('通してしまうと保存側が素の TypeError で落ちる（この検査が守っている実害）', () => {
    expect(() => formatTelopArray([{ id: 1, startFrame: 0, endFrame: 30, text: 'あ', highlight: null } as unknown as TelopSegment]))
      .toThrow(TypeError);
  });

  it('mainLayoutData 側は null をフォールバックとして通す（パーサが型検査するため）', () => {
    expect(parseMainLayoutData('export const MAIN_LAYOUT = { position: { x: 0.2, y: 0 }, scale: 1.5, background: null };').background)
      .not.toBeNull();
  });
});
