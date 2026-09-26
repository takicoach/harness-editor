import { describe, expect, it } from 'vitest';
import type { EditorSe, EditorTelop, TranscriptWord } from '../../core/types';
import type { SequenceAsset, SequenceClip } from '../../core/sequence/model';
import { rational } from '../../core/sequence/time';
import { DEFAULT_MAIN_AUDIO } from '../../core/mainAudio';
import { diffNativeCuts, diffNativeSes, diffNativeTelops, finishKeptSpans, nearestText, SILENT_CUT_TEXT } from './nativeLearningRules';

const FPS = 30;
const clock = (frames: number) => ({ offset: rational(0), rate: rational(1), duration: rational(Math.max(1, frames)) });
function video(id: string, startFrame: number, durationFrames: number, sourceInFrames: number, assetId = 'main'): SequenceClip {
  return { id, trackId: 'v-main', name: '主映像', startFrame, durationFrames, clock: clock(durationFrames),
    content: { kind: 'video', assetId, streamIndex: 0, sourceIn: rational(sourceInFrames, FPS), rate: rational(1) } };
}
function telop(id: string, startFrame: number, durationFrames: number, text: string, extra: { legacyId?: number; group?: string } = {}): SequenceClip {
  return { id, trackId: 'v-telop-1', name: text, startFrame, durationFrames, clock: clock(durationFrames),
    ...(extra.group ? { continuationGroupId: extra.group } : {}),
    content: { kind: 'telop', data: { text }, ...(extra.legacyId !== undefined ? { legacyId: extra.legacyId } : {}) } };
}
function title(id: string, startFrame: number, text: string): SequenceClip {
  return { id, trackId: 'v-title-1', name: text, startFrame, durationFrames: 30, clock: clock(30),
    content: { kind: 'title', data: { text }, style: { top: 60, left: 30, fontSize: 36 } } };
}
function sound(id: string, startFrame: number, assetId: string, role: 'effect' | 'music', owner?: string): SequenceClip {
  return { id, trackId: role === 'effect' ? 'a-se-1' : 'a-bgm-1', name: assetId, startFrame, durationFrames: 10, clock: clock(10),
    ...(owner ? { legacyAudioContinuity: { version: 1 as const, sourceFingerprint: 'f'.repeat(64), ownerClipId: owner } } : {}),
    content: { kind: 'audio', assetId, streamIndex: 0, sourceIn: rational(0), rate: rational(1), role, settings: { ...DEFAULT_MAIN_AUDIO }, loop: role === 'music' } };
}
/** legacyAudioContinuity を持たず continuationGroupId だけで束ねられる SE（分割編集で断片化した人手追加 SE を模す）。 */
function soundInGroup(id: string, startFrame: number, assetId: string, group: string): SequenceClip {
  return { id, trackId: 'a-se-1', name: assetId, startFrame, durationFrames: 10, clock: clock(10), continuationGroupId: group,
    content: { kind: 'audio', assetId, streamIndex: 0, sourceIn: rational(0), rate: rational(1), role: 'effect', settings: { ...DEFAULT_MAIN_AUDIO }, loop: false } };
}
const legacyTelop = (id: number, originalStart: number, originalEnd: number, text: string): EditorTelop => ({ id, originalStart, originalEnd, text });
const legacySe = (id: number, originalStart: number, file: string): EditorSe => ({ id, originalStart, originalEnd: originalStart + 10, file });
const word = (text: string, start: number, end: number): TranscriptWord => ({ text, start, end });
const asset = (id: string, name: string): SequenceAsset => ({ id, kind: 'media', name, file: `public/se/${name}`, fingerprint: id, streams: [] });

