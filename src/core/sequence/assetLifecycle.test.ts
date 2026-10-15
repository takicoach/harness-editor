import { describe, expect, it } from 'vitest';
import { applySequenceCommand } from './commands';
import { sequenceAssetReferences } from './assetReferences';
import { parseSequence, serializeSequence } from './validate';
import { rational as r } from './time';
import type { SequenceAsset, SequenceDocument } from './model';
import { fixture } from './fixtures';
import { SequenceSession } from './session';
import { SequenceError } from './errors';

/** 補正後の音声（原本とは別の不変 asset）。fingerprint は原本と必ず違う。 */
function fixedAudio(): SequenceAsset {
  return { id: 'source-denoised', kind: 'media', file: 'public/source-denoised.m4a', name: '映像（ノイズ除去）',
    fingerprint: 'test-source-denoised', origin: { kind: 'audio-fix', from: 'source', fix: 'denoise' },
    streams: [{ index: 1, kind: 'audio', codec: 'aac', duration: r(60), sampleRate: 48000, channels: 2 }] };
}
function withFixed(): SequenceDocument {
  const doc = fixture();
  doc.assets.push(fixedAudio());
  return doc;
}

describe('sequenceAssetReferences', () => {
  it('素材の使用箇所をクリップ・字幕の使用箇所・文字起こしまで列挙する', () => {
    const places = sequenceAssetReferences(fixture(), 'source').map(item => item.place);
    expect(places).toContain('clip-content');
    expect(places).toContain('clip-anchor');
    expect(sequenceAssetReferences(fixture(), 'source-denoised')).toEqual([]);
  });
});

/** 原本 →（ノイズ除去）→（音量正規化）。中間の素材はクリップからは参照されない。 */
function chained(): SequenceDocument {
  const doc = withFixed();
  doc.assets.push({ id: 'source-normalized', kind: 'media', file: 'public/source-normalized.m4a', name: '映像（音量正規化）',
    fingerprint: 'test-source-normalized', origin: { kind: 'audio-fix', from: 'source-denoised', fix: 'normalize' },
    streams: [{ index: 1, kind: 'audio', codec: 'aac', duration: r(60), sampleRate: 48000, channels: 2 }] });
  return doc;
}

describe('remove-asset', () => {
  it('C3: 補正の由来も参照として数え、系譜の中間にある素材を外させない', () => {
    const doc = chained();
    expect(sequenceAssetReferences(doc, 'source-denoised').map(item => item.place)).toEqual(['audio-fix-origin']);
    expect(() => applySequenceCommand(doc, { type: 'remove-asset', assetId: 'source-denoised' }))
      .toThrow('使っている素材は外せません');
    // 末端（誰の由来でもない）は従来どおり外せる。
    expect(applySequenceCommand(doc, { type: 'remove-asset', assetId: 'source-normalized' }).assets.map(a => a.id))
      .toEqual(['source', 'source-denoised']);
  });

  it('どこからも参照されていない素材だけを取り除く', () => {
    const doc = withFixed();
    const next = applySequenceCommand(doc, { type: 'remove-asset', assetId: 'source-denoised' });
    expect(next.assets.map(a => a.id)).toEqual(['source']);
    expect(next.clips).toEqual(doc.clips);
  });
  it('使用中の素材は使用箇所を示して拒否する', () => {
    const doc = withFixed();
    expect(() => applySequenceCommand(doc, { type: 'remove-asset', assetId: 'source' }))
      .toThrow('使っている素材は外せません');
    try { applySequenceCommand(doc, { type: 'remove-asset', assetId: 'source' }); }
    catch (error) { expect((error as { targets: string[] }).targets).toContain('video'); }
    expect(doc.assets).toHaveLength(2);
  });
  it('存在しない素材は拒否する', () => {
    expect(() => applySequenceCommand(fixture(), { type: 'remove-asset', assetId: 'missing' })).toThrow('素材');
  });
});

