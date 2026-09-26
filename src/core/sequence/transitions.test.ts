import { describe, expect, it } from 'vitest';
import { applySequenceCommand } from './commands';
import { clipEnd, type SequenceDocument } from './model';
import { planTransition, transitionHandles, transitionJoins } from './transitions';
import { rational as r } from './time';
import { fixture } from './fixtures';

/** v1 に 2 本の映像（0..150 / 150..300）。素材は 60 秒あるので両側にハンドルがある。 */
function joined(): SequenceDocument {
  const doc = fixture();
  const first = doc.clips.find(c => c.id === 'video')!;
  first.durationFrames = 150; first.clock.duration = r(150);
  doc.clips.push({ ...structuredClone(first), id: 'video2', name: '映像2', startFrame: 150,
    linkGroupId: undefined, clock: { offset: r(0), rate: r(1), duration: r(150) },
    content: { kind: 'video', assetId: 'source', streamIndex: 0, sourceIn: r(20), rate: r(1) } });
  doc.clips = doc.clips.filter(c => c.id !== 'telop');
  return doc;
}
const KEY = 'join:v1:video:video2';

describe('transitionJoins', () => {
  it('隙間なしのつなぎ目を場面フェードと同じ鍵で返す', () => {
    expect(transitionJoins(joined()).map(j => j.joinKey)).toEqual([KEY]);
    expect(transitionJoins(joined())[0]!.frame).toBe(150);
  });
});

describe('transitionHandles', () => {
  it('未使用の元素材をフレーム数で返す', () => {
    const handles = transitionHandles(joined(), KEY);
    expect(handles.outHandle).toBe(30 * 60 - 150);   // 素材 60 秒 30fps − 使用済み 150fr
    expect(handles.inHandle).toBe(600);              // sourceIn 20 秒 ＝ 600fr
  });
  it('先頭から使っているクリップは入口ハンドルが 0', () => {
    const doc = joined();
    (doc.clips.find(c => c.id === 'video2')!.content as { sourceIn: unknown }).sourceIn = r(0);
    expect(transitionHandles(doc, KEY).inHandle).toBe(0);
  });
});

describe('planTransition', () => {
  it('つなぎ目を中心に重なりを割り振る', () => {
    const plan = planTransition(joined(), KEY, 'crossfade', 20);
    expect(plan).toMatchObject({ clamped: false });
    expect('transition' in plan && plan.transition).toMatchObject({
      trackId: 'v1', outClipId: 'video', inClipId: 'video2', kind: 'crossfade',
      startFrame: 140, durationFrames: 20, joinKey: KEY, joinFrame: 150, audioCurve: 'linear' });
  });
  it('片側のハンドルが足りなければもう片側へ寄せる', () => {
    const doc = joined();
    (doc.clips.find(c => c.id === 'video2')!.content as { sourceIn: unknown }).sourceIn = r(0);
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    expect('transition' in plan && plan.transition).toMatchObject({ startFrame: 150, durationFrames: 20 });
    expect(plan).toMatchObject({ clamped: false });
  });
  it('両側合わせても足りなければ使える最大長へ短縮する', () => {
    const doc = joined();
    const out = doc.clips.find(c => c.id === 'video')!;
    out.durationFrames = 30 * 60 - 2; out.clock.duration = r(out.durationFrames);
    doc.clips.find(c => c.id === 'video2')!.startFrame = out.durationFrames;
    (doc.clips.find(c => c.id === 'video2')!.content as { sourceIn: unknown }).sourceIn = r(0);
    doc.sequenceEndFrame = out.durationFrames + 150;
    const key = `join:v1:video:video2`;
    const plan = planTransition(doc, key, 'crossfade', 20);
    expect(plan).toMatchObject({ clamped: true });
    expect('transition' in plan && plan.transition.durationFrames).toBe(2);
  });
  it('両側ゼロなら付けられない', () => {
    const doc = joined();
    const out = doc.clips.find(c => c.id === 'video')!;
    out.durationFrames = 30 * 60; out.clock.duration = r(out.durationFrames);
    const incoming = doc.clips.find(c => c.id === 'video2')!;
    incoming.startFrame = out.durationFrames;
    (incoming.content as { sourceIn: unknown }).sourceIn = r(0);
    doc.sequenceEndFrame = out.durationFrames + 150;
    expect(planTransition(doc, `join:v1:video:video2`, 'crossfade', 20)).toEqual({ error: 'NO_HANDLES' });
  });
});