describe('diffNativeCuts', () => {
  const base = { legacyCutRegions: [], durationFrames: 300, fps: FPS, primaryAssetId: 'main', words: [] as TranscriptWord[] };
  it('3 フレーム未満の差は捨て、3 フレームちょうどは候補にする', () => {
    const twoFrames = diffNativeCuts({ ...base, clips: [video('a', 0, 100, 0), video('b', 100, 198, 102)] });
    expect(twoFrames).toEqual([]);
    const threeFrames = diffNativeCuts({ ...base, clips: [video('a', 0, 100, 0), video('b', 100, 197, 103)] });
    expect(threeFrames.map((c) => [c.kind, c.startFrame, c.endFrame])).toEqual([['added-cut', 100, 103]]);
  });
  it('区間に完全に含まれる語だけをつなぎ、語が無ければ (無音)', () => {
    const words = [word('えー', 3400, 3700), word('はみ出す', 3700, 4000)];
    const cut = diffNativeCuts({ ...base, words, clips: [video('a', 0, 100, 0), video('b', 100, 185, 115)] });
    expect(cut).toEqual([{ kind: 'added-cut', startFrame: 100, endFrame: 115, startSec: 100 / FPS, endSec: 115 / FPS, text: 'えー' }]);
    const silent = diffNativeCuts({ ...base, clips: [video('a', 0, 100, 0), video('b', 100, 185, 115)] });
    expect(silent[0]!.text).toBe(SILENT_CUT_TEXT);
  });
  it('比較元の cutRegions が全体なら（空の cutData）、仕上げに残る範囲はすべて restored-cut', () => {
    const cut = diffNativeCuts({ ...base, legacyCutRegions: [{ start: 0, end: 300 }], clips: [video('a', 0, 300, 0)] });
    expect(cut.map((c) => [c.kind, c.startFrame, c.endFrame])).toEqual([['restored-cut', 0, 300]]);
  });
  it('主映像以外の video クリップは残す範囲に数えない', () => {
    const cut = diffNativeCuts({ ...base, clips: [video('a', 0, 300, 0), video('insert', 0, 300, 0, 'other')] });
    expect(cut).toEqual([]);
  });
});

describe('finishKeptSpans', () => {
  it('開始を先に丸め、その丸めた開始から終端を丸める（終端を直接丸めるのと結果が違う試料）', () => {
    // sourceIn(sec) = 17/150 → ×fps(30) = 3.4（丸めなければ非整数）。rate = 2/5 = 0.4、durationFrames = 11 → 11×0.4 = 4.4。
    // 正: start = round(3.4) = 3, end = round(3 + 4.4) = round(7.4) = 7 → [3, 7]
    // 誤（終端を直接丸める）: round(3.4 + 4.4) = round(7.8) = 8 → [3, 8]（このテストで弾く）
    const clip: SequenceClip = {
      id: 'a', trackId: 'v-main', name: '主映像', startFrame: 0, durationFrames: 11,
      clock: { offset: rational(0), rate: rational(1), duration: rational(11) },
      content: { kind: 'video', assetId: 'main', streamIndex: 0, sourceIn: rational(17, 150), rate: rational(2, 5) },
    };
    expect(finishKeptSpans([clip], 'main', FPS)).toEqual([[3, 7]]);
  });
});

describe('diffNativeTelops', () => {
  const base = { legacyFps: FPS, finishFps: FPS, archivedClips: [] as SequenceClip[] };
  const legacy = [legacyTelop(2, 60, 100, '長いアイアン')];
  it('分かれた断片で比較元と違う本文が1種類なら changed、2種類ならあいまいなので出さない', () => {
    const one = diffNativeTelops({ ...base, legacyTelops: legacy, clips: [
      telop('legacy-telop-2', 60, 15, '長いアイアン', { legacyId: 2, group: 'legacy-telop-2' }),
      telop('legacy-telop-2-part-1', 75, 15, '長いアイアンです', { legacyId: 2, group: 'legacy-telop-2' })] });
    expect(one).toEqual([{ kind: 'changed', before: '長いアイアン', after: '長いアイアンです', startFrame: 60, endFrame: 90, startSec: 2, endSec: 3 }]);
    const two = diffNativeTelops({ ...base, legacyTelops: legacy, clips: [
      telop('legacy-telop-2', 60, 15, 'A版', { legacyId: 2, group: 'legacy-telop-2' }),
      telop('legacy-telop-2-part-1', 75, 15, 'B版', { legacyId: 2, group: 'legacy-telop-2' })] });
    expect(two).toEqual([]);
  });
  it('本編に無く cutArchive に残るテロップは removed にしない。どちらにも無ければ removed（時刻は比較元）', () => {
    const archived = diffNativeTelops({ ...base, legacyTelops: legacy, clips: [], archivedClips: [telop('legacy-cut-1-legacy-telop-2', 0, 40, '長いアイアン', { legacyId: 2 })] });
    expect(archived).toEqual([]);
    const removed = diffNativeTelops({ ...base, legacyTelops: legacy, clips: [] });
    expect(removed).toEqual([{ kind: 'removed', before: '長いアイアン', after: '', startFrame: 60, endFrame: 100, startSec: 2, endSec: 100 / FPS }]);
  });
  it('legacyId の無いクリップは continuationGroupId ごとに1件の added（本文は重複なく時刻順）。title は数えない', () => {
    const added = diffNativeTelops({ ...base, legacyTelops: [], clips: [
      telop('user-2', 130, 10, '後半', { group: 'user-1' }), telop('user-1', 120, 10, '前半', { group: 'user-1' }),
      telop('user-3', 150, 10, '前半', { group: 'user-1' }), title('user-title', 0, '見出し')] });
    expect(added).toEqual([{ kind: 'added', before: '', after: '前半後半', startFrame: 120, endFrame: 160, startSec: 4, endSec: 160 / FPS }]);
  });
});

