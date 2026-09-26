import { describe, it, expect } from 'vitest';
import {
  resolveMotion,
  sampleMotion,
  sampleMotionKeys,
  motionProgress,
  easeInOutCubic,
  parseMotion,
  formatMotion,
  type Motion,
  type MotionBase,
} from './motion';

const BASE: MotionBase = { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 };

describe('native outer position policy',()=>{
  it('changes only position limits, preserving legacy defaults and all other clamps',()=>{
    const input={x:30,y:-40,scale:100,opacity:2,rotation:900};
    expect(sampleMotion(undefined,input,0)).toEqual({x:1.5,y:-1.5,scale:8,opacity:1,rotation:360});
    expect(sampleMotion(undefined,input,0,'finite')).toEqual({x:30,y:-40,scale:8,opacity:1,rotation:360});
    expect(()=>sampleMotion(undefined,{...BASE,x:Infinity},0,'finite')).toThrow('有限');
  });
  it.each(['custom','keyframes'] as const)('retains finite %s endpoints even when their subtraction would overflow',preset=>{
    const start={x:-Number.MAX_VALUE,y:Number.MAX_VALUE},end={x:Number.MAX_VALUE,y:-Number.MAX_VALUE};
    const motion:Motion=preset==='custom'?{preset,from:start,to:end}:{preset,keys:[{t:0,...start},{t:1,...end}]};
    for(const t of [0,.25,.5,.75,1]){
      const value=sampleMotion(motion,BASE,t,'finite');
      expect(Number.isFinite(value.x)&&Number.isFinite(value.y)).toBe(true);
      if(t===0)expect(value).toMatchObject(start);
      if(t===1)expect(value).toMatchObject(end);
      if(t===.5)expect(value).toMatchObject({x:0,y:0});
    }
  });
  it('resolves preset positions beyond the legacy range without changing scale safety',()=>{
    expect(resolveMotion({preset:'panRight',intensity:1},{...BASE,x:4},'finite')).toMatchObject({from:{x:3.6},to:{x:4.4}});
    expect(sampleMotionKeys([{t:.2,x:4},{t:.8,x:8}],BASE,0,'finite').x).toBe(4);
    expect(sampleMotionKeys([{t:.2,x:4},{t:.8,x:8}],BASE,1,'finite').x).toBe(8);
  });
});

describe('resolveMotion（プリセット→端点）', () => {
  it('zoomIn は scale が base → base*(1+0.8k)', () => {
    const { from, to } = resolveMotion({ preset: 'zoomIn', intensity: 0.5 }, BASE);
    expect(from.scale).toBe(1);
    expect(to.scale).toBeCloseTo(1.4);
  });
  it('zoomOut は逆向き', () => {
    const { from, to } = resolveMotion({ preset: 'zoomOut', intensity: 1 }, BASE);
    expect(from.scale).toBeCloseTo(1.8);
    expect(to.scale).toBe(1);
  });
  it('panLeft は x が +0.4k → -0.4k（base 中心）', () => {
    const { from, to } = resolveMotion({ preset: 'panLeft', intensity: 1 }, { ...BASE, x: 0.1 });
    expect(from.x).toBeCloseTo(0.5);
    expect(to.x).toBeCloseTo(-0.3);
  });
  it('fadeIn は opacity 0 → base', () => {
    const { from, to } = resolveMotion({ preset: 'fadeIn' }, { ...BASE, opacity: 0.8 });
    expect(from.opacity).toBe(0);
    expect(to.opacity).toBe(0.8);
  });
  it('from/to の明示指定はプリセットを上書きする', () => {
    const m: Motion = { preset: 'zoomIn', intensity: 1, to: { scale: 2, x: 0.5 } };
    const { to } = resolveMotion(m, BASE);
    expect(to.scale).toBe(2);
    expect(to.x).toBe(0.5);
  });
  it('端点はクランプされる（画面外へ吹き飛ばない）', () => {
    const m: Motion = { preset: 'custom', from: { x: -99, scale: 100 }, to: { opacity: 5 } };
    const { from, to } = resolveMotion(m, BASE);
    expect(from.x).toBe(-1.5);
    expect(from.scale).toBe(8);
    expect(to.opacity).toBe(1);
  });
});

describe('sampleMotion（補間）', () => {
  it('progress 0 は from、1 は to、中間はイーズ済み中間値', () => {
    const m: Motion = { preset: 'zoomIn', intensity: 0.5 };
    expect(sampleMotion(m, BASE, 0).scale).toBe(1);
    expect(sampleMotion(m, BASE, 1).scale).toBeCloseTo(1.4);
    expect(sampleMotion(m, BASE, 0.5).scale).toBeCloseTo(1.2); // ease(0.5)=0.5
  });
  it('motion 未指定は base をそのまま返す', () => {
    expect(sampleMotion(undefined, { ...BASE, x: 0.3 }, 0.7)).toEqual({ ...BASE, x: 0.3 });
  });
});

