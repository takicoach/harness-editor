import { describe, it, expect } from 'vitest';
import { trackAccent, trackKindAccent } from './trackAccent';
import type { SequenceClip, SequenceTrack } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';

const clip = (id: string, trackId: string, kind: 'telop' | 'title' | 'image' | 'shape' | 'video'): SequenceClip => ({ id, trackId, name: id, startFrame: 0, durationFrames: 10, clock: { offset: r(0), rate: r(1), duration: r(10) },
  content: kind === 'telop' ? { kind, data: { text: id } as never } : kind === 'title' ? { kind, data: { text: id } as never, style: 'plain' as never } : kind === 'image' ? { kind, assetId: 'a' } : kind === 'shape' ? { kind, data: {} as never } : { kind, assetId: 'a', streamIndex: 0, sourceIn: r(0), rate: r(1) } } as SequenceClip);
const track = (id: string, kind: 'visual' | 'audio'): SequenceTrack => ({ id, kind, name: id, enabled: true });

describe('trackAccent', () => {
  it('音声トラックは BGM 色', () => { expect(trackAccent(track('a', 'audio'), [])).toBe('--track-bgm'); });
  it('テロップ／タイトルだけの映像トラックはテロップ色', () => { expect(trackAccent(track('t', 'visual'), [clip('1', 't', 'telop'), clip('2', 't', 'title')])).toBe('--track-telop'); });
  it('画像／図形だけなら画像色', () => { expect(trackAccent(track('i', 'visual'), [clip('1', 'i', 'image'), clip('2', 'i', 'shape')])).toBe('--track-image'); });
  it('映像が混ざるか空なら映像色', () => {
    expect(trackAccent(track('v', 'visual'), [clip('1', 'v', 'video'), clip('2', 'v', 'telop')])).toBe('--track-video');
    expect(trackAccent(track('v', 'visual'), [])).toBe('--track-video');
  });
  it('他トラックのクリップは数えない', () => { expect(trackAccent(track('v', 'visual'), [clip('1', 'other', 'telop')])).toBe('--track-video'); });
  it('同種が 2 本以上並ぶと 3 色を巡回する（F7: ローズ→青→紫→ローズ）', () => {
    const ts = [track('t1', 'visual'), track('t2', 'visual'), track('t3', 'visual'), track('t4', 'visual')];
    const cs = [clip('a', 't1', 'telop'), clip('b', 't2', 'telop'), clip('c', 't3', 'telop'), clip('d', 't4', 'telop')];
    expect(ts.map(t => trackAccent(t, cs, ts))).toEqual(['--track-telop', '--track-jimaku', '--track-title', '--track-telop']);
  });
  it('タイトルだけのトラックは紫、図形だけは赤紫（役割の既定色）', () => {
    expect(trackAccent(track('t', 'visual'), [clip('a', 't', 'title')])).toBe('--track-title');
    expect(trackAccent(track('s', 'visual'), [clip('a', 's', 'shape')])).toBe('--track-shape');
  });
  it('画像の並びは橙→青緑', () => {
    const ts = [track('i1', 'visual'), track('i2', 'visual')];
    const cs = [clip('a', 'i1', 'image'), clip('b', 'i2', 'image')];
    expect(ts.map(t => trackAccent(t, cs, ts))).toEqual(['--track-image', '--track-vi']);
  });
  it('上書きが最優先', () => {
    const t = track('t', 'visual');
    expect(trackAccent(t, [clip('1', 't', 'telop')], [t], { t: '--track-se' })).toBe('--track-se');
  });
  it('名前に「効果音」を含む音声トラックは黄（se）', () => {
    expect(trackAccent({ ...track('s', 'audio'), name: '効果音' }, [])).toBe('--track-se');
  });
  // I-6: 再生中の毎フレーム描画では呼び手が trackKindAccent の map を事前計算して渡す。
  // 渡した結果と渡さない結果が一致すること（省略時の経路と同じ色になる）。
  it('事前計算した種別色の map を渡しても結果は変わらない', () => {
    const ts = [track('t1', 'visual'), track('t2', 'visual'), track('i1', 'visual'), track('a1', 'audio'), track('v1', 'visual')];
    const cs = [clip('a', 't1', 'telop'), clip('b', 't2', 'telop'), clip('c', 'i1', 'image'), clip('d', 'v1', 'video')];
    const kinds = new Map(ts.map(t => [t.id, trackKindAccent(t, cs)]));
    expect(kinds.size).toBe(ts.length);   // 存在検査（空 map なら「一致」は何も言っていない）
    const overrides = { v1: '--track-se' } as const;
    expect(ts.map(t => trackAccent(t, cs, ts, overrides, kinds))).toEqual(ts.map(t => trackAccent(t, cs, ts, overrides)));
    expect(ts.map(t => trackAccent(t, cs, ts, overrides, kinds))).toEqual(['--track-telop', '--track-jimaku', '--track-image', '--track-bgm', '--track-se']);
  });
});
