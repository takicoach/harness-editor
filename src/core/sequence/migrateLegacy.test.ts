import { describe, expect, it } from 'vitest';
import type { EditorProject } from '../types';
import { DEFAULT_MAIN_LAYOUT } from '../mainLayout';
import {DEFAULT_COLOR_GRADE,normalizeColorWheels} from '../colorGrade';
import { effectiveLayoutAt } from '../segmentLayout';
import { edgeOverlayOpacityAt, joinOverlayOpacityAt } from '../transitionStyle';
import { buildPlaybackModel } from '../../preview/playbackModel';
import { migrateLegacySequence, type LegacyMigrationInput } from './migrateLegacy';
import { clipEnd, sourceTimeAt } from './model';
import { rational as r } from './time';
import { ScenePlan } from './scenePlan';
import { applySequenceCommand } from './commands';
import { validateSequenceDocument } from './validate';
import { createScriptDocument } from '../scriptDocumentData';

it('keeps the legacy script text, revision and passage IDs without regenerating them',()=>{
  const input=legacy();input.project.scriptDocument=createScriptDocument('残したい原文\nもう一つの文章',{documentId:'script',revision:'one'});
  const expected=structuredClone(input.project.scriptDocument),{document:doc}=migrateLegacySequence(input);
  expect(doc.scriptDocument).toEqual(expected);expect(doc.scriptDocument).not.toBe(input.project.scriptDocument);
});

