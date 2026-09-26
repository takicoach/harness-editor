import { describe, expect, it } from 'vitest';
import { captionWordChips } from './wordChips';
import { rational as r } from '../../core/sequence/time';
import { fixture } from '../../core/sequence/fixtures';

function spoken() {
  const doc = fixture();
  doc.transcripts.push({ assetId: 'source', streamIndex: 1, words: [
    { id: 'w1', text: 'ナイス', start: r(1), end: r(2) },
    { id: 'w2', text: 'ショット', start: r(2), end: r(3) },
    { id: 'w3', text: 'ですね', start: r(9), end: r(10) },
  ] });
  return doc;
}

describe('captionWordChips', () => {
  it('字幕の使用箇所に重なる語をタイムラインフレームで返す', () => {
    const doc = spoken();
    const chips = captionWordChips(doc, doc.clips.find(c => c.id === 'telop')!);
    expect(chips.map(c => c.text)).toEqual(['ナイス', 'ショット']);
    expect(chips[0]).toMatchObject({ startFrame: 30, endFrame: 60, cut: false });
  });
  it('使用箇所の外へ出た語は含めない', () => {
    const doc = spoken();
    expect(captionWordChips(doc, doc.clips.find(c => c.id === 'telop')!).some(c => c.text === 'ですね')).toBe(false);
  });
  it('使用箇所を持たない字幕（タイトル・手で書いた字幕）は空', () => {
    const doc = spoken();
    const clip = doc.clips.find(c => c.id === 'telop')!;
    delete clip.anchor;
    expect(captionWordChips(doc, clip)).toEqual([]);
  });
  it('カットで消えた語には印をつける', () => {
    const doc = spoken();
    const audio = doc.clips.find(c => c.id === 'audio')!;
    (audio.content as { sourceIn: unknown }).sourceIn = r(0);
    audio.durationFrames = 45;                       // 素材 0..1.5 秒だけ残る
    audio.clock.duration = r(45);
    const chips = captionWordChips(doc, doc.clips.find(c => c.id === 'telop')!);
    expect(chips.find(c => c.text === 'ショット')?.cut).toBe(true);
  });
  it('同一素材を2クリップで使っても対応元（anchor の provider）クリップの出現だけを拾う', () => {
    const doc = spoken();
    doc.tracks.push({ id: 'a3', kind: 'audio', name: '重複用', enabled: true });
    const audio = doc.clips.find(c => c.id === 'audio')!;
    // provider ではない別クリップ。word2「ショット」(2s) を sourceIn=2s・startFrame=45 で写すと
    // provider の正しい写像(frame 60)より小さい frame 45 になり、範囲内([30,270])かつ昇順ソートで先に来る。
    doc.clips.push({ ...structuredClone(audio), id: 'audio2', trackId: 'a3', startFrame: 45, durationFrames: 255,
      clock: { offset: r(0), rate: r(1), duration: r(255) },
      content: { ...structuredClone(audio.content), sourceIn: r(2) } as never });
    const chips = captionWordChips(doc, doc.clips.find(c => c.id === 'telop')!);
    // 対応元(audio, provider)基準の正しい写像なら 60。audio2 が混ざれば 45 になってしまう。
    expect(chips.find(c => c.text === 'ショット')).toMatchObject({ startFrame: 60, endFrame: 90, cut: false });
  });
  it('単語の終端がクリップの終端と一致する境界も含める', () => {
    const doc = spoken();
    doc.transcripts[0]!.words.push({ id: 'w4', text: 'まで', start: r(89, 10), end: r(9) }); // 8.9s..9s → frame 267..270（telopの終端）
    const chips = captionWordChips(doc, doc.clips.find(c => c.id === 'telop')!);
    expect(chips.find(c => c.text === 'まで')).toMatchObject({ startFrame: 267, endFrame: 270, cut: false });
  });
});
