import type { EditorProject, MainLayout, SceneTransitionKind } from '../types';
import { DEFAULT_MAIN_LAYOUT } from '../mainLayout';
import { DEFAULT_MAIN_AUDIO, normalizeMainAudioSettings } from '../mainAudio';
import { resolveSegmentLayout } from '../segmentLayout';
import { overlayColorFor } from '../transitionStyle';
import { playbackToFinal } from '../transitionEngine';
// This legacy module is pure data logic despite living in preview/. It is used only
// at the legacy migration/draft projection boundary: neither ScenePlan nor a v2
// export may call it or read legacy files.
import { buildLegacyMainTimeline } from './legacyMainTimeline';
import { clipEnd, effectFrameAt, isMediaContent, sourceTimeAt, type SequenceAsset, type SequenceClip, type SequenceDocument, type TransitionKind } from './model';
import { compareTime, divideTime, frameSeconds, rational, rationalFromDecimal, timeNumber } from './time';
import { validateSequenceDocument } from './validate';
import { SequenceError } from './errors';

export interface LegacyAssetBindings {
  main: string;
  /** A managed, immutable bundle of the actual project's caption renderer. */
  telopComponent?: string;
  imageComponent?: string;
  images: Record<number, string>;
  videoInserts: Record<number, string>;
  bgm: Record<number, string>;
  se: Record<number, string>;
}
export interface LegacyMigrationInput {
  /** Only a transient preview may render other layers while main media is absent. */
  allowMissingMain?: boolean;
  id: string;
  name: string;
  project: EditorProject;
  assets: SequenceAsset[];
  bindings: LegacyAssetBindings;
  sourceFingerprint: string;
}
export interface LegacyMigrationResult {
  document: SequenceDocument;
  notices: string[];
}
const overlapKind = (kind: SceneTransitionKind, direction = 'left'): TransitionKind => {
  if (kind === 'crossfade') return 'crossfade';
  if (kind !== 'wipe' && kind !== 'slide') throw new Error('Not an overlapping transition');
  return `${kind}${direction[0]!.toUpperCase()}${direction.slice(1)}` as TransitionKind;
};

