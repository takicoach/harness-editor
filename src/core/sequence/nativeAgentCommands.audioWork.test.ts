import { expect, it } from 'vitest';
import { applyNativeAgentEdit } from './nativeAgentCommands';
import { validateSequenceDocument } from './validate';
import type { SequenceDocument } from './model';
import { rational as r } from './time';

/** 音声だけの作品（新規作成の形: 映像トラックなし）に、画像素材を1件登録した状態。 */
function audioWork(): SequenceDocument {
  return { schemaVersion: 2, id: 'doc', name: '音声', revision: 0, fps: r(30), resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 300, background: '#000000',
    assets: [
      { id: 'media-a', kind: 'media', name: 'talk.mp3', file: '.harness/assets/a.mp3', fingerprint: 'a'.repeat(64), streams: [{ index: 0, kind: 'audio', codec: 'mp3', duration: r(10), sampleRate: 44100, channels: 1 }] },
      { id: 'image-c', kind: 'image', name: 'cover.png', file: '.harness/assets/c.png', fingerprint: 'c'.repeat(64), streams: [] }],
    tracks: [{ id: 'a-main', name: '原音1', kind: 'audio', enabled: true }],
    clips: [{ id: 'speech', name: 'talk.mp3', trackId: 'a-main', startFrame: 0, durationFrames: 300, clock: { offset: r(0), rate: r(1), duration: r(300) },
      content: { kind: 'audio', assetId: 'media-a', streamIndex: 0, sourceIn: r(0), rate: r(1), role: 'speech', loop: false, endBehavior: 'silence', settings: { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 } } }],
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
const edit = (commands: unknown[]) => ({ documentId: 'doc', commands });

it('MCP（AI）: 映像トラックの追加 → 画像 → 字幕を1回の一括操作で置ける（設計 M2b）', () => {
  const next = applyNativeAgentEdit(audioWork(), edit([
    { type: 'add-track', track: { id: 'v-image', kind: 'visual', name: '映像1', enabled: true } },
    { type: 'add-track', track: { id: 'v-caption', kind: 'visual', name: '映像2', enabled: true } },
    { type: 'insert-media', kind: 'image', assetId: 'image-c', trackId: 'v-image', startFrame: 0, durationFrames: 300 },
    { type: 'insert-caption', trackId: 'v-caption', startFrame: 0, durationFrames: 90, text: 'ようこそ' },
  ]));
  validateSequenceDocument(next);
  expect(next.revision).toBe(1);
  expect(next.tracks.map((track) => track.id)).toEqual(expect.arrayContaining(['a-main', 'v-image', 'v-caption']));
  expect(next.clips.find((clip) => clip.trackId === 'v-image')!.content).toMatchObject({ kind: 'image', assetId: 'image-c', style: 'plain' });
  expect(next.clips.find((clip) => clip.trackId === 'v-caption')!.content).toMatchObject({ kind: 'telop', data: { text: 'ようこそ' } });
  expect(next.clips.find((clip) => clip.id === 'speech')).toEqual(audioWork().clips[0]);
});

it('映像トラックを足さずに字幕だけ置く操作は、理由つきで拒否する（自動では作らない）', () => {
  expect(() => applyNativeAgentEdit(audioWork(), edit([{ type: 'insert-caption', trackId: 'a-main', startFrame: 0, durationFrames: 30, text: 'x' }])))
    .toThrow('素材と配置先トラックの種類が一致しません');
});