describe('set-transition', () => {
  it('全体尺を変えずに 2 クリップを重ね、他のクリップを動かさない', () => {
    const doc = joined();
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    const next = applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
    expect(next.sequenceEndFrame).toBe(doc.sequenceEndFrame);
    expect(next.transitions).toHaveLength(1);
    expect(clipEnd(next.clips.find(c => c.id === 'video')!)).toBe(160);
    expect(next.clips.find(c => c.id === 'video2')!.startFrame).toBe(140);
    expect(next.clips.find(c => c.id === 'music')).toEqual(doc.clips.find(c => c.id === 'music'));
  });
  it('解除すると元の隙間なし境界へ戻る', () => {
    const doc = joined();
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    const on = applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
    const off = applySequenceCommand(on, { type: 'set-transition', joinKey: KEY, transition: null });
    expect(off.transitions).toEqual([]);
    expect(off.clips).toEqual(doc.clips);
  });
  it('同じつなぎ目の場面フェードは置き換える', () => {
    const doc = joined();
    const faded = applySequenceCommand(doc, { type: 'set-scene-fades',
      targets: [{ kind: 'join', trackId: 'v1', outClipId: 'video', inClipId: 'video2' }], change: { enabled: true } });
    expect(faded.clips.some(c => c.content.kind === 'scene-fade')).toBe(true);
    const plan = planTransition(faded, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    const next = applySequenceCommand(faded, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
    expect(next.clips.some(c => c.content.kind === 'scene-fade')).toBe(false);
  });
  it('つなぎ目が見つからないときは拒否する', () => {
    expect(() => applySequenceCommand(joined(), { type: 'set-transition', joinKey: 'join:v1:video:missing', transition: null }))
      .toThrow('つなぎ目');
  });
});

/** つなぎ目を挟む 2 本の長さを変えた版。片側が短いときの割り振りを見る。 */
function joinedWith(outFrames: number, inFrames: number): SequenceDocument {
  const doc = joined();
  const out = doc.clips.find(c => c.id === 'video')!;
  out.durationFrames = outFrames; out.clock.duration = r(outFrames);
  const incoming = doc.clips.find(c => c.id === 'video2')!;
  incoming.startFrame = outFrames; incoming.durationFrames = inFrames; incoming.clock.duration = r(inFrames);
  return doc;
}
const videoShape = (doc: SequenceDocument) => doc.clips.filter(c => c.content.kind === 'video')
  .map(c => ({ id: c.id, startFrame: c.startFrame, durationFrames: c.durationFrames,
    sourceIn: c.content.kind === 'video' ? c.content.sourceIn : null, offset: c.clock.offset }));

describe('set-transition の置換', () => {
  it('同じ長さで付け直しても素材位置がずれない', () => {
    const doc = joined();
    const first = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in first)) throw new Error('plan');
    const once = applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: first.transition });
    const again = planTransition(once, KEY, 'crossfade', 20);
    if (!('transition' in again)) throw new Error('plan');
    const twice = applySequenceCommand(once, { type: 'set-transition', joinKey: KEY, transition: again.transition });
    expect(videoShape(twice)).toEqual(videoShape(once));
    expect(twice.transitions.map(t => ({ ...t, id: '' }))).toEqual(once.transitions.map(t => ({ ...t, id: '' })));
  });
});

describe('planTransition の片側上限', () => {
  it.each([[10, 150, 9, 21], [150, 10, 21, 9]])('短いクリップでも検証を通る配分にする（out %i / in %i）',
    (outFrames, inFrames, before, after) => {
      const doc = joinedWith(outFrames, inFrames);
      const plan = planTransition(doc, KEY, 'crossfade', 30);
      if (!('transition' in plan)) throw new Error('plan');
      expect([plan.before, plan.after]).toEqual([before, after]);
      const next = applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
      expect(next.transitions).toHaveLength(1);
    });
});