describe('motionProgress / easeInOutCubic', () => {
  it('区間内 0..1・区間外クランプ・縮退区間は 1', () => {
    expect(motionProgress(100, 100, 200)).toBe(0);
    expect(motionProgress(150, 100, 200)).toBe(0.5);
    expect(motionProgress(999, 100, 200)).toBe(1);
    expect(motionProgress(0, 100, 200)).toBe(0);
    expect(motionProgress(100, 100, 100)).toBe(1);
  });
  it('ease は両端 0/1・中央 0.5', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
  });
});

describe('parseMotion / formatMotion（往復）', () => {
  it('正しい値はそのまま・不正 preset は undefined', () => {
    expect(parseMotion({ preset: 'panRight', intensity: 0.3 }))
      .toEqual({ preset: 'panRight', intensity: 0.3 });
    expect(parseMotion({ preset: 'spin' })).toBeUndefined();
    expect(parseMotion('zoomIn')).toBeUndefined();
    expect(parseMotion(null)).toBeUndefined();
  });
  it('format → 評価 → parse で往復する', () => {
    const m: Motion = { preset: 'custom', from: { x: 0.1, opacity: 0 }, to: { x: -0.2, scale: 1.5 } };
    const text = formatMotion(m);
    // eslint-disable-next-line no-eval
    const roundTripped = parseMotion(eval(`(${text})`));
    expect(roundTripped).toEqual(m);
  });
  it('intensity は 0..1 にクランプして受ける', () => {
    expect(parseMotion({ preset: 'zoomIn', intensity: 9 })).toEqual({ preset: 'zoomIn', intensity: 1 });
  });
});

// ── F-1 キーフレームアニメ（N点補間） ─────────────────────────────
describe('sampleMotion（キーフレーム keys）', () => {
  const kf = (keys: Motion['keys']): Motion => ({ preset: 'keyframes', keys });

  it('keys が 2 点なら端点で厳密にその値、中央で ease 済み中間値', () => {
    const m = kf([{ t: 0, scale: 1 }, { t: 1, scale: 2 }]);
    expect(sampleMotion(m, BASE, 0).scale).toBeCloseTo(1, 10);
    expect(sampleMotion(m, BASE, 1).scale).toBeCloseTo(2, 10);
    expect(sampleMotion(m, BASE, 0.5).scale).toBeCloseTo(1 + easeInOutCubic(0.5), 10);
  });

  it('3 点以上で区間ごとに補間する（中間キーを通る）', () => {
    const m = kf([
      { t: 0, x: 0 },
      { t: 0.5, x: 0.4 },
      { t: 1, x: -0.4 },
    ]);
    expect(sampleMotion(m, BASE, 0.5).x).toBeCloseTo(0.4, 10);
    // 前半 25% は 0→0.4 の区間内進行度 0.5
    expect(sampleMotion(m, BASE, 0.25).x).toBeCloseTo(0.4 * easeInOutCubic(0.5), 10);
    // 後半 75% は 0.4→-0.4 の区間内進行度 0.5
    expect(sampleMotion(m, BASE, 0.75).x).toBeCloseTo(0.4 + (-0.8) * easeInOutCubic(0.5), 10);
  });

  it('最初のキーより前・最後のキーより後は端の値で固定', () => {
    const m = kf([{ t: 0.25, opacity: 0.2 }, { t: 0.75, opacity: 0.9 }]);
    expect(sampleMotion(m, BASE, 0).opacity).toBeCloseTo(0.2, 10);
    expect(sampleMotion(m, BASE, 1).opacity).toBeCloseTo(0.9, 10);
  });

  it('キーで指定しない軸は base の値を使う（軸ごとの部分指定）', () => {
    const m = kf([{ t: 0, scale: 1 }, { t: 1, scale: 2 }]);
    const s = sampleMotion(m, { ...BASE, x: 0.3, opacity: 0.5 }, 0.5);
    expect(s.x).toBeCloseTo(0.3, 10);
    expect(s.opacity).toBeCloseTo(0.5, 10);
  });

  it('キー 1 点は全区間その値で固定（アニメしない）', () => {
    const m = kf([{ t: 0.5, scale: 1.7 }]);
    for (const p of [0, 0.3, 0.5, 1]) expect(sampleMotion(m, BASE, p).scale).toBeCloseTo(1.7, 10);
  });

  it('t 順が乱れていても昇順として扱う', () => {
    const m = kf([{ t: 1, x: 1 }, { t: 0, x: -1 }]);
    expect(sampleMotion(m, BASE, 0).x).toBeCloseTo(-1, 10);
    expect(sampleMotion(m, BASE, 1).x).toBeCloseTo(1, 10);
  });

  it('keys があるとき preset / intensity / from / to は無視される', () => {
    const m: Motion = { preset: 'zoomIn', intensity: 1, from: { scale: 5 }, to: { scale: 6 }, keys: [{ t: 0, scale: 1 }, { t: 1, scale: 1.2 }] };
    expect(sampleMotion(m, BASE, 0).scale).toBeCloseTo(1, 10);
    expect(sampleMotion(m, BASE, 1).scale).toBeCloseTo(1.2, 10);
  });

  it('keys が空配列なら従来のプリセット挙動へ戻る', () => {
    const m: Motion = { preset: 'zoomIn', intensity: 1, keys: [] };
    expect(sampleMotion(m, BASE, 1).scale).toBeCloseTo(1.8, 10);
  });

  it('値はクランプされる（画面外へ吹き飛ばない）', () => {
    const m = kf([{ t: 0, x: -99, scale: 99, opacity: 5 }, { t: 1, x: 99 }]);
    const s0 = sampleMotion(m, BASE, 0);
    expect(s0.x).toBe(-1.5);
    expect(s0.scale).toBe(8);
    expect(s0.opacity).toBe(1);
  });

  it('preset:"keyframes" で keys 未指定なら base のまま（無変化）', () => {
    expect(sampleMotion({ preset: 'keyframes' }, BASE, 0.5)).toEqual(BASE);
  });
});

