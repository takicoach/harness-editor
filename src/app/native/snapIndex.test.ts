import { describe, expect, it } from 'vitest';
import { buildSnapIndex, snapFrame, sourceFrameOccurrences, targetDisplayBias, WORD_GAP_MS } from './snapIndex';
import { rational as r } from '../../core/sequence/time';
import { fixture } from '../../core/sequence/fixtures';
import type { SequenceDocument } from '../../core/sequence/model';

/** audio（0..300、素材 0..10 秒）に 4 語。2 語目と 3 語目の間は 1 秒空く。 */
function spoken(): SequenceDocument {
  const doc = fixture();
  doc.transcripts.push({ assetId: 'source', streamIndex: 1, words: [
    { id: 'w1', text: 'ナイス', start: r(1), end: r(2) },
    { id: 'w2', text: 'ショット', start: r(2), end: r(3) },
    { id: 'w3', text: 'ですね', start: r(4), end: r(5) },
    { id: 'w4', text: '本当に', start: r(5), end: r(6) },
  ] });
  return doc;
}

describe('sourceFrameOccurrences', () => {
  it('素材時刻をタイムラインフレームへ写す', () => {
    expect(sourceFrameOccurrences(spoken(), 'source', 1, r(2))).toEqual([60]);
  });
  it('同じ素材を2回使っていれば2つ返す', () => {
    const doc = spoken();
    const audio = doc.clips.find(c => c.id === 'audio')!;
    audio.durationFrames = 150; audio.clock.duration = r(150);
    doc.clips.push({ ...structuredClone(audio), id: 'audio2', startFrame: 150, linkGroupId: undefined,
      clock: { offset: r(0), rate: r(1), duration: r(150) },
      content: { ...structuredClone(audio.content), sourceIn: r(0) } as never });
    doc.clips = doc.clips.filter(c => c.id !== 'telop');
    expect(sourceFrameOccurrences(doc, 'source', 1, r(2))).toEqual([60, 210]);
  });
  it('速度が変わっていても写像は rate をたどる', () => {
    const doc = spoken();
    const audio = doc.clips.find(c => c.id === 'audio')!;
    (audio.content as { rate: unknown }).rate = r(2);
    doc.clips = doc.clips.filter(c => c.id !== 'telop');
    expect(sourceFrameOccurrences(doc, 'source', 1, r(2))).toEqual([30]);
  });
  it('どのクリップでも使われていない時刻は空', () => {
    expect(sourceFrameOccurrences(spoken(), 'source', 1, r(59))).toEqual([]);
  });
});