function legacy(): LegacyMigrationInput {
  const project: EditorProject = {
    videoConfig: { fps: 30, durationFrames: 600, videoFile: 'main.mp4', format: 'youtube', orientation: 'landscape',
      resolution: { width: 1920, height: 1080 }, titleStyle: { top: 60, left: 30, fontSize: 36 }, telopBottomOffset: 80, telopFontSize: 72 },
    projectConfig: null, transcript: { durationMs: 20000, words: [{ text: '発話', start: 1000, end: 9000 }], segments: [] },
    telops: [{ id: 1, originalStart: 30, originalEnd: 300, text: '既存の字幕', template: 3, animation: 'none' }],
    cutRegions: [{ start: 180, end: 240 }], titles: [{ id: 1, originalStart: 0, originalEnd: 60, text: 'タイトル' }],
    images: [{ id: 1, originalStart: 30, originalEnd: 90, file: 'photo.png', type: 'photo', scale: .7 }],
    se: [{ id: 1, originalStart: 60, originalEnd: 90, file: 'click.wav', volume: .5 }],
    bgm: [{ id: 1, originalStart: 0, originalEnd: 600, file: 'music.wav', volume: .1, fadeInFrames: 15, fadeOutFrames: 30 }],
    videoInserts: [{ id: 1, originalStart: 300, originalEnd: 360, sourceInFrame: 30, file: 'insert.mp4', scale: .5 }],
    shapes: [{ id: 1, originalStart: 90, originalEnd: 120, kind: 'arrow', x1: .1, y1: .2, x2: .4, y2: .5, color: '#ff0000', thickness: 'medium' }],
    mainSpeed: 1, segmentSpeeds: {}, telopDataSource: 'original-caption-source', cutDataSource: 'original-cut-source', seDataSource: null,
    insertImageDataSource: null, titleDataSource: null,
  };
  return { id: 'migrated', name: '旧案件', sourceFingerprint: 'legacy-file-set-hash', project,
    assets: [
      { id: 'main', kind: 'media', name: '主素材', file: 'public/main.mp4', fingerprint: 'main-hash', streams: [
        { index: 0, kind: 'video', duration: r(20), codec: 'h264', width: 1920, height: 1080, frameRate: r(30) },
        { index: 1, kind: 'audio', duration: r(20), codec: 'aac', sampleRate: 48000, channels: 2 },
      ] },
      { id: 'photo', kind: 'image', name: '写真', file: 'public/images/photo.png', fingerprint: 'photo-hash', streams: [] },
      { id: 'renderer', kind: 'component', name: '字幕スタイル', file: '.harness/assets/caption.js', fingerprint: 'caption-hash', streams: [] },
      { id: 'image-renderer', kind: 'component', name: '画像スタイル', file: '.harness/assets/image.js', fingerprint: 'image-component-hash', streams: [] },
    ],
    bindings: { main: 'main', telopComponent: 'renderer', imageComponent: 'image-renderer', images: { 1: 'photo' }, videoInserts: { 1: 'main' }, bgm: { 1: 'main' }, se: { 1: 'main' } },
  };
}
describe('legacy project migration', () => {
  it('retains saved color wheels and main audio settings on every migrated main clip',()=>{
    const input=legacy();input.project.colorGrade={...DEFAULT_COLOR_GRADE,wheels:normalizeColorWheels({lift:{x:12,y:-24,level:18}})};
    input.project.mainAudio={gainDb:-8,muted:false,fadeInFrames:12,fadeOutFrames:18};input.project.mainSpeed=1.5;
    const {document}=migrateLegacySequence(input),main=document.clips.filter(clip=>clip.trackId==='v-main'),audio=document.clips.filter(clip=>clip.trackId==='a-main');
    expect(main.length).toBe(2);expect(audio.length).toBe(2);
    for(const clip of main){expect(clip.visual?.colorGrade).toEqual(input.project.colorGrade);expect(clip.content).toMatchObject({rate:r(3,2)});}
    for(const clip of audio)expect(clip.content).toMatchObject({settings:input.project.mainAudio,rate:r(3,2)});
    expect(new ScenePlan(document).frame(0).visuals.find(item=>item.clip.trackId==='v-main')!.clip.visual?.colorGrade).toEqual(input.project.colorGrade);
  });
  it('retains numeric component identities that determine legacy styling across cuts', () => {
    const input = legacy(); input.project.telops[0]!.id = 8;
    const { document } = migrateLegacySequence(input);
    const text = document.clips.filter(c => c.content.kind === 'telop');
    expect(text).toHaveLength(2);
    for (const item of text) expect(item.content).toMatchObject({ legacyId: 8 });
    const edited = applySequenceCommand(document, { type: 'split', clipIds: [text[0]!.id], frame: 90 });
    for (const item of edited.clips.filter(c => c.content.kind === 'telop')) expect(item.content).toMatchObject({ legacyId: 8 });
    expect(document.clips.find(c => c.content.kind === 'image')?.content).toMatchObject({ legacyId: 1 });
  });
  it('retains final timing, text/style, separate linked source audio and the immutable renderer binding', () => {
    const input = legacy(), original = structuredClone(input);
    const { document } = migrateLegacySequence(input);
    expect(input).toEqual(original);
    expect(document.sequenceEndFrame).toBe(540);
    expect(document.rendering).toEqual({ telopComponentAssetId: 'renderer', imageComponentAssetId: 'image-renderer', telopBottomOffset: 80, telopFontSize: 72 });
    const video = document.clips.find(c => c.id === 'legacy-video-2')!;
    const audio = document.clips.find(c => c.id === 'legacy-audio-2')!;
    expect(video.startFrame).toBe(180); expect(sourceTimeAt(video, 180, document.fps)).toEqual(r(8));
    expect(video.linkGroupId).toBe(audio.linkGroupId); expect(video.id).not.toBe(audio.id);
    const text = document.clips.filter(c => c.content.kind === 'telop');
    expect(text.map(c => [c.startFrame, clipEnd(c)])).toEqual([[30, 180], [180, 240]]);
    expect(text[1]!.clock).toEqual({ offset: r(150), rate: r(1), duration: r(210) });
    expect(text[1]!.anchor).toMatchObject({ clipOccurrenceId: audio.id, sourceStart: r(8), sourceEnd: r(10) });
    expect(text[0]!.content).toMatchObject({ data: { text: '既存の字幕', template: 3, animation: 'none' } });
    expect(document.clips.find(c => c.content.kind === 'image')!.content).toMatchObject({ style: 'photo' });
    expect(document.clips.find(c => c.id === 'legacy-insert-audio-1')!.content).toMatchObject({ settings: { muted: true } });
  });
  it('preserves independently placed tails without extending the old output end', () => {
    const input = legacy();
    input.project.bgm![0]!.timelinePlacement = { startFrame: 590, endFrame: 690 };
    input.project.telops[0]!.timelinePlacement = { startFrame: 610, endFrame: 650 };
    const { document } = migrateLegacySequence(input);
    expect(document.sequenceEndFrame).toBe(540);
    expect(document.clips.find(c => c.content.kind === 'telop')).toMatchObject({ startFrame: 610, durationFrames: 40, anchor: { kind: 'timeline' } });
    expect(document.clips.find(c => c.id === 'legacy-music-1')).toMatchObject({ startFrame: 590, durationFrames: 100 });
  });
  it('converts segment speeds into constant-rate clips while keeping the old final duration', () => {
    const input = legacy(); input.project.mainSpeed = 1.5; input.project.segmentSpeeds = { 2: 2 };
    const { document } = migrateLegacySequence(input);
    expect(document.sequenceEndFrame).toBe(300);
    expect(document.clips.find(c => c.id === 'legacy-video-1')).toMatchObject({ startFrame: 0, durationFrames: 120, content: { rate: r(3, 2) } });
    expect(document.clips.find(c => c.id === 'legacy-video-2')).toMatchObject({ startFrame: 120, durationFrames: 180, content: { rate: r(2) } });
  });
  it('retains the old layout interpolation inside and outside global keys, including segment motion', () => {
    const input = legacy();
    input.project.mainLayout = { ...DEFAULT_MAIN_LAYOUT, position: { x: .1, y: .2 } };
    input.project.segmentLayouts = { 1: { ...DEFAULT_MAIN_LAYOUT, position: { x: -.2, y: .1 }, scale: .8, flipH: true, motion: { preset: 'zoomIn' } } };
    input.project.layoutKeyframes = [
      { originalFrame: 60, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 150, x: .5, y: .2, scale: 2, rotation: 20 },
    ];
    const model = buildPlaybackModel(input.project), { document } = migrateLegacySequence(input), plan = new ScenePlan(document);
    for (const frame of [0, 30, 60, 90, 120, 150, 170, 200, 300]) {
      const old = effectiveLayoutAt(frame, model.keptSegments, input.project.mainLayout, input.project.segmentLayouts, false, input.project.layoutKeyframes);
      const next = plan.frame(frame).visuals.find(v => v.clip.trackId === 'v-main')!.transform;
      expect(next.x, `x at ${frame}`).toBeCloseTo(old.position.x, 12);
      expect(next.y, `y at ${frame}`).toBeCloseTo(old.position.y, 12);
      expect(next.scale, `scale at ${frame}`).toBeCloseTo(old.scale, 12);
      expect(next.rotation, `rotation at ${frame}`).toBeCloseTo(old.rotation, 12);
      expect(next.flipH, `flip at ${frame}`).toBe(old.flipH);
    }
  });
  it('preserves overlap positions without shortening the final sequence twice', () => {
    const input = legacy(); input.project.sceneTransitions = [{ id: 1, at: 180, kind: 'crossfade', durationFrames: 30 }];
    const { document } = migrateLegacySequence(input);
    expect(document.sequenceEndFrame).toBe(510);
    expect(document.clips.find(c => c.id === 'legacy-video-1')).toMatchObject({ startFrame: 0, durationFrames: 180 });
    expect(document.clips.find(c => c.id === 'legacy-video-2')).toMatchObject({ startFrame: 150, durationFrames: 360 });
    expect(document.transitions.find(t => t.trackId === 'v-main')).toMatchObject({ startFrame: 150, durationFrames: 30, outClipId: 'legacy-video-1', inClipId: 'legacy-video-2' });
    const plan = new ScenePlan(document);
    const a = document.clips.find(c => c.id === 'legacy-audio-1')!, b = document.clips.find(c => c.id === 'legacy-audio-2')!;
    expect(plan.audioGain(a, 160)).toBe(1); expect(plan.audioGain(b, 160)).toBe(1);
  });
  it('represents color/head/tail/join fades above every visual layer and protects their cut windows', () => {
    const input = legacy(); input.project.sceneTransitions = [
      { id: 1, at: 'head', kind: 'fadeWhite', durationFrames: 15 },
      { id: 2, at: 180, kind: 'fadeColor', color: '#ff3300', durationFrames: 31 },
      { id: 3, at: 'tail', kind: 'fadeBlack', durationFrames: 20 },
    ];
    const { document } = migrateLegacySequence(input), plan = new ScenePlan(document);
    for (const frame of [0, 7, 14, 165, 170, 180, 190, 195, 521, 530, 539]) {
      const actual = plan.frame(frame).visuals.filter(v => v.clip.content.kind === 'scene-fade');
      const expected = frame < 15 ? edgeOverlayOpacityAt(frame, 'head', 540, 15)
        : frame > 520 ? edgeOverlayOpacityAt(frame, 'tail', 540, 20) : joinOverlayOpacityAt(frame, 180, 31);
      expect(actual[0]?.transform.opacity ?? 0).toBeCloseTo(expected, 12);
      if (actual.length) expect(plan.frame(frame).visuals.at(-1)!.clip.content.kind).toBe('scene-fade');
    }
    expect(document.clips.find(c => c.id === 'legacy-scene-fade-2')!.content).toMatchObject({ color: '#ff3300', phase: 'join' });
    expect(() => applySequenceCommand(document, { type: 'ripple-delete', startFrame: 170, endFrame: 190 })).toThrow(/場面フェード/);
  });
  it('refuses to silently substitute another caption style when the managed component is missing', () => {
    const input = legacy(); delete input.bindings.telopComponent;
    expect(() => migrateLegacySequence(input)).toThrow(/素材が準備/);
  });
  it('requires the original image renderer and supports image-only projects', () => {
    const input = legacy(); input.project.telops = []; delete input.bindings.telopComponent;
    const { document } = migrateLegacySequence(input);
    expect(document.rendering?.imageComponentAssetId).toBe('image-renderer');
    expect(document.rendering?.telopComponentAssetId).toBeUndefined();
    delete input.bindings.imageComponent;
    expect(() => migrateLegacySequence(input)).toThrow(/素材が準備/);
  });
  it('preserves reordered source occurrences and allows the final partial source frame', () => {
    const input = legacy();
    input.project.cutOrder = [{ originalStart: 240, originalEnd: 600 }, { originalStart: 0, originalEnd: 180 }];
    input.assets[0]!.streams.forEach(s => { s.duration = r(1199, 60); });
    const { document } = migrateLegacySequence(input);
    const first = document.clips.find(c => c.content.kind === 'video' && c.trackId === 'v-main' && c.startFrame === 0)!;
    expect(sourceTimeAt(first, 0, document.fps)).toEqual(r(8));
    expect(first.content).not.toHaveProperty('endBehavior');
  });
  it('keeps global keyframe timing after a ripple cut, including speed-adjusted segments', () => {
    const input = legacy();
    input.project.mainSpeed = 1.5;
    input.project.layoutKeyframes = [
      { originalFrame: 30, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 290, x: .5, y: .2, scale: 2, rotation: 20 },
    ];
    const { document } = migrateLegacySequence(input), before = new ScenePlan(document);
    const edited = applySequenceCommand(document, { type: 'ripple-delete', startFrame: 40, endFrame: 60 });
    const after = new ScenePlan(edited);
    for (const frame of [40, 65, 99, 100, 120, 200]) {
      const old = before.frame(frame + 20).visuals.find(v => v.clip.trackId === 'v-main')!;
      const next = after.frame(frame).visuals.find(v => v.clip.trackId === 'v-main')!;
      expect(next.transform).toEqual(old.transform);
      expect(next.sourceTime).toEqual(old.sourceTime);
      expect(next.effectFrame).toEqual(old.effectFrame);
    }
  });
  it('records legacy overlong media windows explicitly without permitting a source start past EOF', () => {
    const input = legacy(); input.assets[0]!.streams.forEach(s => { s.duration = r(19); });
    const { document, notices } = migrateLegacySequence(input);
    expect(document.clips.find(c => c.id === 'legacy-video-2')!.content).toMatchObject({ endBehavior: 'hold' });
    expect(document.clips.find(c => c.id === 'legacy-audio-2')!.content).toMatchObject({ endBehavior: 'silence' });
    expect(notices.filter(n => n.includes('素材終端'))).toHaveLength(2);
    const invalid = structuredClone(document), content = invalid.clips.find(c => c.id === 'legacy-video-2')!.content;
    if (content.kind !== 'video') throw new Error('Expected video');
    content.sourceIn = r(19);
    expect(() => validateSequenceDocument(invalid)).toThrow(/開始位置/);
    content.sourceIn = r(8); delete content.endBehavior;
    expect(() => validateSequenceDocument(invalid)).toThrow(/終端/);
  });
});