/** A[0,150) B[150,170) C[170,320)。隣り合う 2 つのつなぎ目を持つ。 */
function triple(): SequenceDocument {
  const doc = joined();
  const b = doc.clips.find(c => c.id === 'video2')!;
  b.durationFrames = 20; b.clock.duration = r(20);
  doc.clips.push({ ...structuredClone(b), id: 'video3', name: '映像3', startFrame: 170, durationFrames: 150,
    clock: { offset: r(0), rate: r(1), duration: r(150) },
    content: { kind: 'video', assetId: 'source', streamIndex: 0, sourceIn: r(20), rate: r(1) } });
  doc.sequenceEndFrame = 320;
  return doc;
}
const KEY2 = 'join:v1:video2:video3';

/** v2 にも 140fr で接する 2 本を置き、同じ帯をまたぐフェードを作れるようにする。 */
function twoTracks(): SequenceDocument {
  const doc = joined();
  const first = doc.clips.find(c => c.id === 'video')!;
  doc.clips.push({ ...structuredClone(first), id: 'videoB1', name: '映像B1', trackId: 'v2', startFrame: 0,
    durationFrames: 140, linkGroupId: undefined, clock: { offset: r(0), rate: r(1), duration: r(140) },
    content: { kind: 'video', assetId: 'source', streamIndex: 0, sourceIn: r(0), rate: r(1) } });
  doc.clips.push({ ...structuredClone(first), id: 'videoB2', name: '映像B2', trackId: 'v2', startFrame: 140,
    durationFrames: 160, linkGroupId: undefined, clock: { offset: r(0), rate: r(1), duration: r(160) },
    content: { kind: 'video', assetId: 'source', streamIndex: 0, sourceIn: r(20), rate: r(1) } });
  return doc;
}

/** A[0,150) B[150,155) C[155,300)。5fr のクリップを挟む。 */
function shortMiddle(): SequenceDocument {
  const doc = joined();
  const b = doc.clips.find(c => c.id === 'video2')!;
  b.durationFrames = 5; b.clock.duration = r(5);
  doc.clips.push({ ...structuredClone(b), id: 'video3', name: '映像3', startFrame: 155, durationFrames: 145,
    clock: { offset: r(0), rate: r(1), duration: r(145) },
    content: { kind: 'video', assetId: 'source', streamIndex: 0, sourceIn: r(25), rate: r(1) } });
  return doc;
}

/** 速度登録済み（主映像 2 本）。原音リンクは登録の対象外にするため外す。 */
function speedRegistered(): SequenceDocument {
  const doc = joined();
  for (const clip of doc.clips) delete clip.linkGroupId;
  return applySequenceCommand(doc, { type: 'register-native-speed', groupId: 'group',
    mainClipIds: ['video', 'video2'], mainAudioBindings: [] });
}

describe('planTransition の割り振り', () => {
  it('奇数の長さは出口側へ 1 フレーム多く配る', () => {
    const plan = planTransition(joined(), KEY, 'crossfade', 21);
    expect(plan).toMatchObject({ before: 10, after: 11, clamped: false });
    expect('transition' in plan && plan.transition).toMatchObject({ startFrame: 140, durationFrames: 21 });
  });
  it('ハンドルはあってもクリップが短ければ NO_HANDLES と区別する', () => {
    expect(planTransition(joinedWith(1, 1), KEY, 'crossfade', 20)).toEqual({ error: 'CLIPS_TOO_SHORT' });
  });
});

describe('transitionHandles の素材速度', () => {
  it('素材速度が 1 倍でないときは素材速度で換算する', () => {
    const doc = joined();
    for (const id of ['video', 'video2']) (doc.clips.find(c => c.id === id)!.content as { rate: unknown }).rate = r(2);
    expect(transitionHandles(doc, KEY)).toEqual({ outHandle: 750, inHandle: 300 });
  });
});