describe('buildSnapIndex', () => {
  it('0・再生ヘッド・他クリップ両端・単語境界・語間を集める', () => {
    const targets = buildSnapIndex(spoken(), 123, []);
    const kinds = new Set(targets.map(t => t.kind));
    expect(kinds).toEqual(new Set(['zero', 'playhead', 'clip', 'word', 'gap']));
    expect(targets.find(t => t.kind === 'playhead')!.frame).toBe(123);
    expect(targets.some(t => t.kind === 'word' && t.frame === 60)).toBe(true);
  });
  it('語間は 400ms 以上あいたところだけ。ラベルは「語間」（「無音」とは呼ばない）', () => {
    const gaps = buildSnapIndex(spoken(), 0, []).filter(t => t.kind === 'gap');
    expect(gaps.map(t => t.frame)).toEqual([90, 120]);
    expect(gaps[0]!.label).toContain('語間');
    expect(gaps.map(t => t.label).join('')).not.toContain('無音');
    expect(WORD_GAP_MS).toBe(400);
  });
  it('つかんでいるクリップ自身は対象から外す', () => {
    const targets = buildSnapIndex(spoken(), 0, ['music']);
    expect(targets.some(t => t.kind === 'clip' && t.label.includes('音楽'))).toBe(false);
  });
  it('フレーム昇順で返す', () => {
    const frames = buildSnapIndex(spoken(), 123, []).map(t => t.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
  });
  it('連続する語（前の終端=次の始端）は同じフレームに1エントリだけ', () => {
    const doc = fixture();
    doc.transcripts.push({ assetId: 'source', streamIndex: 1, words: [
      { id: 'w1', text: 'ナイス', start: r(1), end: r(2) },
      { id: 'w2', text: 'ショット', start: r(2), end: r(3) },
    ] });
    const atSixty = buildSnapIndex(doc, 0, []).filter(t => t.frame === 60 && t.kind === 'word');
    expect(atSixty).toHaveLength(1);
  });
  it('kind が異なれば同じフレームでも畳まない（zero と clip、gap と word はこの索引の作りで常に重なる）', () => {
    const targets = buildSnapIndex(spoken(), 999, []); // playhead をずらして frame 0 の衝突から外す
    // video・audio・music の3クリップが frame 0 に始まるが 'clip' 同士は畳まれて1件、'zero' とは畳まれず別に残る。
    expect(targets.filter(t => t.frame === 0).map(t => t.kind).sort()).toEqual(['clip', 'zero'].sort());
  });
  it('playhead に null を渡すと playhead 対象を含まない（frame 0 の幽霊 playhead を防ぐ）', () => {
    const targets = buildSnapIndex(spoken(), null, []);
    expect(targets.some(t => t.kind === 'playhead')).toBe(false);
    expect(targets.find(t => t.frame === 0 && t.kind === 'zero')).toBeTruthy();
  });
  it('隣接クリップ（A の終わり＝B の始まり）は doc.clips の並び順に関わらず side:"end" が残る', () => {
    const base = fixture();
    const clip = (id: string, name: string, startFrame: number): SequenceDocument['clips'][number] => ({
      id, name, trackId: 'v2', startFrame, durationFrames: 60, clock: { offset: r(0), rate: r(1), duration: r(60) },
      content: { kind: 'telop', data: { text: name } } });
    const a = clip('a', 'A', 0), b = clip('b', 'B', 60);
    const forward = { ...base, clips: [a, b] }, reversed = { ...base, clips: [b, a] };
    for (const doc of [forward, reversed]) {
      const boundary = buildSnapIndex(doc, null, []).find(t => t.frame === 60 && t.kind === 'clip')!;
      expect(boundary.side).toBe('end');
      expect(boundary.clipId).toBe('a');
    }
  });
});

describe('snapFrame', () => {
  it('しきい値の内側で一番近い対象へ寄せる', () => {
    const targets = [{ frame: 100, kind: 'clip' as const, label: 'A' }, { frame: 140, kind: 'word' as const, label: 'B' }];
    expect(snapFrame(targets, 104, 6)).toEqual({ frame: 100, target: targets[0] });
    expect(snapFrame(targets, 120, 6)).toEqual({ frame: 120, target: null });
  });
  it('同じ距離なら先に来た対象を採る', () => {
    const targets = [{ frame: 100, kind: 'clip' as const, label: 'A' }, { frame: 110, kind: 'word' as const, label: 'B' }];
    expect(snapFrame(targets, 105, 6).target!.label).toBe('A');
  });
  it('同じ距離では push 順ではなく kind の優先順位で決める（playhead が clip より優先）', () => {
    const targets = [{ frame: 100, kind: 'clip' as const, label: 'A' }, { frame: 110, kind: 'playhead' as const, label: 'B' }];
    expect(snapFrame(targets, 105, 6).target!.kind).toBe('playhead');
  });
});

describe('targetDisplayBias', () => {
  // I2 fix-round-2: side だけを見て word の終わりにも 'before' を付けていた回帰の再発防止。
  // bias は kind==='clip' && side==='end' の時だけ 'before'、それ以外（word・gap・zero・playhead）
  // は side の値に関わらず常に 'after'。
  it('クリップの終わり端だけ before', () => {
    expect(targetDisplayBias({ frame: 10, kind: 'clip', label: 'A', side: 'end', clipId: 'a' })).toBe('before');
  });
  it('クリップの始まり端は after', () => {
    expect(targetDisplayBias({ frame: 10, kind: 'clip', label: 'A', side: 'start', clipId: 'a' })).toBe('after');
  });
  it('語の終わりターゲットに吸着したとき bias は after のまま（side だけでは before にならない）', () => {
    expect(targetDisplayBias({ frame: 10, kind: 'word', label: '「あ」の終わり', side: 'end' })).toBe('after');
  });
  it('語の始まりターゲットも after', () => {
    expect(targetDisplayBias({ frame: 10, kind: 'word', label: '「あ」の始まり', side: 'start' })).toBe('after');
  });
  it('side を持たない対象（zero・playhead・gap）は after', () => {
    expect(targetDisplayBias({ frame: 0, kind: 'zero', label: '先頭' })).toBe('after');
    expect(targetDisplayBias({ frame: 10, kind: 'playhead', label: '再生ヘッド' })).toBe('after');
    expect(targetDisplayBias({ frame: 10, kind: 'gap', label: '語間' })).toBe('after');
  });
});

describe('長尺での組み立て', () => {
  it('語 5,000・字幕 300 行でも index の組み立ては 1 回 200ms 未満', () => {
    const doc = spoken();
    doc.transcripts[0]!.words = Array.from({ length: 5000 }, (_, i) => ({ id: `w${i}`, text: `語${i}`, start: r(i, 100), end: r(i + 1, 100) }));
    const started = performance.now();
    const targets = buildSnapIndex(doc, 0, []);
    expect(performance.now() - started).toBeLessThan(200);
    // 同じ frame・同じ kind の重複を畳むようになった分、素の 10,000 語境界より実数は少ない。
    expect(targets.length).toBeGreaterThan(200);
  });
});
