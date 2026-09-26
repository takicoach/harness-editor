import {isLegacyCaptionPolicy} from './legacyCaptionContinuations';
import { SequenceError } from './errors';
import { scriptDocumentSchema } from '../scriptAlignment';
import { clipEnd, isMediaContent, sourceTimeAt, type SequenceClip, type SequenceDocument, type SourceAnchor } from './model';
import { compareTime, isRational, rational, ZERO, type Rational } from './time';
import {textComponentId} from './textStyle';
import {TELOP_ANIMATION_IDS, type TelopAnimation} from '../types';
import {validateNativeSpeedMetadata} from './speedMetadata';
import {validateInsertOwnSpeed} from './insertOwnSpeed';
import {validateCutArchive} from './cutArchive';

function fail(message: string, targets: string[] = []): never {
  throw new SequenceError('INVALID_DOCUMENT', message, targets);
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function text(v: unknown): v is string { return typeof v === 'string' && v.length > 0; }
function id(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
}
function integer(v: unknown, min = 0): v is number { return Number.isSafeInteger(v) && (v as number) >= min; }
function time(v: unknown, positive = false): v is Rational {
  return isRational(v) && (positive ? v.num > 0 : v.num >= 0);
}
function uniqueIds(items: unknown[], label: string): void {
  const ids = new Set<string>();
  for (const value of items) {
    if (!record(value) || !id(value.id)) fail(`${label}のIDが不正です`);
    if (ids.has(value.id)) fail(`${label}のIDが重複しています`, [value.id]);
    ids.add(value.id);
  }
}

/** Also rejects cycles/non-finite values before canonical JSON can lose information. */
function jsonValue(value: unknown, stack = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('保存する数値にNaNまたはInfinityがあります');
    return;
  }
  if (typeof value !== 'object') fail('保存できない値が含まれています');
  if (stack.has(value)) fail('編集データが循環参照しています');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail('保存データには通常のJSONオブジェクトが必要です');
  }
  stack.add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail('配列に未定義の要素または余分な属性があります');
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(value) && child === undefined) fail('配列に未定義の値があります');
    jsonValue(child, stack);
  }
  stack.delete(value);
}

/** Pure structural + cross-reference validation; disk/media availability is separate. */
export function validateSequenceDocument(value: unknown): asserts value is SequenceDocument {
  validateDocument(value);
}

