import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSequenceProject } from './create';
import { SequenceService } from './service';
import { SequenceStore } from './store';
import { DEFAULT_TEXT_APPEARANCE, type SequenceClip } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';
import type { EditRequest } from '../../core/sequence/session';
import { makeMediaSamples, type MediaSamples } from './__fixtures__/mediaSamples';

let samples: MediaSamples, root: string;
beforeAll(async () => {
  samples = makeMediaSamples(await mkdtemp(join(tmpdir(), 'audio-work-samples-')));
  root = await mkdtemp(join(await realpath(tmpdir()), 'audio-work-root-'));
}, 30_000);
afterAll(async () => { await rm(samples.dir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });

/**
 * 音声の作品で、動画の原音と同じ編集の流れが通ること（設計 テスト方針（第2版）の音声の前半。書き出しは e2e で確かめる）。
 * 文字起こし本体の代わりに、試料の結果（2語）を set-transcript で適用する。
 */
it('音声の作品: 文字起こしの結果を適用 → 言葉を選んでカット → 復元・Undo → 字幕を追加 → 保存・再読み込み', async () => {
  const { id } = await createSequenceProject(root, { name: 'podcast', videoName: 'talk.wav', sourcePath: samples.wav });
  const directory = join(root, id), service = new SequenceService();
  let state = service.open(directory);
  const run = (command: EditRequest['command']) => { state = service.execute(directory, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), command }); return state; };
  const speech = state.document.clips[0]!, asset = state.document.assets[0]!;
  expect(speech.content).toMatchObject({ kind: 'audio', role: 'speech' });
  const content = speech.content as Extract<SequenceClip['content'], { kind: 'audio' }>;

  run({ type: 'set-transcript', before: null, assetFingerprint: asset.fingerprint, transcript: { assetId: asset.id, streamIndex: content.streamIndex,
    words: [{ id: 'w1', text: 'こんにちは', start: r(0), end: r(1) }, { id: 'w2', text: 'ポッドキャストです', start: r(1), end: r(2) }] } });
  expect(state.document.transcripts[0]!.words.map((word) => word.text)).toEqual(['こんにちは', 'ポッドキャストです']);

  // 1語目（0〜1秒 = 0〜30コマ）を選んでカット（画面の「カット」と同じ ripple-delete）。
  run({ type: 'ripple-delete', startFrame: 0, endFrame: 30 });
  expect(state.document.sequenceEndFrame).toBe(30);
  const entry = state.document.cutArchive!.entries[0]!;
  expect(state.document.clips.find((clip) => clip.content.kind === 'audio')!.content).toMatchObject({ sourceIn: r(1) });

  run({ type: 'restore-cut', entryId: entry.id });
  expect(state.document.sequenceEndFrame).toBe(60);
  run({ type: 'undo' });
  expect(state.document.sequenceEndFrame).toBe(30);

  // 字幕を追加（映像トラックは字幕を置く時に作る）。
  const caption: SequenceClip = { id: 'caption-1', name: 'テキスト', trackId: 'captions', startFrame: 0, durationFrames: 30, clock: { offset: r(0), rate: r(1), duration: r(30) },
    anchor: { kind: 'timeline' }, content: { kind: 'telop', data: { text: 'ポッドキャストです', animation: 'none', manual: true, position: { x: 0, y: -0.5 } }, textMode: 'free', appearance: { ...DEFAULT_TEXT_APPEARANCE } } };
  run({ type: 'batch', commands: [{ type: 'add-track', track: { id: 'captions', name: '映像1', kind: 'visual', enabled: true } }, { type: 'insert', clips: [caption] }] });
  expect(state.document.tracks.map((track) => track.kind).sort()).toEqual(['audio', 'visual']);

  state = service.save(directory, { sessionId: state.sessionId, expectedRevision: state.document.revision, expectedSavedRevision: state.savedRevision, executionId: crypto.randomUUID() });
  const reloaded = new SequenceStore(directory).load()!.document;
  expect(reloaded.sequenceEndFrame).toBe(30);
  expect(reloaded.transcripts[0]!.words).toHaveLength(2);
  expect(reloaded.clips.filter((clip) => clip.content.kind === 'telop').map((clip) => clip.content.kind === 'telop' && clip.content.data.text)).toEqual(['ポッドキャストです']);
  expect(new SequenceService().open(directory).document).toEqual(reloaded);
});
