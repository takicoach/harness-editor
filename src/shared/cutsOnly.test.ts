import { describe, expect, it } from 'vitest';
import {
  isCutsOnly,
  nativeUnsupportedReasons,
  type CutsOnlyInput,
  type NativeUnsupportedReason,
} from './cutsOnly';

const base: CutsOnlyInput = {
  telops: [], se: [], images: [], videoInserts: [], bgm: [], bgmDucking: false, titles: [], shapes: [],
  sceneTransitions: [], layoutKeyframes: [], mainSpeed: 1, segmentSpeeds: {},
  mainLayout: undefined, segmentLayouts: {},
};

describe('nativeUnsupportedReasons', () => {
  it('空プロジェクトは理由なし（= 対応）', () => {
    expect(nativeUnsupportedReasons(base)).toEqual([]);
  });
  it('要素ごとに理由が返る', () => {
    expect(nativeUnsupportedReasons({ ...base, layoutKeyframes: [{}] })).toEqual(['layoutKeyframes']);
    expect(nativeUnsupportedReasons({ ...base, mainSpeed: 2 })).toEqual(['speed']);
    expect(nativeUnsupportedReasons({ ...base, mainLayout: { scale: 1.2 } })).toEqual(['layout']);
  });
  it('isCutsOnly と等価（reasons 空 ⇔ true）', () => {
    const variants: CutsOnlyInput[] = [
      base,
      { ...base, se: [{}] },
      { ...base, segmentSpeeds: { 0: 2 } },
      { ...base, sceneTransitions: [{}] },
    ];
    for (const v of variants) {
      expect(isCutsOnly(v)).toBe(nativeUnsupportedReasons(v).length === 0);
    }
  });

  it('se があっても理由にならない（nativeExport 対応済み）', () => {
    const v = { ...base, se: [{}] };
    expect(nativeUnsupportedReasons(v)).toEqual([]);
    expect(isCutsOnly(v)).toBe(true);
  });

  it('bgm があっても（ducking 無しなら）理由にならない', () => {
    const v = { ...base, bgm: [{}] };
    expect(nativeUnsupportedReasons(v)).toEqual([]);
    expect(isCutsOnly(v)).toBe(true);
  });

  it('shapes があっても理由にならない（nativeExport 対応済み・M1d）', () => {
    const v = { ...base, shapes: [{}] };
    expect(nativeUnsupportedReasons(v)).toEqual([]);
    expect(isCutsOnly(v)).toBe(true);
  });

  it('sceneTransitions があっても理由にならない（nativeExport 対応済み・M3）', () => {
    // 対立仮説: ゲートが閉じたままなら reasons に 'sceneTransitions' が残り、
    // 転換のあるプロジェクトは planFastCut が null を返して Remotion 経路へ落ちる。
    const v = { ...base, sceneTransitions: [{}] };
    expect(nativeUnsupportedReasons(v)).toEqual([]);
    expect(isCutsOnly(v)).toBe(true);
  });

  it('videoInserts があっても理由にならない（nativeExport 対応済み・M4）', () => {
    // 対立仮説: ゲートが閉じたままなら reasons に 'videoInserts' が残り、
    // サブ動画のあるプロジェクトは planFastCut が null を返して Remotion 経路へ落ちる。
    const v = { ...base, videoInserts: [{}] };
    expect(nativeUnsupportedReasons(v)).toEqual([]);
    expect(isCutsOnly(v)).toBe(true);
  });

  it('telops / images / titles があっても理由にならない（nativeExport 対応済み・M2c 撮影オーバーレイ）', () => {
    for (const patch of [{ telops: [{}] }, { images: [{}] }, { titles: [{}] }]) {
      const v = { ...base, ...patch };
      expect(nativeUnsupportedReasons(v)).toEqual([]);
      expect(isCutsOnly(v)).toBe(true);
    }
    // 3つ同時でも同じ（撮影は1プロジェクトで2レイヤに統合される）
    const all = { ...base, telops: [{}], images: [{}], titles: [{}] };
    expect(isCutsOnly(all)).toBe(true);
  });

  /**
   * 理由ごとの発火 fixture。**`Record<NativeUnsupportedReason, …>` で型に閉じる**（M3 B-7 M-2）。
   * 旧版は配列 + `toBe(6)` の件数比較だったので、型に理由が 1 つ増えても
   * 「数だけ合わせる」修正で網羅が破れた（新しい理由に fixture が無いまま緑）。
   * この形なら**理由を足した瞬間に `tsc --noEmit` が赤**になる（キー欠落）。
   */
  const patches: Record<NativeUnsupportedReason, Partial<CutsOnlyInput>> = {
    ducking: { bgm: [{}], bgmDucking: true },
    layoutKeyframes: { layoutKeyframes: [{}] },
    speed: { mainSpeed: 2 },
    segmentSpeeds: { segmentSpeeds: { 0: 2 } },
    layout: { mainLayout: { scale: 1.2 } },
    color: { colorGrade: { brightness: 15 } },
  };
  const cases = Object.entries(patches) as Array<[NativeUnsupportedReason, Partial<CutsOnlyInput>]>;
  it.each(cases)('%s は理由を返し isCutsOnly=false', (reason, patch) => {
    const v = { ...base, ...patch };
    expect(nativeUnsupportedReasons(v)).toContain(reason);
    expect(isCutsOnly(v)).toBe(false);
  });
  it('カラー補正は 4 項目のどれか 1 つでも非ゼロなら理由になる', () => {
    for (const k of ['brightness', 'contrast', 'saturation', 'temperature'] as const) {
      const v = { ...base, colorGrade: { [k]: -7 } };
      expect(nativeUnsupportedReasons(v)).toContain('color');
      expect(isCutsOnly(v)).toBe(false);
    }
    // 無補正（全 0・未設定）は理由にならない＝既存案件の高速書き出しを奪わない。
    expect(isCutsOnly({ ...base, colorGrade: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 } })).toBe(true);
    expect(isCutsOnly({ ...base })).toBe(true);
  });
  it('列挙が網羅されている（キーの重複が無い＝各理由がちょうど 1 件の fixture を持つ）', () => {
    // 件数の pin ではなく「Record のキー = 実際に発火した理由の集合」を突き合わせる。
    expect(new Set(cases.map(([r]) => r)).size).toBe(cases.length);
  });
});