// shared is only supplied for internally constructed archive graphs whose common
// objects have already passed this invocation. No cross-call or mutable cache.
function validateDocument(value: unknown, shared?: SequenceDocument): asserts value is SequenceDocument {
  if (!shared) jsonValue(value);
  if (!record(value) || value.schemaVersion !== 2 || !id(value.id) || !text(value.name)) fail('編集データの形式が不正です');
  if (!integer(value.revision) || !integer(value.sequenceEndFrame) || !time(value.fps, true)) fail('編集データの時刻または版が不正です');
  if (!record(value.resolution) || !integer(value.resolution.width, 1) || !integer(value.resolution.height, 1)) fail('解像度が不正です');
  if (!text(value.background)) fail('背景色がありません');
  for (const key of ['assets', 'tracks', 'clips', 'transitions', 'transcripts']) {
    if (!Array.isArray(value[key])) fail(`${key}の一覧がありません`);
  }
  if (!record(value.ducking) || typeof value.ducking.enabled !== 'boolean'
    || !['weak', 'mid', 'strong'].includes(String(value.ducking.strength))) fail('ダッキング設定が不正です');
  const doc = value as unknown as SequenceDocument;
  uniqueIds(doc.assets, '素材'); uniqueIds(doc.tracks, 'トラック');
  uniqueIds(doc.clips, 'クリップ'); uniqueIds(doc.transitions, '転換');

  for (const asset of shared?.assets === doc.assets ? [] : doc.assets) {
    if (!['media', 'image', 'lut', 'component'].includes(asset.kind) || !text(asset.name) || !text(asset.fingerprint)
      || !text(asset.file) || asset.file.startsWith('/') || asset.file.includes('\\') || asset.file.includes(':')
      || asset.file.split('/').some(s => s === '..' || s === '.' || !s) || !Array.isArray(asset.streams)) {
      fail('素材の情報または保存先が不正です', [asset.id]);
    }
    if (asset.origin !== undefined) {
      const o = asset.origin as unknown as Record<string, unknown>;
      if (!record(o)) fail('素材の由来が不正です', [asset.id]);
      const kind = o.kind;
      if (kind === 'audio-fix') {
        if (Object.keys(o).some(k => !['kind', 'from', 'fix'].includes(k))
          || !id(o.from) || o.from === asset.id
          || !['denoise', 'normalize'].includes(String(o.fix))) fail('素材の由来が不正です', [asset.id]);
      } else if (kind === 'import') {
        if (Object.keys(o).some(k => !['kind', 'role'].includes(k))
          || !['music', 'effect'].includes(String(o.role))) fail('素材の由来が不正です', [asset.id]);
      } else {
        fail('素材の由来が不正です', [asset.id]);
      }
    }
    const indices = new Set<number>();
    if(asset.textStyleCatalog!==undefined) {
      const catalog=asset.textStyleCatalog;
      // packId/version/componentHash are optional (pre-T0b catalogs have none); validate format only when present.
      if(asset.kind!=='component'||!record(catalog)||!['builtin','project','installed'].includes(catalog.source)
        ||(catalog.packId!==undefined&&!/^[A-Za-z0-9._-]{1,80}$/.test(String(catalog.packId)))
        ||(catalog.version!==undefined&&!/^[A-Za-z0-9._-]{1,80}$/.test(String(catalog.version)))
        ||(catalog.componentHash!==undefined&&!/^[a-f0-9]{16}$/.test(String(catalog.componentHash)))
        ||(catalog.animations!==undefined&&(!Array.isArray(catalog.animations)||catalog.animations.length>64
          ||catalog.animations.some(id=>!TELOP_ANIMATION_IDS.includes(id as TelopAnimation))))
        ||!Array.isArray(catalog.entries)||!catalog.entries.length||catalog.entries.length>200)
        fail('文字スタイルの一覧が不正です',[asset.id]);
      const styleIds=new Set<number>();
      for(const entry of catalog.entries) {
        // entry.animations はスタイル単位の能力宣言（裁定 5）。未定義＝宣言なしでカタログ単位へ落ちる（旧文書）。
        if(!record(entry)||!integer(entry.id,1)||!text(entry.name)||entry.name.length>120||styleIds.has(entry.id)
          ||(entry.animations!==undefined&&(!Array.isArray(entry.animations)||entry.animations.length>64
            ||entry.animations.some(id=>!TELOP_ANIMATION_IDS.includes(id as TelopAnimation)))))fail('文字スタイルの一覧が不正です',[asset.id]);
        styleIds.add(entry.id);
      }
    }
    for (const stream of asset.streams) {
      if (!record(stream) || !integer(stream.index) || indices.has(stream.index)
        || !['video', 'audio'].includes(String(stream.kind)) || !time(stream.duration, true) || !text(stream.codec)) {
        fail('素材ストリームの情報が不正です', [asset.id]);
      }
      indices.add(stream.index);
      if (stream.kind === 'video' && (!time(stream.frameRate, true) || !integer(stream.width, 1) || !integer(stream.height, 1))) {
        fail('映像ストリームの寸法またはfpsが不正です', [asset.id]);
      }
      if (stream.kind === 'audio' && (!integer(stream.sampleRate, 1) || !integer(stream.channels, 1))) {
        fail('音声ストリームの情報が不正です', [asset.id]);
      }
    }
    if ((asset.kind === 'media') !== (asset.streams.length > 0)) fail('素材の種類とストリームが一致しません', [asset.id]);
  }
  const assets = new Map(doc.assets.map(a => [a.id, a]));
  const tracks = new Map(doc.tracks.map(t => [t.id, t]));
  const clips = new Map(doc.clips.map(c => [c.id, c]));
  if (doc.rendering !== undefined && (!record(doc.rendering)
    || (doc.rendering.telopComponentAssetId !== undefined && assets.get(doc.rendering.telopComponentAssetId)?.kind !== 'component')
    || (doc.rendering.imageComponentAssetId !== undefined && assets.get(doc.rendering.imageComponentAssetId)?.kind !== 'component')
    || (doc.rendering.telopBottomOffset !== null && typeof doc.rendering.telopBottomOffset !== 'number')
    || (doc.rendering.telopFontSize !== null && (typeof doc.rendering.telopFontSize !== 'number' || doc.rendering.telopFontSize <= 0)))) fail('字幕描画部品の参照が不正です');
  if (doc.rendering?.staticFiles !== undefined) {
    if (!record(doc.rendering.staticFiles)) fail('描画部品の素材対応表が不正です');
    for (const [file, assetId] of Object.entries(doc.rendering.staticFiles)) {
      if (!file || file.includes('\\') || file.includes(':') || file.split('/').some(part => !part || part === '.' || part === '..')
        || !assets.has(assetId)) fail('描画部品の素材参照が不正です');
    }
  }
  for (const track of doc.tracks) {
    if (!['visual', 'audio'].includes(track.kind) || !text(track.name) || typeof track.enabled !== 'boolean') fail('トラックの形式が不正です', [track.id]);
  }
  for (const clip of doc.clips) {
    if (!text(clip.name) || !integer(clip.startFrame) || !integer(clip.durationFrames, 1)
      || !integer(clipEnd(clip)) || !record(clip.content) || !record(clip.clock)
      || !isRational(clip.clock.offset) || !time(clip.clock.rate, true) || !time(clip.clock.duration, true)
      || (clip.linkGroupId !== undefined && !id(clip.linkGroupId))
      || (clip.continuationGroupId !== undefined && !id(clip.continuationGroupId))) fail('クリップの形式が不正です', [clip.id]);
    const track = tracks.get(clip.trackId);
    const content = clip.content;
    if (!track || (content.kind === 'audio' ? track.kind !== 'audio' : track.kind !== 'visual')) fail('クリップのトラックが不正です', [clip.id]);
    if (isMediaContent(content)) {
      const asset = assets.get(content.assetId);
      const stream = asset?.streams.find(s => s.index === content.streamIndex && s.kind === content.kind);
      if (asset?.kind !== 'media' || !stream || !time(content.sourceIn) || !time(content.rate, true)) fail('映像・音声の素材参照が不正です', [clip.id]);
      const looping = content.kind === 'audio' && content.loop;
      if (content.endBehavior !== undefined && content.endBehavior !== (content.kind === 'video' ? 'hold' : 'silence')) fail('素材終端の扱いが不正です', [clip.id]);
      if (!looping && compareTime(content.sourceIn, stream.duration) >= 0) fail('素材の開始位置が終端を越えています', [clip.id]);
      // A frame-aligned clip may include the final partial media frame. Validate the
      // last requested frame's timestamp; audio beyond EOF in that final frame is silence.
      if (!looping && content.endBehavior === undefined && compareTime(sourceTimeAt(clip, clipEnd(clip) - 1, doc.fps), stream.duration) >= 0) {
        fail('クリップが素材の終端を越えています', [clip.id]);
      }
      if (content.kind === 'audio') {
        const s = content.settings;
        if (!record(s) || typeof s.muted !== 'boolean' || typeof s.gainDb !== 'number' || s.gainDb < -60 || s.gainDb > 12
          || !integer(s.fadeInFrames) || !integer(s.fadeOutFrames) || typeof content.loop !== 'boolean'
          || !['speech', 'music', 'effect'].includes(content.role) || (content.loop && content.role === 'speech')) {
          fail('音声クリップの設定が不正です', [clip.id]);
        }
      }
    } else if (content.kind === 'image') {
      if (assets.get(content.assetId)?.kind !== 'image') fail('画像素材がありません', [clip.id]);
      if (content.style !== undefined && !['plain', 'photo', 'infographic', 'overlay'].includes(content.style)) fail('画像スタイルが不正です', [clip.id]);
    } else if (content.kind === 'scene-fade') {
      if (!text(content.color) || !['head', 'tail', 'join'].includes(content.phase)) fail('場面フェードが不正です', [clip.id]);
    } else if (content.kind === 'telop' || content.kind === 'title') {
      if (!record(content.data) || typeof content.data.text !== 'string') fail('字幕の内容が不正です', [clip.id]);
      if (content.kind === 'title' && !record(content.style)) fail('タイトルのスタイルがありません', [clip.id]);
      if(content.kind==='telop') {
        const animation=(content.data as {animation?:unknown}).animation;
        if(animation!==undefined&&!(TELOP_ANIMATION_IDS as readonly unknown[]).includes(animation))fail('字幕のアニメーションが不正です',[clip.id]);
        if(content.textMode!==undefined&&!['free','component'].includes(content.textMode))fail('文字の書式モードが不正です',[clip.id]);
        if(content.textMode==='free'&&content.appearance===undefined)fail('自由書式の設定がありません',[clip.id]);
        if(content.componentAssetId!==undefined&&assets.get(content.componentAssetId)?.kind!=='component')fail('文字の描画部品がありません',[clip.id]);
        if(content.textMode==='component'&&assets.get(textComponentId(doc,content)??'')?.kind!=='component')fail('文字の描画部品がありません',[clip.id]);
      }
      if (content.kind === 'telop' && content.appearance !== undefined) {
        const a = content.appearance;
        if (!record(a) || !text(a.fontFamily) || a.fontFamily.length > 500
          || typeof a.fontSize !== 'number' || a.fontSize < 1 || a.fontSize > 1000
          || !integer(a.fontWeight, 100) || a.fontWeight > 900 || !text(a.color) || !text(a.strokeColor) || !text(a.background)
          || typeof a.strokeWidth !== 'number' || a.strokeWidth < 0 || a.strokeWidth > 40
          || typeof a.lineHeight !== 'number' || a.lineHeight < .5 || a.lineHeight > 5
          || typeof a.letterSpacing !== 'number' || Math.abs(a.letterSpacing) > 100
          || !['left', 'center', 'right'].includes(a.align)) fail('文字の書式が不正です', [clip.id]);
      }
    } else if (content.kind === 'shape') {
      const d = content.data as unknown as Record<string, unknown>;
      const number = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
      if (!record(d) || !['arrow', 'line', 'rect', 'ellipse', 'triangle', 'angle'].includes(String(d.kind))
        || ![d.x1, d.y1, d.x2, d.y2].every(number) || !text(d.color)
        || !['thin', 'medium', 'thick'].includes(String(d.thickness))
        || (d.opacity !== undefined && (!number(d.opacity) || (d.opacity as number) < 0 || (d.opacity as number) > 1)))
        fail('図形の内容が不正です', [clip.id]);
      if (d.kind === 'angle') {
        if (![d.x3, d.y3].every(number)) fail('分度器には3つ目の点が必要です', [clip.id]);
        const zero = (ax: number, ay: number, bx: number, by: number): boolean => ax === bx && ay === by;
        if (zero(d.x1 as number, d.y1 as number, d.x2 as number, d.y2 as number)
          || zero(d.x1 as number, d.y1 as number, d.x3 as number, d.y3 as number))
          fail('分度器の辺の長さが0です', [clip.id]);
      }
    } else fail('未対応のクリップ形式です', [clip.id]);
    if(clip.legacyMainRole!==undefined){
      const p=clip.legacyMainRole;
      if(!record(p)||Object.keys(p).some(k=>!['version','sourceFingerprint','kind','providerId','witnesses'].includes(k))||p.version!==1
       ||typeof p.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.sourceFingerprint)||!['main','main-audio'].includes(p.kind)
       ||(p.kind==='main'?content.kind!=='video'||p.providerId!==undefined:content.kind!=='audio'||!id(p.providerId))||!Array.isArray(p.witnesses)||p.witnesses.length>4)fail('旧主映像の役割出典が不正です',[clip.id]);
      for(const w of p.witnesses){if(!record(w)||Object.keys(w).some(k=>!['clipId','edge','kind','providerId','assetId','streamIndex','sourceTime','rate'].includes(k))
       ||!id(w.clipId)||!['start','end'].includes(w.edge)||!['main','main-audio'].includes(w.kind)||!id(w.assetId)||!integer(w.streamIndex)||!time(w.sourceTime)||!time(w.rate,true)
       ||(w.kind==='main'?w.providerId!==undefined:!id(w.providerId)))fail('旧主映像の境界証拠が不正です',[clip.id]);}
    }
    if(clip.legacyCaptionContinuity!==undefined&&(content.kind!=='telop'||!isLegacyCaptionPolicy(clip.legacyCaptionContinuity)))fail('旧字幕の使用箇所・時計証拠が不正です',[clip.id]);
    if(clip.legacyAudioContinuity!==undefined){
      const p=clip.legacyAudioContinuity;
      if(!record(p)||Object.keys(p).some(k=>!['version','sourceFingerprint','ownerClipId','leftClampBridge'].includes(k))||p.version!==1
        ||typeof p.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.sourceFingerprint)||!id(p.ownerClipId)||(p.leftClampBridge!==undefined&&p.leftClampBridge!==true)
        ||content.kind!=='audio'||!['music','effect'].includes(content.role))fail('旧音楽の使用箇所が不正です',[clip.id]);
    }
    if ('legacyId' in content && content.legacyId !== undefined && !integer(content.legacyId)) fail('旧部品の要素IDが不正です', [clip.id]);
    if (clip.visual !== undefined) {
      const v = clip.visual;
      if (!record(v) || !record(v.layout) || !record(v.layout.position) || typeof v.opacity !== 'number'
        || v.opacity < 0 || v.opacity > 1 || typeof v.layout.scale !== 'number' || v.layout.scale <= 0
        || typeof v.layout.position.x !== 'number' || typeof v.layout.position.y !== 'number'
        || typeof v.layout.rotation !== 'number' || typeof v.layout.flipH !== 'boolean' || typeof v.layout.flipV !== 'boolean'
        || !text(v.layout.background) || !Array.isArray(v.keyframes)) fail('映像の配置設定が不正です', [clip.id]);
      for (const key of v.keyframes) {
        if (!record(key) || !time(key.frame) || !record(key.value)
          || (key.easing !== undefined && key.easing !== 'linear' && key.easing !== 'easeInOut')) fail('キーフレームの形式が不正です', [clip.id]);
        const value=key.value;
        if((value.position!==undefined&&(!record(value.position)||typeof value.position.x!=='number'||typeof value.position.y!=='number'))
          ||(value.scale!==undefined&&(typeof value.scale!=='number'||value.scale<=0))
          ||(value.rotation!==undefined&&typeof value.rotation!=='number')
          ||(value.flipH!==undefined&&typeof value.flipH!=='boolean')||(value.flipV!==undefined&&typeof value.flipV!=='boolean')
          ||(value.opacity!==undefined&&(typeof value.opacity!=='number'||value.opacity<0||value.opacity>1)))fail('キーフレームの値が不正です',[clip.id]);
      }
      if (v.keyframeClock !== undefined && (!record(v.keyframeClock) || !isRational(v.keyframeClock.offset)
        || !time(v.keyframeClock.rate, true) || !time(v.keyframeClock.duration, true))) fail('キーフレームの時計が不正です', [clip.id]);
      if (v.keyframesOutside !== undefined && v.keyframesOutside !== 'base' && v.keyframesOutside !== 'hold') fail('キーフレーム範囲外の設定が不正です', [clip.id]);
      if (v.lut !== undefined && (!record(v.lut) || assets.get(v.lut.assetId)?.kind !== 'lut'
        || typeof v.lut.intensity !== 'number' || v.lut.intensity < 0 || v.lut.intensity > 1)) fail('LUTの設定が不正です', [clip.id]);
    }
  }
  for (const clip of doc.clips) {
    const raw: unknown = clip.anchor;
    if (raw === undefined) continue;
    if (!record(raw) || !['source', 'timeline'].includes(String(raw.kind))) fail('字幕の参照形式が不正です', [clip.id]);
    if (raw.kind === 'timeline') continue;
    const a = raw as unknown as SourceAnchor;
    const target = clips.get(a.clipOccurrenceId);
    if (!['speech', 'visual'].includes(a.role) || !target || !isMediaContent(target.content)
      || target.content.assetId !== a.sourceAssetId || !time(a.sourceStart) || !time(a.sourceEnd)
      || compareTime(a.sourceStart, a.sourceEnd) >= 0
      || (a.role === 'speech' ? target.content.kind !== 'audio' || target.content.role !== 'speech' : target.content.kind !== 'video')
      || clip.startFrame < target.startFrame || clipEnd(clip) > clipEnd(target)
      || compareTime(a.sourceStart, sourceTimeAt(target, clip.startFrame, doc.fps)) !== 0
      || compareTime(a.sourceEnd, sourceTimeAt(target, clipEnd(clip), doc.fps)) !== 0) {
      throw new SequenceError('BROKEN_REFERENCE', '字幕の素材と使用箇所の対応が不正です', [clip.id]);
    }
  }
  for (const transition of doc.transitions) {
    const out = clips.get(transition.outClipId);
    const incoming = transition.inClipId === undefined ? undefined : clips.get(transition.inClipId);
    if (!integer(transition.startFrame) || !integer(transition.durationFrames, 1)
      || !integer(transition.startFrame + transition.durationFrames)
      || !['crossfade', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'fadeBlack', 'fadeWhite'].includes(transition.kind)
      || (transition.audioCurve !== undefined && transition.audioCurve !== 'linear' && transition.audioCurve !== 'none')
      || !out || out.trackId !== transition.trackId) fail('転換の参照が不正です', [transition.id]);
    if ((transition.joinKey !== undefined && !text(transition.joinKey))
      || (transition.joinFrame !== undefined && !integer(transition.joinFrame))
      || (transition.joinKey === undefined) !== (transition.joinFrame === undefined)) fail('転換のつなぎ目の記録が不正です', [transition.id]);
    const end = transition.startFrame + transition.durationFrames;
    if (transition.kind === 'fadeBlack' || transition.kind === 'fadeWhite') {
      if (incoming || !['in', 'out'].includes(transition.edge ?? '') || transition.startFrame < out.startFrame || end > clipEnd(out)) fail('フェードの範囲が不正です', [transition.id]);
    } else {
      if (!incoming || incoming.id === out.id || incoming.trackId !== transition.trackId || transition.edge !== undefined
        || out.startFrame > incoming.startFrame || clipEnd(out) > clipEnd(incoming)
        || transition.startFrame !== incoming.startFrame || end !== clipEnd(out)) fail('転換の重なりが不正です', [transition.id]);
    }
  }
  for (const track of doc.tracks) {
    const items = doc.clips.filter(c => c.trackId === track.id).sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 0; i < items.length; i++) {
      const a = items[i]!;
      for (let j = i + 1; j < items.length && items[j]!.startFrame < clipEnd(a); j++) {
        const b = items[j]!;
        const matches = doc.transitions.filter(t => t.trackId === track.id
          && ((t.outClipId === a.id && t.inClipId === b.id) || (t.outClipId === b.id && t.inClipId === a.id)));
        const third = items.slice(i + 1, j).some(c => clipEnd(c) > b.startFrame);
        if (matches.length !== 1 || third) throw new SequenceError('TRACK_COLLISION', '同じトラックのクリップが重なっています', [a.id, b.id]);
      }
    }
  }
  const transcriptKeys = new Set<string>();
  for (const transcript of shared?.transcripts === doc.transcripts && shared.assets === doc.assets ? [] : doc.transcripts) {
    if (!record(transcript) || !Array.isArray(transcript.words)) fail('文字起こしの形式が不正です');
    const stream = assets.get(transcript.assetId)?.streams.find(s => s.index === transcript.streamIndex && s.kind === 'audio');
    const key = `${transcript.assetId}:${transcript.streamIndex}`;
    if (!stream || transcriptKeys.has(key)) fail('文字起こしの素材参照が不正です');
    transcriptKeys.add(key);
    uniqueIds(transcript.words, '単語');
    for (const word of transcript.words) {
      if (typeof word.text !== 'string' || !time(word.start) || !time(word.end)
        || compareTime(word.start, word.end) >= 0 || compareTime(word.end, stream.duration) > 0) fail('単語の時刻が不正です', [word.id]);
    }
  }
  if (doc.legacy !== undefined && (!record(doc.legacy) || !text(doc.legacy.sourceFingerprint)
    || !assets.has(doc.legacy.primaryAssetId) || !integer(doc.legacy.originalEndFrame))) fail('移行元の記録が不正です');
  if(doc.scriptDocument!==undefined && !scriptDocumentSchema.safeParse(doc.scriptDocument).success) fail('台本の形式が不正です');
  if(doc.textStylePrefs!==undefined){
    const prefs=doc.textStylePrefs as unknown as Record<string,unknown>;
    if(!record(prefs)||Object.keys(prefs).some(k=>k!=='hidden')||!record(prefs.hidden)
      ||Object.values(prefs.hidden).some(list=>!Array.isArray(list)||list.some(v=>!integer(v,1))))
      fail('文字スタイルの表示設定が不正です');
  }
  validateNativeSpeedMetadata(doc);
  validateInsertOwnSpeed(doc);
  if(doc.legacy?.cutHistoryImport!==undefined){
    const marker=doc.legacy.cutHistoryImport;
    if(!record(marker)||Object.keys(marker).some(k=>!['version','sourceFingerprint'].includes(k))||marker.version!==1
      ||typeof marker.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(marker.sourceFingerprint)||marker.sourceFingerprint!==doc.legacy.sourceFingerprint)fail('旧カットの引き継ぎ記録が不正です');
  }
  validateCutArchive(doc, graph => validateDocument(graph, doc));
  // Latent captions still own editable content. Validate the same clip schema
  // even when rounding currently produces no render clip. No metadata recursion.
  for(const provider of doc.clips)for(const ledger of provider.speed?.captions??[]){
    for(const source of [ledger.template,...ledger.parts.flatMap(p=>p.presentation?[p.presentation.template]:[])]){
      const template=structuredClone(source);
      if(template.visual&&ledger.keyframeClock)template.visual.keyframeClock={offset:ledger.keyframeClock.offset,rate:ledger.keyframeClock.slope,duration:ledger.keyframeClock.duration};
      const caption={...template,id:ledger.captionId,startFrame:0,durationFrames:1,clock:{offset:ledger.clock.offset,rate:ledger.clock.slope,duration:ledger.clock.duration}};
      validateSequenceDocument({...doc,cutArchive:undefined,speed:undefined,insertOwnSpeed:undefined,clips:[caption],transitions:[],sequenceEndFrame:Math.max(1,doc.sequenceEndFrame)});
    }
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!record(value)) return Object.is(value, -0) ? 0 : value;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  if (keys.length === 2 && keys[0] === 'den' && keys[1] === 'num' && isRational(value)) {
    const r = rational(value.num, value.den);
    return { den: r.den, num: r.num };
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) result[key] = canonicalValue(value[key]);
  return result;
}

export function sequenceContentBytes(document: SequenceDocument): string {
  validateSequenceDocument(document);
  const { revision: _revision, ...content } = document;
  return JSON.stringify(canonicalValue(content));
}
export function serializeSequence(document: SequenceDocument): string {
  validateSequenceDocument(document);
  return JSON.stringify(canonicalValue(document)) + '\n';
}
export function parseSequence(text: string): SequenceDocument {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('編集データのJSONを読み取れません'); }
  validateSequenceDocument(value);
  return JSON.parse(JSON.stringify(canonicalValue(value))) as SequenceDocument;
}

export function validateSourceSelection(document: SequenceDocument, clip: SequenceClip): void {
  if (clip.content.kind !== 'audio' || clip.content.settings.muted || !document.tracks.find(t => t.id === clip.trackId)?.enabled) {
    throw new SequenceError('INAUDIBLE_SOURCE', '発話を再生する音声を選択してください', [clip.id]);
  }
  if (compareTime(clip.content.rate, ZERO) <= 0) fail('音声の速度が不正です', [clip.id]);
}