describe('nearestText', () => {
  it('含む字幕が無ければ最も近い字幕、同じ距離なら時刻が前の字幕', () => {
    const items = [{ startFrame: 20, endFrame: 30, text: '後' }, { startFrame: 0, endFrame: 10, text: '前' }];
    expect(nearestText(items, 25)).toBe('後');
    expect(nearestText(items, 15)).toBe('前');
    expect(nearestText([], 15)).toBe('');
  });
});

describe('diffNativeSes', () => {
  const base = { legacyFps: FPS, finishFps: FPS, archivedClips: [] as SequenceClip[], legacyTelops: [legacyTelop(1, 0, 60, 'ゆる素振り')],
    assets: [asset('se-pop', 'pop.mp3'), asset('se-whoosh', 'whoosh.mp3'), asset('bgm', 'bgm.mp3')] };
  it('持ち主が legacy-effect-N なら存続（断片・cutArchive を含む）。BGM は数えない', () => {
    const result = diffNativeSes({ ...base, legacySe: [legacySe(2, 30, 'pop.mp3'), legacySe(3, 40, 'pop.mp3')],
      clips: [sound('clip-9', 30, 'se-pop', 'effect', 'legacy-effect-2'), sound('user-bgm', 0, 'bgm', 'music')],
      archivedClips: [sound('legacy-cut-1-legacy-effect-3', 0, 'se-pop', 'effect', 'legacy-effect-3')] });
    expect(result).toEqual([]);
  });
  it('新しい持ち主は1回ずつ added（文脈は仕上げの字幕）、消えた比較元は removed（文脈は比較元の字幕）', () => {
    const result = diffNativeSes({ ...base, legacySe: [legacySe(1, 30, 'beep.mp3')], clips: [
      telop('legacy-telop-1', 0, 60, 'ゆるい素振り', { legacyId: 1 }),
      sound('user-effect-1', 40, 'se-whoosh', 'effect'), sound('user-effect-1-part', 50, 'se-whoosh', 'effect', 'user-effect-1')] });
    expect(result).toEqual([
      { kind: 'added', startFrame: 40, startSec: 40 / FPS, file: 'whoosh.mp3', nearbyText: 'ゆるい素振り' },
      { kind: 'removed', startFrame: 30, startSec: 1, file: 'beep.mp3', nearbyText: 'ゆる素振り' },
    ]);
  });
  it('legacyAudioContinuity を持たない SE は continuationGroupId ごとに1回だけ added', () => {
    const result = diffNativeSes({ ...base, legacySe: [], clips: [
      soundInGroup('user-effect-a', 40, 'se-whoosh', 'user-group-1'),
      soundInGroup('user-effect-a-part', 50, 'se-whoosh', 'user-group-1')] });
    expect(result).toEqual([{ kind: 'added', startFrame: 40, startSec: 40 / FPS, file: 'whoosh.mp3', nearbyText: '' }]);
  });
});