it('allows only transient preview to omit missing main media while retaining other layers and the final clock', () => {
  const input = legacy(), originalProject = structuredClone(input.project);
  const secondary = {...input.assets[0]!,id:'secondary'};
  input.assets = [secondary,...input.assets.slice(1)]; input.bindings.main = '';
  input.bindings.videoInserts[1] = 'secondary'; input.bindings.bgm[1] = 'secondary'; input.bindings.se[1] = 'secondary';
  expect(() => migrateLegacySequence(input)).toThrow(/素材が準備/);
  const {document} = migrateLegacySequence({...input,allowMissingMain:true});
  expect(document.sequenceEndFrame).toBe(buildPlaybackModel(input.project).durationInFrames);
  expect(document.legacy).toBeUndefined(); expect(document.assets.some(asset => asset.id === 'main')).toBe(false);
  expect(document.clips.filter(clip => clip.trackId === 'v-main' || clip.trackId === 'a-main')).toEqual([]);
  for (const kind of ['telop','image','video','audio','shape','title']) expect(document.clips.some(clip => clip.content.kind === kind)).toBe(true);
  expect(document.clips.filter(clip => clip.content.kind === 'telop').every(clip => clip.anchor?.kind !== 'source')).toBe(true);
  expect(() => validateSequenceDocument(document)).not.toThrow(); expect(input.project).toEqual(originalProject);
  input.bindings.main = 'unknown'; expect(() => migrateLegacySequence({...input,allowMissingMain:true})).toThrow(/素材が準備/);
});