describe('parseMotion / formatMotion（keys 往復）', () => {
  it('keys を parse する（t 昇順・不正要素は捨てる）', () => {
    const m = parseMotion({ preset: 'keyframes', keys: [{ t: 1, scale: 2 }, { t: 0, scale: 1 }, null, { scale: 3 }] });
    expect(m?.keys).toEqual([{ t: 0, scale: 1 }, { t: 1, scale: 2 }]);
  });
  it('t は 0..1 にクランプされる', () => {
    const m = parseMotion({ preset: 'keyframes', keys: [{ t: -3, x: 0 }, { t: 9, x: 1 }] });
    expect(m?.keys?.map((k) => k.t)).toEqual([0, 1]);
  });
  it('format → parse で同値に戻る', () => {
    const m: Motion = { preset: 'keyframes', keys: [{ t: 0, x: 0, scale: 1, opacity: 1 }, { t: 0.5, scale: 1.4 }, { t: 1, x: 0.2, rotation: 15 }] };
    const text = formatMotion(m);
    expect(text).toContain('keys:');
    // eslint-disable-next-line no-eval
    const round = parseMotion(eval(`(${text})`));
    expect(round).toEqual(m);
  });
  it('preset:"keyframes" が preset として受理される', () => {
    expect(parseMotion({ preset: 'keyframes' })?.preset).toBe('keyframes');
  });
});

describe('メイン動画（区間レイアウト）はキーフレーム非対応で一貫させる', () => {
  it('mainLayoutData の parse は motion.keys を落とす（書き出し側の複製が未対応のため）', async () => {
    const { parseSegmentLayoutsData } = await import('./mainLayoutData');
    const source = [
      'export const SEGMENT_LAYOUTS = {',
      '  1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false,',
      '       motion: { preset: "keyframes", keys: [{ t: 0, scale: 1 }, { t: 1, scale: 2 }] } },',
      '};',
    ].join('\n');
    const parsed = parseSegmentLayoutsData(source);
    expect(parsed[1]?.motion).toBeDefined();
    expect(parsed[1]?.motion?.keys).toBeUndefined();
  });
});

describe('sampleMotionKeys の t 同値タイ（docstring と実装の一致）', () => {
  // t=0.5 に 2 点。ちょうど 0.5 では**先のキー**（x:0.5）、超えた直後から後のキー（x:-0.5）起点。
  const keys = [{ t: 0, x: 0 }, { t: 0.5, x: 0.5 }, { t: 0.5, x: -0.5 }, { t: 1, x: 0 }];
  const BASE_T: MotionBase = { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 };
  it('ちょうど t のときは先のキーの値', () => {
    expect(sampleMotionKeys(keys, BASE_T, 0.5)).toMatchObject({ x: 0.5 });
  });
  it('t を超えた直後は後のキーから離れていく', () => {
    expect(sampleMotionKeys(keys, BASE_T, 0.5000001).x).toBeCloseTo(-0.5, 6);
  });
});