describe('replace-audio-source', () => {
  it('指定トラックの音声だけを新しい素材へ向け替え、原本は残す', () => {
    const doc = withFixed();
    const next = applySequenceCommand(doc, { type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source', toAssetId: 'source-denoised' });
    const audio = next.clips.find(c => c.id === 'audio')!;
    expect(audio.content.kind === 'audio' && audio.content.assetId).toBe('source-denoised');
    const music = next.clips.find(c => c.id === 'music')!;
    expect(music.content.kind === 'audio' && music.content.assetId).toBe('source');
    expect(next.assets.map(a => a.id)).toEqual(['source', 'source-denoised']);
  });
  it('字幕の使用箇所（anchor）と文字起こしの参照も同時に付け替える', () => {
    const doc = withFixed();
    doc.transcripts.push({ assetId: 'source', streamIndex: 1, words: [{ id: 'w1', text: 'あ', start: r(1), end: r(2) }] });
    const next = applySequenceCommand(doc, { type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source', toAssetId: 'source-denoised' });
    expect(next.clips.find(c => c.id === 'telop')!.anchor).toMatchObject({ sourceAssetId: 'source-denoised' });
    expect(next.transcripts[0]!.assetId).toBe('source-denoised');
  });
  it('元へ戻す向き替えも同じコマンドでできる（取り消し）', () => {
    const doc = withFixed();
    const fixed = applySequenceCommand(doc, { type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source', toAssetId: 'source-denoised' });
    const back = applySequenceCommand(fixed, { type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source-denoised', toAssetId: 'source' });
    expect(back.clips).toEqual(doc.clips);
    expect(back.transcripts).toEqual(doc.transcripts);
  });
  it('対応する音声ストリームが無い素材への向け替えは拒否し、文書を変えない', () => {
    const doc = withFixed();
    doc.assets[1]!.streams = [{ index: 7, kind: 'audio', codec: 'aac', duration: r(60), sampleRate: 48000, channels: 2 }];
    const before = structuredClone(doc);
    expect(() => applySequenceCommand(doc, { type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source', toAssetId: 'source-denoised' }))
      .toThrow('音声');
    expect(doc).toEqual(before);
  });
  it('使う長さが足りない素材への向け替えは拒否する', () => {
    const doc = withFixed();
    doc.assets[1]!.streams[0]!.duration = r(2);
    expect(() => applySequenceCommand(doc, { type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source', toAssetId: 'source-denoised' }))
      .toThrow('長さ');
  });
  // M7: 何も動かせなかった場合は無変化の成功ではなく拒否する（UI が「戻せませんでした」を出せるように）。
  it('指定トラックに fromAssetId の音声クリップが無ければ拒否する（無変化で成功にしない）', () => {
    const doc = withFixed();
    expect(() => applySequenceCommand(doc, { type: 'replace-audio-source', trackId: 'no-such-track', fromAssetId: 'source', toAssetId: 'source-denoised' }))
      .toThrow('見つかりません');
  });
});

describe('origin メタ', () => {
  it('保存して読み直しても由来が残る', () => {
    const doc = withFixed();
    expect(parseSequence(serializeSequence(doc)).assets[1]!.origin).toEqual({ kind: 'audio-fix', from: 'source', fix: 'denoise' });
  });
  it('不正な由来は読み込みで拒否する', () => {
    const doc = withFixed();
    (doc.assets[1] as { origin: unknown }).origin = { kind: 'audio-fix', from: 'source', fix: 'sharpen' };
    expect(() => parseSequence(serializeSequence(doc))).toThrow('由来');
  });
});

/**
 * 旧形式から移行した文書は、旧素材の名前の対応表（rendering.staticFiles）にすべての旧素材を載せる。
 * 使い手は旧テロップ・画像の部品の staticFile('se/beep.mp3') の解決と、旧カットの履歴の取り込み（名前が無ければ中身で探す退避路あり）。
 * 文書の検証は対応表の素材が assets にあることを求めるので、外す時は項目も一緒に外す。部品がその名前を読んでいれば外さない。
 */
describe('remove-asset（移行した文書の旧素材の名前の対応表）', () => {
  const effect: SequenceAsset = { id: 'se-beep', kind: 'media', file: '.harness/assets/' + 'b'.repeat(64) + '.mp3', name: 'beep.mp3', fingerprint: 'b'.repeat(64),
    streams: [{ index: 0, kind: 'audio', codec: 'mp3', duration: r(1), sampleRate: 48000, channels: 2 }] };
  const logo: SequenceAsset = { id: 'img-logo', kind: 'image', file: '.harness/assets/' + 'c'.repeat(64) + '.png', name: 'logo.png', fingerprint: 'c'.repeat(64), streams: [] };
  function migrated(): SequenceDocument {
    const doc = fixture();
    doc.assets.push(structuredClone(effect), structuredClone(logo));
    doc.rendering = { telopBottomOffset: null, telopFontSize: null, staticFiles: { 'main.mp4': 'source', 'se/beep.mp3': 'se-beep', 'images/logo.png': 'img-logo' } };
    doc.legacy = { sourceFingerprint: 'legacy', primaryAssetId: 'source', originalEndFrame: 300 };
    return doc;
  }
  const telopReading = (doc: SequenceDocument, value: string): SequenceDocument => {
    const telop = doc.clips.find(clip => clip.id === 'telop')!;
    if (telop.content.kind === 'telop') telop.content.data = { ...telop.content.data, image: value } as never;
    return doc;
  };

  it('使っていない旧素材は外せて、その素材を指す対応表の項目も一緒に消え、Undo で項目も戻る', () => {
    const session = new SequenceSession('s', migrated());
    session.execute({ sessionId: 's', executionId: 'remove', expectedRevision: session.document.revision, command: { type: 'remove-asset', assetId: 'se-beep' } });
    expect(session.document.assets.some(asset => asset.id === 'se-beep')).toBe(false);
    expect(session.document.rendering?.staticFiles).toEqual({ 'main.mp4': 'source', 'images/logo.png': 'img-logo' });
    expect(() => parseSequence(serializeSequence(session.document))).not.toThrow();
    session.execute({ sessionId: 's', executionId: 'undo', expectedRevision: session.document.revision, command: { type: 'undo' } });
    expect(session.document.rendering?.staticFiles).toEqual(migrated().rendering!.staticFiles);
    expect(session.document.assets.some(asset => asset.id === 'se-beep')).toBe(true);
  });

  it.each([['images/logo.png'], ['logo.png'], ['/static/images/logo.png?v=2']])('旧テロップ・画像の部品の props がその名前（%s）を持てば、外さずに使用中として止める', value => {
    const doc = telopReading(migrated(), value);
    const used = sequenceAssetReferences(doc, 'img-logo');
    expect(used).toEqual([expect.objectContaining({ place: 'legacy-static-file', clipId: 'telop', detail: expect.stringContaining('旧テロップ・画像の部品') })]);
    expect(() => applySequenceCommand(doc, { type: 'remove-asset', assetId: 'img-logo' })).toThrow(SequenceError);
    try { applySequenceCommand(doc, { type: 'remove-asset', assetId: 'img-logo' }); } catch (error) {
      expect(error).toMatchObject({ code: 'BROKEN_REFERENCE', message: expect.stringContaining('旧テロップ・画像の部品が「images/logo.png」を名前で読んでいます') });
    }
  });

  it('カットで退避したクリップの props が名前を持つ時も使用中として止める（戻すと部品が読むため）', () => {
    const doc = migrated();
    const telop = structuredClone(doc.clips.find(clip => clip.id === 'telop')!);
    if (telop.content.kind === 'telop') telop.content.data = { ...telop.content.data, sound: 'beep.mp3' } as never;
    doc.clips = doc.clips.filter(clip => clip.id !== 'telop');
    doc.cutArchive = { version: 1, entries: [{ id: 'e1', durationFrames: 1, completionFloorFrames: 1, origin: { cutId: 'cut', startFrame: 0, endFrame: 1 },
      boundary: { references: [], hintFrame: 0, ambiguous: false }, clips: [telop], tracks: [] }], groups: [] } as never;
    expect(sequenceAssetReferences(doc, 'se-beep').map(item => item.place)).toContain('legacy-static-file');
  });

  it('移行元の主映像は、クリップが無くても外さずに使用中として止める（対応表の項目も残る）', () => {
    const doc = migrated();
    doc.clips = doc.clips.filter(clip => !(clip.content.kind === 'video' || clip.content.kind === 'audio') || clip.content.assetId !== 'source');
    doc.clips = doc.clips.filter(clip => clip.anchor?.kind !== 'source');
    doc.transcripts = [];
    expect(sequenceAssetReferences(doc, 'source')).toEqual([expect.objectContaining({ place: 'legacy-primary' })]);
    expect(() => applySequenceCommand(doc, { type: 'remove-asset', assetId: 'source' })).toThrow(expect.objectContaining({ code: 'BROKEN_REFERENCE' }));
  });
});