/** Converts the current visible edit once, retaining source files and renderer assets. */
export function migrateLegacySequence(input: LegacyMigrationInput): LegacyMigrationResult {
  const project = input.project, timeline = buildLegacyMainTimeline(project), model = timeline.model, notices: string[] = [];
  const fps = rationalFromDecimal(project.videoConfig.fps);
  const byId = new Map(input.assets.map(a => [a.id, a]));
  const asset = (id: string | undefined, kind: SequenceAsset['kind']): SequenceAsset => {
    const found = id ? byId.get(id) : undefined;
    if (!found || found.kind !== kind) throw new SequenceError('MISSING_TARGET', '移行に必要な素材が準備されていません', id ? [id] : []);
    return found;
  };
  const main = input.allowMissingMain && input.bindings.main === '' ? null : asset(input.bindings.main, 'media');
  const mainVideo = main?.streams.find(s => s.kind === 'video'), mainAudio = main?.streams.find(s => s.kind === 'audio');
  if (main && !mainVideo) throw new SequenceError('MISSING_TARGET', '主映像のストリームがありません', [main.id]);
  const document: SequenceDocument = {
    schemaVersion: 2, id: input.id, name: input.name, revision: 0, fps, resolution: { ...project.videoConfig.resolution },
    sequenceEndFrame: model.durationInFrames, background: project.mainLayout?.background ?? '#000000',
    assets: structuredClone(input.assets), tracks: [{ id: 'v-main', kind: 'visual', name: '映像1', enabled: true }], clips: [], transitions: [], transcripts: [],
    ducking: structuredClone(project.ducking ?? { enabled: false, strength: 'mid' }),
    ...(project.scriptDocument ? {scriptDocument:structuredClone(project.scriptDocument)} : {}),
    ...(main ? {legacy: { sourceFingerprint: input.sourceFingerprint, primaryAssetId: main.id, originalEndFrame: model.durationInFrames }} : {}),
  };
  if (model.telops.length || model.images.length) {
    document.rendering = { telopBottomOffset: model.telopBottomOffset, telopFontSize: project.videoConfig.telopFontSize ?? null };
    if (model.telops.length) document.rendering.telopComponentAssetId = asset(input.bindings.telopComponent, 'component').id;
    if (model.images.length) document.rendering.imageComponentAssetId = asset(input.bindings.imageComponent, 'component').id;
  }
  const clock = (duration: number, offset = 0) => ({ offset: rationalFromDecimal(offset), rate: rational(1), duration: rational(Math.max(1, duration)) });
  const visual = (layout: MainLayout = DEFAULT_MAIN_LAYOUT, opacity = 1): NonNullable<SequenceClip['visual']> => ({ layout: structuredClone(layout), opacity, keyframes: [] });
  const setEndBehavior = (clip: SequenceClip): void => {
    if (!isMediaContent(clip.content) || (clip.content.kind === 'audio' && clip.content.loop)) return;
    const content = clip.content;
    const stream = byId.get(content.assetId)!.streams.find(s => s.index === content.streamIndex)!;
    if (compareTime(sourceTimeAt(clip, clipEnd(clip) - 1, fps), stream.duration) >= 0) {
      if (clip.content.kind === 'video') clip.content.endBehavior = 'hold';
      else clip.content.endBehavior = 'silence';
      notices.push(`${clip.name}: 旧表示窓の素材終端以降の扱いを明示して引き継ぎました`);
    }
  };
  const append = (clip: SequenceClip) => { setEndBehavior(clip); document.clips.push(clip); };
  // Allocate as few lanes as possible while retaining the old array's stacking order.
  const appendGroup = (clips: SequenceClip[], prefix: string, label: string, kind: 'visual' | 'audio') => {
    const lanes: SequenceClip[][] = [];
    for (const clip of clips) {
      let minimum = 0;
      for (const [index, lane] of lanes.entries()) if (lane.some(previous => clip.startFrame < clipEnd(previous) && previous.startFrame < clipEnd(clip))) minimum = index + 1;
      let index = minimum;
      while (lanes[index]?.some(previous => clip.startFrame < clipEnd(previous) && previous.startFrame < clipEnd(clip))) index++;
      if (!lanes[index]) {
        lanes[index] = [];
        document.tracks.push({ id: `${prefix}-${index + 1}`, name: `${label}${index + 1}`, kind, enabled: true });
      }
      clip.trackId = `${prefix}-${index + 1}`; lanes[index]!.push(clip); append(clip);
    }
  };

  const originalAudio: SequenceClip[] = [];
  let previousVideo: SequenceClip | undefined, previousAudio: SequenceClip | undefined;
  if (mainAudio) document.tracks.push({ id: 'a-main', kind: 'audio', name: '原音1', enabled: true });
  if (main && mainVideo) for (const entry of timeline.entries) {
    const {segment,startFrame:start,durationFrames:duration,transition:pending}=entry;
    const rate = rationalFromDecimal(project.segmentSpeeds[segment.id] ?? project.mainSpeed);
    const hasKeys = !model.overlaps.length && (project.layoutKeyframes?.length ?? 0) >= 2;
    const layout = model.overlaps.length ? project.mainLayout ?? DEFAULT_MAIN_LAYOUT
      : resolveSegmentLayout(project.mainLayout ?? DEFAULT_MAIN_LAYOUT, project.segmentLayouts ?? {}, segment.id);
    const appearance = visual(layout);
    appearance.colorGrade = project.colorGrade;
    if (hasKeys) {
      appearance.keyframes = project.layoutKeyframes!.map(k => ({ frame: rational(k.originalFrame), easing: 'easeInOut',
        value: { position: { x: k.x, y: k.y }, scale: k.scale, rotation: k.rotation,
          flipH: project.mainLayout?.flipH ?? false, flipV: project.mainLayout?.flipV ?? false } }));
      appearance.keyframeClock = clock(project.videoConfig.durationFrames, segment.originalStart);
      appearance.keyframesOutside = 'base';
    }
    if (!model.overlaps.length) appearance.motion = project.segmentLayouts?.[segment.id]?.motion;
    const video: SequenceClip = { id: `legacy-video-${segment.id}`, trackId: 'v-main', name: '主映像', startFrame: start, durationFrames: duration,
      clock: clock(duration), visual: appearance,
      content: { kind: 'video', assetId: main.id, streamIndex: mainVideo.index, sourceIn: frameSeconds(segment.originalStart, fps), rate } };
    let audio: SequenceClip | undefined;
    if (mainAudio) {
      video.linkGroupId = `legacy-main-link-${segment.id}`;
      audio = { id: `legacy-audio-${segment.id}`, trackId: 'a-main', name: '原音', startFrame: start, durationFrames: duration,
        linkGroupId: video.linkGroupId, clock: clock(model.durationInFrames, start), content: {
          kind: 'audio', assetId: main.id, streamIndex: mainAudio.index, sourceIn: frameSeconds(segment.originalStart, fps), rate,
          role: 'speech', settings: normalizeMainAudioSettings(project.mainAudio ?? DEFAULT_MAIN_AUDIO), loop: false,
        } };
      originalAudio.push(audio); append(audio);
    }
    append(video);
    if (pending && previousVideo) {
      const kind = overlapKind(pending.kind, pending.direction);
      document.transitions.push({ id: `legacy-join-v-${segment.id}`, kind, trackId: 'v-main', startFrame: start,
        durationFrames: pending.overlap, outClipId: previousVideo.id, inClipId: video.id });
      if (audio && previousAudio) document.transitions.push({ id: `legacy-join-a-${segment.id}`, kind: 'crossfade', trackId: 'a-main', startFrame: start,
        durationFrames: pending.overlap, outClipId: previousAudio.id, inClipId: audio.id, audioCurve: 'none' });
    }
    previousVideo = video; previousAudio = audio;
  }
  if (main && mainAudio) document.transcripts.push({ assetId: main.id, streamIndex: mainAudio.index, words: project.transcript.words.flatMap((word, index) => {
    const start = divideTime(rationalFromDecimal(word.start), rational(1000));
    const rawEnd = divideTime(rationalFromDecimal(word.end), rational(1000));
    const end = compareTime(rawEnd, mainAudio.duration) > 0 ? mainAudio.duration : rawEnd;
    return compareTime(start, end) < 0 ? [{ id: `word-${index}`, text: word.text, start, end }] : [];
  }) });

  appendGroup(model.images.map(image => {
    const source = asset(input.bindings.images[image.id], 'image');
    return { id: `legacy-image-${image.id}`, name: source.name, trackId: '', startFrame: image.playbackStart, durationFrames: image.playbackEnd - image.playbackStart,
      clock: clock(image.playbackEnd - image.playbackStart), content: { kind: 'image' as const, assetId: source.id, style: image.type, legacyId: image.id },
      visual: { ...visual({ ...DEFAULT_MAIN_LAYOUT, position: image.position ?? { x: 0, y: 0 }, scale: image.scale, rotation: image.rotation ?? 0 }, image.opacity ?? 1),
        motion: image.motion, enter: image.enter, exit: image.exit } };
  }).filter(c => c.durationFrames > 0), 'v-image', '画像', 'visual');

  const inserts: SequenceClip[] = [], insertAudio: SequenceClip[] = [];
  for (const insert of model.videoInserts) {
    if (insert.playbackEnd <= insert.playbackStart) continue;
    const source = asset(input.bindings.videoInserts[insert.id], 'media'), stream = source.streams.find(s => s.kind === 'video');
    if (!stream) throw new SequenceError('MISSING_TARGET', '挿入映像に映像ストリームがありません', [source.id]);
    const video: SequenceClip = { id: `legacy-insert-${insert.id}`, name: source.name, trackId: '', startFrame: insert.playbackStart,
      durationFrames: insert.playbackEnd - insert.playbackStart, clock: clock(insert.playbackEnd - insert.playbackStart),
      content: { kind: 'video', assetId: source.id, streamIndex: stream.index, sourceIn: frameSeconds(insert.sourceInFrame, fps), rate: rationalFromDecimal(insert.playbackRate ?? 1) },
      visual: { ...visual({ ...DEFAULT_MAIN_LAYOUT, position: insert.position ?? { x: 0, y: 0 }, scale: insert.scale }),
        colorGrade: project.colorGrade, enter: insert.enter, exit: insert.exit } };
    const sound = source.streams.find(s => s.kind === 'audio');
    if (sound && video.content.kind === 'video') {
      video.linkGroupId = `legacy-insert-link-${insert.id}`;
      insertAudio.push({ ...structuredClone(video), id: `legacy-insert-audio-${insert.id}`, visual: undefined,
        content: { ...video.content, kind: 'audio', streamIndex: sound.index, role: 'speech', loop: false, endBehavior: undefined,
          settings: { ...DEFAULT_MAIN_AUDIO, muted: true } } });
    }
    inserts.push(video);
  }
  appendGroup(inserts, 'v-insert', '挿入映像', 'visual');
  appendGroup(insertAudio, 'a-insert', '挿入原音', 'audio');
  appendGroup(model.shapes.map(shape => {
    const { id, startFrame, endFrame, ...data } = shape;
    return { id: `legacy-shape-${id}`, name: '図形', trackId: '', startFrame, durationFrames: endFrame - startFrame,
      clock: clock(endFrame - startFrame), content: { kind: 'shape' as const, data } };
  }), 'v-shape', '図形', 'visual');

  const subtitles: SequenceClip[] = [];
  for (const telop of model.telops) {
    const { id, startFrame, endFrame, originalStart: _originalStart, originalEnd: _originalEnd, ...data } = telop;
    if (endFrame <= startFrame) continue;
    const original = project.telops.find(t => t.id === id)!;
    const base: SequenceClip = { id: `legacy-telop-${id}`, name: data.text || '字幕', trackId: '', startFrame, durationFrames: endFrame - startFrame,
      clock: clock(endFrame - startFrame), content: { kind: 'telop', data, legacyId: id }, anchor: { kind: 'timeline' } };
    if (original.timelinePlacement || original.manual || !originalAudio.length) { subtitles.push(base); continue; }
    const boundaries = [...new Set([startFrame, endFrame, ...originalAudio.flatMap(c => [c.startFrame, clipEnd(c)]).filter(f => f > startFrame && f < endFrame)])].sort((a, b) => a - b);
    let pieceIndex = 0;
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i]!, to = boundaries[i + 1]!;
      const providers = originalAudio.filter(c => c.startFrame <= from && clipEnd(c) >= to);
      const matching = providers.find(c => {
        const at = timeNumber(sourceTimeAt(c, from, fps)) * timeNumber(fps);
        return at >= original.originalStart - 1 && at < original.originalEnd;
      });
      const part = structuredClone(base);
      part.id = pieceIndex ? `${base.id}-part-${pieceIndex}` : base.id;
      part.startFrame = from; part.durationFrames = to - from; part.clock.offset = effectFrameAt(base, from);
      if (boundaries.length > 2) part.continuationGroupId = base.id;
      if (matching && main) part.anchor = { kind: 'source', role: 'speech', sourceAssetId: main.id, clipOccurrenceId: matching.id,
        sourceStart: sourceTimeAt(matching, from, fps), sourceEnd: sourceTimeAt(matching, to, fps) };
      else notices.push(`${base.name}: 旧表示位置を保つため、この断片は完成タイムラインに固定しました`);
      subtitles.push(part); pieceIndex++;
    }
  }
  appendGroup(subtitles, 'v-telop', '字幕', 'visual');
  appendGroup(model.titles.filter(t => t.endFrame > t.startFrame).map(title => ({
    id: `legacy-title-${title.id}`, name: title.text || 'タイトル', trackId: '', startFrame: title.startFrame, durationFrames: title.endFrame - title.startFrame,
    clock: clock(title.endFrame - title.startFrame), content: { kind: 'title' as const, data: { text: title.text }, style: { ...model.titleStyle }, legacyId: title.id }, anchor: { kind: 'timeline' as const },
  })), 'v-title', 'タイトル', 'visual');

  const fades: SequenceClip[] = [];
  for (const transition of model.sceneTransitions) {
    const color = overlayColorFor(transition.kind, transition.color);
    if (color === null || transition.durationFrames <= 0) continue;
    const phase = transition.at === 'head' || transition.at === 'tail' ? transition.at : 'join';
    const join = typeof transition.at === 'number' ? model.joins.find(j => j.atOriginal === transition.at) : undefined;
    if (phase === 'join' && !join) continue;
    const start = phase === 'head' ? 0 : phase === 'tail' ? model.durationInFrames - transition.durationFrames
      : playbackToFinal(join!.playbackFrame, model.overlaps) - transition.durationFrames / 2;
    const clippedStart = Math.max(0, Math.ceil(start)), end = Math.ceil(start + transition.durationFrames);
    if (end <= clippedStart) continue;
    fades.push({ id: `legacy-scene-fade-${transition.id}`, name: '場面フェード', trackId: '', startFrame: clippedStart, durationFrames: end - clippedStart,
      clock: clock(transition.durationFrames, clippedStart - start), content: { kind: 'scene-fade', color, phase } });
  }
  appendGroup(fades, 'v-scene', '場面フェード', 'visual');
  for (const [role, items, bindings, prefix, label] of [
    ['music', model.bgm.map(c => ({ id: c.id, start: c.startFrame, end: c.endFrame, volume: c.volume, fadeIn: c.fadeInFrames, fadeOut: c.fadeOutFrames })), input.bindings.bgm, 'a-bgm', 'BGM'],
    ['effect', model.se.map(c => ({ id: c.id, start: c.playbackFrame, end: c.playbackEnd, volume: c.volume, fadeIn: c.fadeInFrames ?? 0, fadeOut: c.fadeOutFrames ?? 0 })), input.bindings.se, 'a-se', '効果音'],
  ] as const) {
    appendGroup(items.filter(c => c.end > c.start).map(c => {
      const source = asset(bindings[c.id], 'media'), stream = source.streams.find(s => s.kind === 'audio');
      if (!stream) throw new SequenceError('MISSING_TARGET', '音声素材に音声ストリームがありません', [source.id]);
      return { id: `legacy-${role}-${c.id}`, name: source.name, trackId: '', startFrame: c.start, durationFrames: c.end - c.start,
        clock: clock(c.end - c.start), content: { kind: 'audio' as const, assetId: source.id, streamIndex: stream.index, sourceIn: rational(0), rate: rational(1), role,
          loop: role === 'music', settings: { gainDb: c.volume > 0 ? 20 * Math.log10(c.volume) : 0, muted: c.volume <= 0, fadeInFrames: c.fadeIn, fadeOutFrames: c.fadeOut } } };
    }), prefix, label, 'audio');
  }
  validateSequenceDocument(document);
  return { document, notices: [...new Set(notices)] };
}