describe('隣接するつなぎ目', () => {
  it('隣の転換が使っているぶんを上限から差し引く', () => {
    const doc = triple();
    const first = planTransition(doc, KEY, 'crossfade', 30);
    if (!('transition' in first)) throw new Error('plan');
    const once = applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: first.transition });
    const second = planTransition(once, KEY2, 'crossfade', 30);
    if (!('transition' in second)) throw new Error('plan');
    expect([second.before, second.after]).toEqual([4, 26]);
    const twice = applySequenceCommand(once, { type: 'set-transition', joinKey: KEY2, transition: second.transition });
    expect(twice.transitions).toHaveLength(2);
    expect(clipEnd(twice.clips.find(c => c.id === 'video')!)).toBe(165);
    expect(twice.clips.find(c => c.id === 'video3')!.startFrame).toBe(166);
  });
});

describe('場面フェードの排他', () => {
  it('同じ帯をまたぐだけの別トラックのフェードは残す', () => {
    const doc = applySequenceCommand(twoTracks(), { type: 'set-scene-fades',
      targets: [{ kind: 'join', trackId: 'v2', outClipId: 'videoB1', inClipId: 'videoB2' }],
      change: { enabled: true, durationFrames: 30 } });
    const fade = doc.clips.find(c => c.content.kind === 'scene-fade')!;
    expect([fade.startFrame, clipEnd(fade)]).toEqual([125, 155]);   // 150 をまたぐが中点は 140
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    const next = applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
    expect(next.clips.some(c => c.id === fade.id)).toBe(true);
  });
  it('5fr クリップ越しに重なる隣のつなぎ目のフェードは残す', () => {
    const doc = applySequenceCommand(shortMiddle(), { type: 'set-scene-fades',
      targets: [{ kind: 'join', trackId: 'v1', outClipId: 'video2', inClipId: 'video3' }], change: { enabled: true } });
    const fade = doc.clips.find(c => c.content.kind === 'scene-fade')!;
    expect(fade.startFrame).toBeLessThanOrEqual(150);
    expect(clipEnd(fade)).toBeGreaterThanOrEqual(150);
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    const next = applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
    expect(next.clips.some(c => c.id === fade.id)).toBe(true);
  });
  it('外した結果あいた場面フェードのレーンは畳む', () => {
    const doc = joined();
    const faded = applySequenceCommand(doc, { type: 'set-scene-fades',
      targets: [{ kind: 'join', trackId: 'v1', outClipId: 'video', inClipId: 'video2' }], change: { enabled: true } });
    expect(faded.tracks).toHaveLength(doc.tracks.length + 1);
    const plan = planTransition(faded, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    const next = applySequenceCommand(faded, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
    expect(next.clips.some(c => c.content.kind === 'scene-fade')).toBe(false);
    expect(next.tracks.map(t => t.id)).toEqual(doc.tracks.map(t => t.id));
  });
});

describe('要求と転換の照合', () => {
  it('つなぎ目の記録が実際のつなぎ目と違えば拒否する', () => {
    const doc = joined();
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    expect(() => applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY,
      transition: { ...plan.transition, joinFrame: 151 } })).toThrow('一致しません');
    expect(() => applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY,
      transition: { ...plan.transition, joinKey: 'join:v1:video:video3' } })).toThrow('一致しません');
  });
  it('つなぎ目の記録がない転換は拒否する', () => {
    const doc = joined();
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    const { joinFrame: _unused, ...without } = plan.transition;
    expect(() => applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: without }))
      .toThrow('一致しません');
  });
});

describe('速度登録済みの文書', () => {
  it('転換の作成を明示的に拒否する', () => {
    const doc = speedRegistered();
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    expect(() => applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: plan.transition }))
      .toThrow('速度を設定した案件では転換を付けられません');
  });
});

/**
 * C1: 転換は `joinKey`（参照クリップ id）と `joinFrame`（重なりを作る前の境界）を持つ。
 * 構造編集（ripple-delete・split）がクリップを作り直しても、この 2 つが一緒に追従しないと
 * 解除が削除前の境界へ戻してしまい、切り替わる映像が変わる。
 */
describe('転換の境界情報と構造編集', () => {
  const cut = (doc: SequenceDocument) => applySequenceCommand(doc, { type: 'ripple-delete', startFrame: 10, endFrame: 40 });
  const lane = (doc: SequenceDocument) => doc.clips.filter(c => c.trackId === 'v1')
    .map(c => [c.name, c.startFrame, clipEnd(c)] as const).sort((a, b) => a[1] - b[1]);
  const applied = (doc: SequenceDocument) => {
    const plan = planTransition(doc, KEY, 'crossfade', 20);
    if (!('transition' in plan)) throw new Error('plan');
    return applySequenceCommand(doc, { type: 'set-transition', joinKey: KEY, transition: plan.transition });
  };

  it('転換の前を ripple-delete しても、解除は「転換を付けずに削除した場合」と同じ境界へ戻る', () => {
    const doc = joined();
    const trimmed = cut(applied(doc));
    const off = applySequenceCommand(trimmed, { type: 'set-transition', joinKey: trimmed.transitions[0]!.joinKey!, transition: null });
    const baseline = cut(doc);
    expect(off.sequenceEndFrame).toBe(baseline.sequenceEndFrame);
    expect(lane(off)).toEqual(lane(baseline));
  });

  it('転換の外で split しても、つなぎ目の鍵は新しいクリップを指し、解除できる', () => {
    const split = applySequenceCommand(applied(joined()), { type: 'split', clipIds: ['video'], frame: 50 });
    const transition = split.transitions[0]!;
    expect(transition.joinKey).toBe(`join:v1:${transition.outClipId}:${transition.inClipId}`);
    expect(split.clips.some(c => c.id === transition.outClipId)).toBe(true);
    const off = applySequenceCommand(split, { type: 'set-transition', joinKey: transition.joinKey!, transition: null });
    expect(off.transitions).toEqual([]);
    expect(off.clips.find(c => c.id === transition.inClipId)!.startFrame).toBe(150);
    expect(clipEnd(off.clips.find(c => c.id === transition.outClipId)!)).toBe(150);
  });

  it('つなぎ目の記録が編集内容と合わなければ、古い境界を使わず解除を拒否する', () => {
    const broken = structuredClone(applied(joined()));
    broken.transitions[0]!.joinFrame = 200;   // 重なりの窓（140..160）の外
    expect(() => applySequenceCommand(broken, { type: 'set-transition', joinKey: KEY, transition: null }))
      .toThrow('つなぎ目の記録');
  });

  /**
   * R3-M4: before===0（重なりが incoming 側だけに寄る）の転換で、流出クリップの頭を
   * ripple-delete すると joinFrame が out.startFrame まで縮み、以後その転換を一切
   * 解除できない書類ができてしまっていた（解除側の検算しかなく、書き込み側に対がなかった）。
   * rebuild は同じ不等式を先に検算し、構造編集の側を断らなければならない。
   */
  it('before===0 の転換で、joinFrame と out.startFrame が重なる ripple-delete は断る', () => {
    const doc = joined();
    (doc.clips.find(c => c.id === 'video2')!.content as { sourceIn: unknown }).sourceIn = r(0); // inHandle 0 → before===0
    const withTransition = applied(doc);
    expect(withTransition.transitions[0]).toMatchObject({ startFrame: 150, durationFrames: 20, joinFrame: 150 });
    // out（video、0..170）の頭 [140,150) を削ると、残り断片は 140 に置かれ、joinFrame も 140 へ縮む。
    expect(() => applySequenceCommand(withTransition, { type: 'ripple-delete', startFrame: 140, endFrame: 150 }))
      .toThrow('転換を含む範囲は先に転換を解除してください');
  });
  it('before===0 でも joinFrame と out.startFrame の間に 1fr でも残れば通す（回帰なし）', () => {
    const doc = joined();
    (doc.clips.find(c => c.id === 'video2')!.content as { sourceIn: unknown }).sourceIn = r(0);
    const withTransition = applied(doc);
    const cut = applySequenceCommand(withTransition, { type: 'ripple-delete', startFrame: 139, endFrame: 149 });
    const tr = cut.transitions[0]!;
    expect(tr.joinFrame).toBe(140);
    expect(cut.clips.find(c => c.id === tr.outClipId)!.startFrame).toBe(139);
  });
});
