import {fillCutCaptions} from './fillCutCaptions';
import {adoptLegacyCutHistory,type AdoptLegacyCutHistoryCommand} from './legacyCutBackfill';
import {registerProvenCutRoles} from './cutRegistration';
import {resizeCutBoundary,type ResizeCutBoundaryCommand} from './cutBoundary';
import {adoptSourceGap,type AdoptSourceGapCommand} from './adoptSourceGap';
export {readCutBoundaryGroup} from './cutBoundary';
export type {CutBoundarySelection,CutBoundaryTarget,CutBoundaryGroup,ResizeCutBoundaryCommand} from './cutBoundary';
import {isNativeSpeedCommandType,validateNativeSpeedCommand} from './speedCommandValidation';
import {applyCaptionCommand,type CaptionCommand} from './captionCommands';
import {applyInsertOwnCommand,rebindInsertOwnFragment,rebindInsertOwnCompletion,guardInsertOwnProperty,detachInsertOwnLinks,type InsertOwnCommand} from './insertOwnSpeed';
import {rememberTimingFragments} from './speedTimingBasis';
import {applyNativeSpeedCommand,type NativeSpeedCommand} from './speedCommands';
import {rebindOperationBasis} from './speedOperationBasis';
import {rebindSpeedInsert,rebindSpeedProperty} from './speedGeneric';
import {rebindSpeedStructure} from './speedStructural';
import {rebindSpeedTrim} from './speedTrim';
import {rebindCaptionContinuations,captionLedgers,refreshCaptionBaselines,speedProjectionForDocument,speedReservedIds,upgradeNativeSpeedMetadata} from './speedCaptionLedger';
import {rebindSpeedSplit} from './speedRebind';
import {textComponentId} from './textStyle';
import {assetAnimationSupport,supportsAnimation} from './telopAnimationSupport';
import type {TelopAnimationId} from '../telopAnimation';
import { SequenceError } from './errors';
import { sequenceAssetReferences } from './assetReferences';
import { clipEnd, effectFrameAt, isMediaContent, sourceTimeAt, type SequenceAsset, type SequenceClip, type SequenceDocument, type SequenceTrack, type SequenceTransition, type SourceTranscript } from './model';
import { sequenceContentBytes, validateSequenceDocument } from './validate';
import { addTime, compareTime, multiplyTime, rational } from './time';
import { scriptDocumentSchema, type ScriptDocument } from '../scriptAlignment';
import { transcriptIdentity } from './transcript';
import {editSceneFades,sceneFadeEndpoint,type SceneFadeTarget,type SceneFadeChange} from './sceneFadeEdits';
import {transitionJoins, transitionJoinKey} from './transitions';
import {registerNativeSpeedMetadata,type RegisterNativeSpeedCommand} from './speedMetadata';
import {archiveRippleCut,archiveReservedIds,rebindCutArchiveFragments,restoreArchivedCut,previewArchivedCut,fragmentGraph,type RestoreCutCommand} from './cutArchive';
import {rebindClipReferences,rippleTrimPlan,type RippleTrimPlan,type TrimCommand} from './rippleTrim';

export type SequenceCommand =
  | AdoptLegacyCutHistoryCommand
  | AdoptSourceGapCommand
  | ResizeCutBoundaryCommand
  | {type:'fill-cut-captions';templateClipId:string}
  | CaptionCommand
  | RestoreCutCommand
  | InsertOwnCommand
  | NativeSpeedCommand
  | {type:'upgrade-native-speed'}
  | RegisterNativeSpeedCommand
  | {type:'set-scene-fades';targets:SceneFadeTarget[];change:SceneFadeChange}
  | { type: 'batch'; commands: SequenceCommand[] }
  | { type: 'set-script'; script: ScriptDocument | null }
  | { type: 'set-ducking'; patch: Partial<SequenceDocument['ducking']> }
  | { type: 'set-transcript'; transcript:SourceTranscript; before:SourceTranscript|null; assetFingerprint:string }
  | { type: 'ripple-delete'; startFrame: number; endFrame: number }
  | { type:'reorder-ranges'; ranges:Array<{startFrame:number;endFrame:number}> }
  | { type: 'split'; clipIds: string[]; frame: number; linked?: boolean }
  | { type: 'delete'; clipIds: string[]; linked?: boolean }
  | { type: 'move'; clipIds: string[]; deltaFrames: number; trackId?: string; linked?: boolean }
  | TrimCommand
  | { type: 'unlink'; clipIds: string[] }
  | { type: 'add-track'; track: SequenceTrack; index?: number }
  | { type: 'remove-track'; trackId: string }
  | { type: 'insert'; clips: SequenceClip[] }
  | { type: 'register-assets'; assets: SequenceAsset[] }
  | { type: 'set-track-enabled'; trackId: string; enabled: boolean }
  | { type: 'move-track'; trackId: string; index: number }
  | { type: 'update-clip'; clipId: string; patch: Pick<Partial<SequenceClip>, 'name' | 'visual' | 'content'> }
  | { type: 'replace-audio-source'; trackId: string; fromAssetId: string; toAssetId: string }
  | { type: 'replace-text-style-asset'; fromAssetId: string; toAssetId: string }
  | { type: 'remove-asset'; assetId: string }
  | { type: 'set-transition'; joinKey: string; transition: Omit<SequenceTransition, 'id'> | null }
  | { type: 'apply-text-style-all'; assetId: string; styleId: number; trackId?: string; clearUnsupportedAnimations?: boolean }
  | { type: 'set-text-style-hidden'; assetId: string; hidden: number[] };

interface Slice { from: number; to: number; start: number; trackId?: string }
interface Fragment { original: SequenceClip; slice: Slice; clip: SequenceClip }

function range(from: number, to: number): void {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new SequenceError('INVALID_RANGE', '編集する範囲が不正です');
  }
}
function overlaps(a: number, b: number, c: number, d: number): boolean { return a < d && c < b; }
function allocator(document: SequenceDocument): (prefix: string) => string {
  const used = new Set([
    ...archiveReservedIds(document),
    ...speedReservedIds(document),
    ...document.clips.flatMap(c => [c.id, c.linkGroupId, c.continuationGroupId]),
    ...document.tracks.map(t => t.id), ...document.assets.map(a => a.id), ...document.transitions.map(t => t.id),
  ]);
  let counter = 0;
  return prefix => {
    let id: string;
    do { id = `${prefix}-${++counter}`; } while (used.has(id));
    used.add(id);
    return id;
  };
}
function targets(document: SequenceDocument, ids: string[], linked: boolean): Set<string> {
  const result = new Set(ids);
  const links = new Set<string>();
  for (const id of result) {
    const clip = document.clips.find(c => c.id === id);
    if (!clip) throw new SequenceError('MISSING_TARGET', '対象のクリップが見つかりません', [id]);
    if (linked && clip.linkGroupId) links.add(clip.linkGroupId);
  }
  if (linked) for (const clip of document.clips) {
    if (clip.linkGroupId && links.has(clip.linkGroupId)) result.add(clip.id);
  }
  return result;
}

/** Rebuilds all fragments and references as one candidate; never mutates the input. */
function rebuild(
  document: SequenceDocument,
  recipes: Map<string, Slice[]>,
  transitionShift: (frame: number,trackId?:string) => number = frame => frame,
  speedSplit=false,
  speedTrim=false,
  structure?:{sequenceEndFrame?:number;grow?:boolean},
): SequenceDocument {
  const fresh = allocator(document);
  const fragments = new Map<string, Fragment[]>();
  const linkPieces = new Map<string, string>();
  const make = (original: SequenceClip, slice: Slice): Fragment => {
    const clip = structuredClone(original);
    clip.startFrame = slice.start;
    clip.durationFrames = slice.to - slice.from;
    clip.trackId = slice.trackId ?? original.trackId;
    clip.clock.offset = effectFrameAt(original, slice.from);
    if (clip.visual?.keyframeClock && original.visual?.keyframeClock) {
      clip.visual.keyframeClock.offset = addTime(original.visual.keyframeClock.offset,
        multiplyTime(rational(slice.from - original.startFrame), original.visual.keyframeClock.rate));
    }
    if (isMediaContent(clip.content)) clip.content.sourceIn = sourceTimeAt(original, slice.from, document.fps);
    rebindInsertOwnFragment(document,original,clip,slice.from,slice.to);
    return { original, slice, clip };
  };
  for (const original of document.clips) {
    const slices = recipes.get(original.id) ?? [{ from: original.startFrame, to: clipEnd(original), start: original.startFrame }];
    fragments.set(original.id, slices.filter(s => s.from < s.to).map(s => make(original, s)));
  }
  // A split of a source occurrence also splits any caption straddling that boundary.
  // A deleted source detaches remaining captions; global ripple has already removed its selected text.
  for (const original of document.clips) {
    if (original.anchor?.kind !== 'source') continue;
    const providers = fragments.get(original.anchor.clipOccurrenceId)!;
    const own = fragments.get(original.id)!;
    if (providers.length === 0) {
      for (const part of own) part.clip.anchor = { kind: 'timeline' };
      continue;
    }
    const pieces: Fragment[] = [];
    for (const part of own) for (const provider of providers) {
      const from = Math.max(part.slice.from, provider.slice.from);
      const to = Math.min(part.slice.to, provider.slice.to);
      if (from >= to) continue;
      // Source-following captions move with the occurrence, including after unlinking video/audio.
      pieces.push(make(original, { from, to, start: provider.clip.startFrame + from - provider.slice.from }));
    }
    fragments.set(original.id, pieces);
  }
  for (const parts of fragments.values()) {
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (index > 0) part.clip.id = fresh('clip');
      if (parts.length > 1) part.clip.continuationGroupId = part.original.continuationGroupId ?? part.original.id;
      if (index > 0 && part.original.linkGroupId) {
        const key = `${part.original.linkGroupId}:${part.slice.from}`;
        let link = linkPieces.get(key);
        if (!link) { link = fresh('link'); linkPieces.set(key, link); }
        part.clip.linkGroupId = link;
      }
    }
  }
  for (const parts of fragments.values()) for (const part of parts) {
    const anchor = part.clip.anchor;
    if (anchor?.kind !== 'source') continue;
    const provider = fragments.get(anchor.clipOccurrenceId)!.find(p => p.slice.from <= part.slice.from && p.slice.to >= part.slice.to);
    if (!provider) throw new SequenceError('BROKEN_REFERENCE', '字幕の分割先が見つかりません', [part.clip.id]);
    anchor.clipOccurrenceId = provider.clip.id;
    anchor.sourceStart = sourceTimeAt(provider.clip, part.clip.startFrame, document.fps);
    anchor.sourceEnd = sourceTimeAt(provider.clip, clipEnd(part.clip), document.fps);
  }
  const next = structuredClone(document);
  next.clips = [...fragments.values()].flatMap(parts => parts.map(p => p.clip));
  rebindCutArchiveFragments(document,next,fragments);
  rememberTimingFragments(next,fragments);
  next.transitions = document.transitions.flatMap(transition => {
    const start = transition.startFrame, end = start + transition.durationFrames;
    const outParts = fragments.get(transition.outClipId)!;
    const inParts = transition.inClipId ? fragments.get(transition.inClipId)! : undefined;
    if (!outParts.length || (inParts && !inParts.length)) return [];
    const out = outParts.find(p => p.slice.from <= start && p.slice.to >= end);
    const incoming = inParts?.find(p => p.slice.from <= start && p.slice.to >= end);
    if (!out || (inParts && !incoming)) throw new SequenceError('TRANSITION_INTERSECTION', '転換を含む範囲は先に転換を解除してください', [transition.id]);
    // 境界情報（joinKey / joinFrame）も一緒に作り直す。片方だけ動かすと、解除が
    // 削除前の境界まで前クリップを延ばす（鍵は sceneFadeTargetKey と同じ生成関数を使う）。
    const rejoined = transition.joinKey !== undefined && transition.joinFrame !== undefined && incoming
      ? { joinKey: transitionJoinKey(transition.trackId, out.clip.id, incoming.clip.id),
          joinFrame: transitionShift(transition.joinFrame, transition.trackId) }
      : {};
    // R3-M4: 解除時（set-transition の null 側）は `join<=out.startFrame || join>=clipEnd(incoming)`
    // を検算して拒否する。書き込み側（ここ）に対になる検査が無いと、before===0 の重なりで
    // 流出クリップの頭を ripple-delete したときに joinFrame が out.startFrame まで縮み、
    // 以後その転換を一切解除できない書類を作れてしまう。同じ不等式で先に断る。
    if (rejoined.joinFrame !== undefined
      && (rejoined.joinFrame <= out.clip.startFrame || rejoined.joinFrame >= clipEnd(incoming!.clip)))
      throw new SequenceError('TRANSITION_INTERSECTION', '転換を含む範囲は先に転換を解除してください', [transition.id]);
    return [{ ...transition, startFrame: transitionShift(start,transition.trackId), outClipId: out.clip.id,
      ...(incoming ? { inClipId: incoming.clip.id } : {}), ...rejoined }];
  });
  if(structure){if(structure.sequenceEndFrame!==undefined)next.sequenceEndFrame=structure.sequenceEndFrame;if(structure.grow)next.sequenceEndFrame=Math.max(document.sequenceEndFrame,...next.clips.filter(c=>recipes.has(c.id)).map(clipEnd));return rebindSpeedStructure(document,next,fragments,fresh);}
  if(speedTrim){next.sequenceEndFrame=Math.max(document.sequenceEndFrame,...next.clips.filter(c=>recipes.has(c.id)).map(clipEnd));return rebindSpeedTrim(document,next,fragments,fresh);}
  if(speedSplit)return rebindSpeedSplit(document,next,fragments,fresh);
  // Ordinary timeline-caption trim still advances its explicit detached clock.
  if(document.speed?.version===2)for(const old of captionLedgers(document)){
    const ledger=captionLedgers(next).find(l=>l.captionId===old.captionId);if(ledger)rebindCaptionContinuations(ledger,old,fragments);
  }
  return next;
}

/**
 * 「詰める」の唯一の実装。`case 'ripple-delete'` と `trim`(ripple) の close が同じものを呼ぶ。
 * `base` は速度昇格後の入力文書（呼び出し側は以後これを `document` として扱う）。
 * `as` は「この操作と同じ意味の ripple-delete コマンド」。後処理（rebindInsertOwnCompletion）が
 * `command.type` で分岐する（insertOwnSpeed.ts）ため、close もこれを渡して同じ枝を通す。
 * 検査の順序は従来の `case 'ripple-delete'` のまま（range → 尺 → start===end）。
 */
function rippleDeleteRange(document: SequenceDocument, start: number, end: number):
  {base: SequenceDocument; next: SequenceDocument; as: {type: 'ripple-delete'; startFrame: number; endFrame: number}} {
  const as = { type: 'ripple-delete' as const, startFrame: start, endFrame: end };
  range(start, end);
  if (end > document.sequenceEndFrame) throw new SequenceError('INVALID_RANGE', '選択範囲がシーケンスの終端を越えています');
  if (start === end) return { base: document, next: document, as };
  const blocked = document.transitions.filter(t => overlaps(start, end, t.startFrame, t.startFrame + t.durationFrames));
  if (blocked.length) throw new SequenceError('TRANSITION_INTERSECTION', '転換を含む範囲は先に転換を解除してください', blocked.map(t => t.id));
  const fades = document.clips.filter(c => c.content.kind === 'scene-fade' && overlaps(start, end, c.startFrame, clipEnd(c)));
  if (fades.length) throw new SequenceError('TRANSITION_INTERSECTION', '場面フェードを含む範囲は先にフェードを解除してください', fades.map(c => c.id));
  const recipes = new Map<string, Slice[]>();
  for (const clip of document.clips) {
    const slices: Slice[] = [];
    const before = Math.min(clipEnd(clip), start);
    if (clip.startFrame < before) slices.push({ from: clip.startFrame, to: before, start: clip.startFrame });
    const after = Math.max(clip.startFrame, end);
    if (after < clipEnd(clip)) slices.push({ from: after, to: clipEnd(clip), start: after - (end - start) });
    recipes.set(clip.id, slices);
  }
  const base = document.speed ? upgradeNativeSpeedMetadata(document) : document;
  let next = rebuild(base, recipes, frame => frame >= end ? frame - (end - start) : frame, false, false,
    base.speed ? { sequenceEndFrame: base.sequenceEndFrame - (end - start) } : undefined);
  if (!base.speed) next.sequenceEndFrame -= end - start;
  next = archiveRippleCut(base, next, start, end, { rebuild, fresh: allocator, validate: validateSequenceDocument });
  return { base, next, as };
}

/**
 * ある時刻以降を右へずらす recipes を積む（§5）。`skip` は既に recipe を持つクリップ。
 * ripple-delete と対称に、境界をまたぐクリップは `at` で 2 片へ切って後半だけ動かす（P1-4）。
 * 2 片は rebuild:161 が `continuationGroupId` を共有させる（split と同じ）。
 * **速度案件の扱いは呼び出し側の責務**: ここは §5 の `upgradeNativeSpeedMetadata` →
 * `rebuild(…,{sequenceEndFrame})` 経路も `sequenceEndFrame += delta` も持たない。join は §4-6 が
 * `document.speed` を除くので足りるが、T4 の単独 push は呼び出し側で足すこと。
 */
function pushRecipes(document: SequenceDocument, recipes: Map<string, Slice[]>, at: number, delta: number, skip: Set<string>): void {
  for (const clip of document.clips) {
    if (skip.has(clip.id)) continue;
    if (clip.startFrame >= at) { recipes.set(clip.id, [{ from: clip.startFrame, to: clipEnd(clip), start: clip.startFrame + delta }]); continue; }
    if (at < clipEnd(clip)) recipes.set(clip.id, [
      { from: clip.startFrame, to: at, start: clip.startFrame },
      { from: at, to: clipEnd(clip), start: at + delta },
    ]);
  }
}

/** Read-only current insertion length; range remains in the saved band's frame unit. */
export function previewCutRestoration(document:SequenceDocument,entryId:string,range?:RestoreCutCommand['range']):{durationFrames:number}{
  validateSequenceDocument(document);
  return previewArchivedCut(document,entryId,range,{rebuild,fresh:allocator,validate:validateSequenceDocument});
}

/** Reuse the archive slicer for an explicit window, including source/effect anchors. */
export function extractSequenceWindow(document:SequenceDocument,start:number,end:number):SequenceDocument{
  validateSequenceDocument(document);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>document.sequenceEndFrame)throw new SequenceError('INVALID_RANGE','切り出す範囲がシーケンス外です');
  return fragmentGraph(document,start,end,{rebuild,fresh:allocator,validate:validateSequenceDocument});
}

/** A command increments the edit revision only when canonical content actually changes. */
export function applySequenceCommand(document: SequenceDocument, command: SequenceCommand): SequenceDocument {
  if(isNativeSpeedCommandType(command.type))validateNativeSpeedCommand(command);
  // sequenceContentBytes validates as well as canonicalizing. Retain the input
  // bytes so no-op detection does not repeat the same full-document validation.
  const originalContent=sequenceContentBytes(document);
  const recipes = new Map<string, Slice[]>();
  let next: SequenceDocument;
  // 後処理が見るコマンド。close は「操作前の文書に対する ripple-delete」そのものなので、
  // 後処理にも ripple-delete として見せる（rebindInsertOwnCompletion が type で分岐するため）。
  let effect: SequenceCommand = command;
  switch (command.type) {
    case 'adopt-legacy-cut-history': next=adoptLegacyCutHistory(document,command,allocator(document));break;
    case 'adopt-source-gap': next=adoptSourceGap(document,command,allocator(document));break;
    case 'fill-cut-captions': next=fillCutCaptions(document,command.templateClipId,allocator(document));break;
    case 'split-caption':
    case 'merge-captions': next=applyCaptionCommand(document,command,allocator(document));break;
    case 'register-native-insert-own-speed':
    case 'set-native-insert-own-speed':
    case 'rebase-native-insert-own-source':
    case 'rebase-native-insert-own-keyframe-clock': next=applyInsertOwnCommand(document,command);break;
    // HTTP and core share strict explicit-target validation; no automatic
    // main-role selection or legacy registration occurs here.
    case 'upgrade-native-speed-operations':
    case 'set-native-global-speed':
    case 'set-native-main-speed':
    case 'reset-native-main-speed': next=applyNativeSpeedCommand(document,command);break;
    case 'upgrade-native-speed': next=upgradeNativeSpeedMetadata(document);break;
    case 'register-native-speed': next=registerProvenCutRoles(document,registerNativeSpeedMetadata(document,command));break;
    case 'set-scene-fades': {
      const edited=editSceneFades(document,command.targets,command.change);
      // Scene-fade editing structurally shares unchanged clips. Subsequent speed
      // rebinding mutates their saved basis, so isolate it before that boundary.
      next=edited===document?document:structuredClone(edited);break;
    }
    case 'set-transition': {
      const current = document.transitions.find(t => t.joinKey === command.joinKey);
      const wanted = command.transition;
      if (!current && !wanted) {
        if (!transitionJoins(document).some(j => j.joinKey === command.joinKey))
          throw new SequenceError('MISSING_TARGET', '対象のつなぎ目が見つかりません', [command.joinKey]);
        return document;
      }
      // A registered clip carries a saved placement basis (span/overlapBefore) that
      // this command cannot regenerate, so refuse instead of writing a document
      // whose speed basis no longer reproduces its own clips.
      if ([current?.outClipId, current?.inClipId, wanted?.outClipId, wanted?.inClipId]
        .some(id => id !== undefined && document.clips.find(c => c.id === id)?.speed !== undefined))
        throw new SequenceError('SPEED_REGISTERED', '速度を設定した案件では転換を付けられません。先に速度を全体へ戻してください', [command.joinKey]);
      next = structuredClone(document);
      // 1) 既にある重なりをほどく（保存してある元の境界へ戻す）。
      if (current) {
        const out = next.clips.find(c => c.id === current.outClipId), incoming = next.clips.find(c => c.id === current.inClipId);
        const join = current.joinFrame;
        // 記録した境界をそのまま信じない。構造編集でずれていたら、黙って古い境界へ戻すより拒否する。
        if (!out || !incoming || current.inClipId === undefined || join === undefined || !Number.isSafeInteger(join)
          || current.joinKey !== transitionJoinKey(current.trackId, current.outClipId, current.inClipId)
          || join < current.startFrame || join > current.startFrame + current.durationFrames
          || join <= out.startFrame || join < incoming.startFrame || join >= clipEnd(incoming))
          throw new SequenceError('INVALID_RANGE', '転換のつなぎ目の記録が編集内容と一致しません', [command.joinKey]);
        out.durationFrames = join - out.startFrame;
        const grew = join - incoming.startFrame;
        incoming.startFrame = join; incoming.durationFrames -= grew;
        if (incoming.content.kind === 'video' || incoming.content.kind === 'audio')
          incoming.content.sourceIn = sourceTimeAt(document.clips.find(c => c.id === current.inClipId)!, join, document.fps);
        incoming.clock.offset = effectFrameAt(document.clips.find(c => c.id === current.inClipId)!, join);
        incoming.clock.duration = multiplyTime(rational(incoming.durationFrames), incoming.clock.rate);
        out.clock.duration = multiplyTime(rational(out.durationFrames), out.clock.rate);
        next.transitions = next.transitions.filter(t => t.id !== current.id);
      }
      if (wanted) {
        // The join is read from the released document, never from the request.
        const join = transitionJoins(next).find(j => j.joinKey === command.joinKey);
        if (!join) throw new SequenceError('MISSING_TARGET', '対象のつなぎ目が見つかりません', [command.joinKey]);
        if (wanted.joinKey !== command.joinKey || wanted.joinFrame !== join.frame || wanted.trackId !== join.trackId
          || wanted.outClipId !== join.outClipId || wanted.inClipId !== join.inClipId)
          throw new SequenceError('INVALID_RANGE', '転換の内容が対象のつなぎ目と一致しません', [command.joinKey]);
        const frame = join.frame;
        // 2) 同じつなぎ目の単色フェードは排他。resolveSceneFade と同じ中点一致だけを外す。
        const removed = next.clips.filter(c => {
          if (c.content.kind !== 'scene-fade' || c.content.phase !== 'join') return false;
          try { return compareTime(sceneFadeEndpoint(c), rational(frame)) === 0; } catch { return false; }
        });
        if (removed.length) {
          const lanes = new Set(removed.map(c => c.trackId));
          next.clips = next.clips.filter(c => !removed.includes(c));
          // editSceneFades never keeps an empty colour lane; do not leave one behind.
          const empty = [...lanes].filter(id => !next.clips.some(c => c.trackId === id)
            && !document.clips.some(c => c.trackId === id && c.content.kind !== 'scene-fade'));
          next.tracks = next.tracks.filter(t => !empty.includes(t.id));
        }
        const out = next.clips.find(c => c.id === join.outClipId)!, incoming = next.clips.find(c => c.id === join.inClipId)!;
        const before = frame - wanted.startFrame, after = wanted.startFrame + wanted.durationFrames - frame;
        // The released incoming clip is the origin. Using the pre-release one would
        // shift its source by the overlap being replaced.
        const source = structuredClone(incoming);
        out.durationFrames += after;
        out.clock.duration = multiplyTime(rational(out.durationFrames), out.clock.rate);
        incoming.startFrame -= before; incoming.durationFrames += before;
        if (incoming.content.kind === 'video' || incoming.content.kind === 'audio')
          incoming.content.sourceIn = sourceTimeAt(source, source.startFrame - before, document.fps);
        incoming.clock.offset = effectFrameAt(source, source.startFrame - before);
        incoming.clock.duration = multiplyTime(rational(incoming.durationFrames), incoming.clock.rate);
        next.transitions.push({ ...structuredClone(wanted), id: allocator(document)('transition') });
      }
      break;
    }
    case 'batch': {
      next = document;
      for (const operation of command.commands) next = applySequenceCommand(next, operation);
      break;
    }
    case 'resize-cut-boundary': next=resizeCutBoundary(document,command,applySequenceCommand,allocator);break;
    case 'restore-cut': next=restoreArchivedCut(document,command,{rebuild,fresh:allocator,validate:validateSequenceDocument});break;
    case 'reorder-ranges': {
      if(!Array.isArray(command.ranges)||!command.ranges.length||command.ranges.length>100000)throw new SequenceError('INVALID_RANGE','残す区間を指定してください');
      const ordered:Array<{startFrame:number;endFrame:number;destination:number}>=[];let duration=0;
      for(const item of command.ranges) {
        range(item.startFrame,item.endFrame);
        if(item.startFrame===item.endFrame||item.endFrame>document.sequenceEndFrame)throw new SequenceError('INVALID_RANGE','並べ替える区間がシーケンス外です');
        const prior=ordered.at(-1);
        if(prior&&prior.endFrame===item.startFrame)prior.endFrame=item.endFrame;
        else ordered.push({...item,destination:duration});
        duration+=item.endFrame-item.startFrame;
        if(!Number.isSafeInteger(duration))throw new SequenceError('INVALID_RANGE','並べ替え後の長さが大きすぎます');
      }
      const sorted=[...ordered].sort((a,b)=>a.startFrame-b.startFrame);
      if(sorted.some((item,index)=>index>0&&item.startFrame<sorted[index-1]!.endFrame))throw new SequenceError('INVALID_RANGE','同じ区間を重ねて採用できません');
      if(ordered.length===1&&ordered[0]!.startFrame===0&&ordered[0]!.endFrame===document.sequenceEndFrame)return document;
      for(const fade of document.clips.filter(clip=>clip.content.kind==='scene-fade')) {
        if(ordered.some(item=>overlaps(item.startFrame,item.endFrame,fade.startFrame,clipEnd(fade))&&(item.startFrame>fade.startFrame||item.endFrame<clipEnd(fade))))
          throw new SequenceError('TRANSITION_INTERSECTION','場面フェードの途中では区間を並べ替えられません',[fade.id]);
      }
      for(const clip of document.clips) {
        const slices:Slice[]=ordered.flatMap(item=>{
          const from=Math.max(clip.startFrame,item.startFrame),to=Math.min(clipEnd(clip),item.endFrame);
          return from<to?[{from,to,start:item.destination+from-item.startFrame}]:[];
        });
        // Preserve any intentionally hidden tail beyond the visible sequence end.
        const from=Math.max(clip.startFrame,document.sequenceEndFrame);
        if(from<clipEnd(clip))slices.push({from,to:clipEnd(clip),start:duration+from-document.sequenceEndFrame});
        recipes.set(clip.id,slices);
      }
      if(document.speed)document=upgradeNativeSpeedMetadata(document);
      next=rebuild(document,recipes,frame=>{
        const item=ordered.find(item=>item.startFrame<=frame&&frame<item.endFrame);
        return item?item.destination+frame-item.startFrame:frame;
      },false,false,document.speed?{sequenceEndFrame:duration}:undefined);
      for(const entry of next.cutArchive?.entries??[])if(!entry.boundary.references.length)entry.boundary.ambiguous=true;
      next.sequenceEndFrame=duration;break;
    }
    case 'ripple-delete': {
      const cut = rippleDeleteRange(document, command.startFrame, command.endFrame);
      if (cut.next === document) return document;   // start===end の no-op（従来と同じ順序・同じ戻り値）
      document = cut.base; next = cut.next; break;
    }
    case 'split': {
      range(command.frame, command.frame);
      const selected = targets(document, command.clipIds, command.linked !== false);
      const fade = document.clips.find(c => selected.has(c.id) && c.content.kind === 'scene-fade' && c.startFrame < command.frame && command.frame < clipEnd(c));
      if (fade) throw new SequenceError('TRANSITION_INTERSECTION', '場面フェードの途中では分割できません', [fade.id]);
      for (const t of document.transitions) {
        if ((selected.has(t.outClipId) || (t.inClipId && selected.has(t.inClipId)))
          && t.startFrame < command.frame && command.frame < t.startFrame + t.durationFrames) {
          throw new SequenceError('TRANSITION_INTERSECTION', '転換の途中では分割できません', [t.id]);
        }
      }
      for (const clip of document.clips) {
        if (!selected.has(clip.id) || command.frame <= clip.startFrame || command.frame >= clipEnd(clip)) continue;
        recipes.set(clip.id, [
          { from: clip.startFrame, to: command.frame, start: clip.startFrame },
          { from: command.frame, to: clipEnd(clip), start: command.frame },
        ]);
      }
      if(!recipes.size){next=document;break;}
      if(command.linked===false)document=detachInsertOwnLinks(document,selected);
      if(document.speed)document=upgradeNativeSpeedMetadata(document);
      const independent=document.speed&&(command.linked===false||document.clips.some(c=>selected.has(c.id)&&c.speed?.kind==='independent-audio'));
      next = independent?rebuild(document,recipes,frame=>frame,false,false,{}):rebuild(document, recipes,frame=>frame,true);
      break;
    }
    case 'delete': {
      for (const id of targets(document, command.clipIds, command.linked !== false)) recipes.set(id, []);
      if(command.linked===false)document=detachInsertOwnLinks(document,new Set(command.clipIds));
      if(!recipes.size)return document;
      if(document.speed)document=upgradeNativeSpeedMetadata(document);
      next = rebuild(document, recipes,frame=>frame,false,false,document.speed?{}:undefined);
      break;
    }
    case 'move': {
      if (!Number.isSafeInteger(command.deltaFrames)) throw new SequenceError('INVALID_RANGE', '移動量が不正です');
      const selected = targets(document, command.clipIds, command.linked !== false);
      for (const t of document.transitions) {
        if (selected.has(t.outClipId) || (t.inClipId && selected.has(t.inClipId))) {
          throw new SequenceError('TRANSITION_INTERSECTION', '転換があるクリップは先に転換を解除してください', [t.id]);
        }
      }
      for (const clip of document.clips) if (selected.has(clip.id)) {
        // Track reassignment applies to explicitly dragged clips, not their linked audio.
        recipes.set(clip.id, [{ from: clip.startFrame, to: clipEnd(clip), start: clip.startFrame + command.deltaFrames,
          ...(command.trackId && command.clipIds.includes(clip.id) ? { trackId: command.trackId } : {}) }]);
      }
      let movedSource = structuredClone(document);
      for (const clip of movedSource.clips) {
        if (selected.has(clip.id) && clip.anchor?.kind === 'source' && !selected.has(clip.anchor.clipOccurrenceId)) {
          clip.anchor = { kind: 'timeline' };
        }
      }
      if(command.deltaFrames===0&&document.clips.every(c=>!selected.has(c.id)||((!command.trackId||c.trackId===command.trackId)&&!(c.anchor?.kind==='source'&&!selected.has(c.anchor.clipOccurrenceId)))))return document;
      if(command.linked===false)movedSource=detachInsertOwnLinks(movedSource,selected);
      next = rebuild(document.speed?upgradeNativeSpeedMetadata(movedSource):movedSource, recipes,frame=>frame,false,false,document.speed?{grow:true}:undefined);
      next.sequenceEndFrame = Math.max(document.sequenceEndFrame, ...next.clips.filter(c => selected.has(c.id)).map(clipEnd));
      break;
    }
    case 'trim': {
      range(command.frame, command.frame);
      // selected・original を計画より前に評価するのは、存在しない clipId を MISSING_TARGET のまま保つため。
      const selected = targets(document, [command.clipId], command.linked !== false);
      const original = document.clips.find(c => c.id === command.clipId)!;
      const plan: RippleTrimPlan = command.ripple ? rippleTrimPlan(document, command) : { kind: 'plain' };
      if (plan.kind === 'reject') throw new SequenceError(
        plan.reason === 'transition' ? 'TRANSITION_INTERSECTION' : 'INVALID_RANGE',
        plan.reason === 'transition' ? '転換を含む範囲は先に転換を解除してください'
          : plan.reason === 'speed' ? '速度を登録したクリップと固定挿入は詰められません。「詰める」を切ると従来のトリムになります'
          : 'クリップには1フレーム以上必要です', [command.clipId]);
      if (plan.kind === 'close') {
        // 範囲操作なので linked:false は無関係（detachInsertOwnLinks は呼ばない）。
        const cut = rippleDeleteRange(document, plan.startFrame, plan.endFrame);
        document = cut.base; next = cut.next; effect = cut.as; break;
      }
      if (plan.kind === 'join') {   // linked:false は rippleTrimPlan が先に落とす（裁定 8）
        // 設計 §6 は「rebuild の後に付け替える」と書くが、rebindCutArchiveFragments（cutArchive.ts:75）は
        // R の recipe が空なのを見て参照を落とし boundary.ambiguous=true にしてしまう。rebuild の
        // *前* に L へ寄せておくと、以後は L の断片として正しく追従する。字幕 anchor も同じ理由。
        let source = rebindClipReferences(document, plan.rightId, plan.leftId);
        if (plan.audio) source = rebindClipReferences(source, plan.audio.rightId, plan.audio.leftId);
        const pairs: Array<[string, string]> = [[plan.leftId, plan.rightId],
          ...(plan.audio ? [[plan.audio.leftId, plan.audio.rightId] as [string, string]] : [])];
        const extra = plan.push?.delta ?? 0;
        for (const [leftId, rightId] of pairs) {
          const left = source.clips.find(c => c.id === leftId), right = source.clips.find(c => c.id === rightId);
          if (!left || !right) throw new SequenceError('MISSING_TARGET', '対象のクリップが見つかりません', [leftId, rightId]);
          // 結合後さらに越えた分（extra）も L をそのまま伸ばす。§4-4 が R の source 連続を保証するので、
          // R の末尾から先は「R をさらに伸ばす」のと同じ意味になる。素材の残りが足りなければ
          // validateSequenceDocument が「クリップが素材の終端を越えています」で断る（文書・履歴は不変）。
          recipes.set(leftId, [{ from: left.startFrame, to: clipEnd(right) + extra, start: left.startFrame }]);
          recipes.set(rightId, []);
        }
        if (plan.push) pushRecipes(source, recipes, plan.push.atFrame, plan.push.delta, new Set(pairs.flat()));
        // §4-6 が join を document.speed===undefined に限る（losslessJoin の条件 6）ので、
        // rebuild の速度引数は渡さない。speed 案件の join を許すならここも同時に直すこと。
        next = rebuild(source, recipes, frame => plan.push && frame >= plan.push.atFrame ? frame + plan.push.delta : frame);
        // 結合は尺を増やさない。増えるのは押し出した分だけ（§5。ripple-delete の対称形）。
        next.sequenceEndFrame = document.sequenceEndFrame + extra;
        break;
      }
      if (plan.kind === 'push') {
        // 範囲操作なので linked:false は無関係（detachInsertOwnLinks は呼ばない）。
        // 対象自身の延長 recipe だけは従来 trim と同じ選択規則に従う。
        const base = document.speed ? upgradeNativeSpeedMetadata(document) : document;
        const target = base.clips.find(c => c.id === command.clipId)!;
        const grow = command.frame - clipEnd(target);
        for (const clip of base.clips) if (selected.has(clip.id))
          recipes.set(clip.id, [{ from: clip.startFrame, to: clipEnd(clip) + grow, start: clip.startFrame }]);
        pushRecipes(base, recipes, plan.atFrame, plan.delta, selected);
        next = rebuild(base, recipes, frame => frame >= plan.atFrame ? frame + plan.delta : frame, false, false,
          base.speed ? { sequenceEndFrame: base.sequenceEndFrame + plan.delta } : undefined);
        // 従来 trim（:474）と同じく、選択クリップが尺を越えたらそこまで広げる。
        if (!base.speed) next.sequenceEndFrame = Math.max(base.sequenceEndFrame + plan.delta,
          ...next.clips.filter(c => selected.has(c.id)).map(clipEnd));
        document = base; break;
      }
      // clamp は端の位置を隣の接点へ差し替えるだけ。以降の従来 trim は command.frame ではなく frame を使う。
      const frame = plan.kind === 'clamp' ? plan.frame : command.frame;
      const delta = frame - (command.edge === 'start' ? original.startFrame : clipEnd(original));
      for (const clip of document.clips) if (selected.has(clip.id)) {
        const from = command.edge === 'start' ? clip.startFrame + delta : clip.startFrame;
        const to = command.edge === 'end' ? clipEnd(clip) + delta : clipEnd(clip);
        range(from, to);
        if (from === to) throw new SequenceError('INVALID_RANGE', 'クリップには1フレーム以上必要です', [clip.id]);
        recipes.set(clip.id, [{ from, to, start: from }]);
      }
      const registeredTarget=original.speed!==undefined;
      if(delta===0)return document;
      if(command.linked===false)document=detachInsertOwnLinks(document,selected);
      next = registeredTarget?(command.linked===false||original.speed?.kind==='independent-audio'?rebuild(upgradeNativeSpeedMetadata(document),recipes,frame=>frame,false,false,{grow:true}):rebuild(upgradeNativeSpeedMetadata(document),recipes,frame=>frame,false,true)):rebuild(document,recipes);
      next.sequenceEndFrame = Math.max(document.sequenceEndFrame, ...next.clips.filter(c => selected.has(c.id)).map(clipEnd));
      if(next.speed&&!registeredTarget){
        if(next.sequenceEndFrame!==document.sequenceEndFrame){const end=next.speed.sequenceEndBasis;if(end.kind==='empty-fixed')end.endFrame=next.sequenceEndFrame;
        else end.offsetFrames=next.sequenceEndFrame-speedProjectionForDocument(document).mainEndFrame;}
        if(next.speed.version===2)refreshCaptionBaselines(next);
      }
      break;
    }
    case 'unlink': {
      const selected = targets(document, command.clipIds, true);
      if(!document.clips.some(c=>selected.has(c.id)&&c.linkGroupId))return document;
      next = document.speed?upgradeNativeSpeedMetadata(document):structuredClone(document);
      next=structuredClone(next);
      for (const clip of next.clips) if (selected.has(clip.id)) delete clip.linkGroupId;
      if(document.speed)next=rebuild(next,new Map(),frame=>frame,false,false,{});
      break;
    }
    case 'add-track': {
      if(archiveReservedIds(document).includes(command.track.id))throw new SequenceError('INVALID_DOCUMENT','カット復元記録が所有するトラックIDは再利用できません');
      const index = command.index ?? document.tracks.length;
      if (!Number.isSafeInteger(index) || index < 0 || index > document.tracks.length) throw new SequenceError('INVALID_RANGE', 'トラックの挿入位置が不正です');
      next = structuredClone(document);
      next.tracks.splice(index, 0, structuredClone(command.track));
      break;
    }
    case 'remove-track': {
      if (!document.tracks.some(t=>t.id===command.trackId)) throw new SequenceError('MISSING_TARGET','対象のトラックが見つかりません',[command.trackId]);
      if (document.clips.some(c=>c.trackId===command.trackId)) throw new SequenceError('INVALID_RANGE','クリップを移動または削除して、空にしてからトラックを削除してください',[command.trackId]);
      next=structuredClone(document);
      next.tracks=next.tracks.filter(t=>t.id!==command.trackId);
      break;
    }
    case 'insert': {
      const reserved=new Set(archiveReservedIds(document));
      if(command.clips.some(c=>reserved.has(c.id)))throw new SequenceError('INVALID_DOCUMENT','カット復元記録が所有するIDは再利用できません');
      if(command.clips.some(c=>c.insertOwnSpeed))throw new SequenceError('INVALID_DOCUMENT','挿入の速度基準には専用登録コマンドが必要です',command.clips.filter(c=>c.insertOwnSpeed).map(c=>c.id));
      next = structuredClone(document);
      next.clips.push(...structuredClone(command.clips));
      next.sequenceEndFrame = Math.max(document.sequenceEndFrame, ...command.clips.map(clipEnd));
      next=rebindSpeedInsert(document,next,command.clips.map(c=>c.id));
      break;
    }
    case 'register-assets': {
      next = structuredClone(document);
      for (const asset of command.assets) {
        const existing = next.assets.find(a => a.id === asset.id);
        if (existing && (existing.fingerprint !== asset.fingerprint || existing.kind !== asset.kind))
          throw new SequenceError('INVALID_DOCUMENT', '同じ素材IDに異なる素材があります', [asset.id]);
        if (!existing) next.assets.push(structuredClone(asset));
        else if(!existing.textStyleCatalog&&asset.textStyleCatalog)existing.textStyleCatalog=structuredClone(asset.textStyleCatalog);
        else if(existing.textStyleCatalog&&asset.textStyleCatalog){
          // I-6 / I-1: 旧いカタログは packId/version/componentHash を、I-1 以前のカタログは
          // animations を持たない。欠けている項目だけを補い、既に入っている値・source・entries は
          // 上書きしない（凍結資産の同一性を後から書き換えないため）。2 回目は差分が出ない。
          for(const key of ['packId','version','componentHash','animations'] as const)
            if(existing.textStyleCatalog[key]===undefined&&asset.textStyleCatalog[key]!==undefined)
              existing.textStyleCatalog[key]=asset.textStyleCatalog[key] as never;
        }
      }
      break;
    }
    case 'remove-asset': {
      if (!document.assets.some(a => a.id === command.assetId))
        throw new SequenceError('MISSING_TARGET', '対象の素材が見つかりません', [command.assetId]);
      const used = sequenceAssetReferences(document, command.assetId);
      if (used.length)
        throw new SequenceError('BROKEN_REFERENCE',
          `使っている素材は外せません（${used.length}か所: ${used.slice(0, 3).map(u => u.detail).join('、')}）`,
          used.flatMap(u => u.clipId ? [u.clipId] : []));
      next = structuredClone(document);
      next.assets = next.assets.filter(a => a.id !== command.assetId);
      break;
    }
    case 'replace-audio-source': {
      const to = document.assets.find(a => a.id === command.toAssetId);
      if (!to || !document.assets.some(a => a.id === command.fromAssetId))
        throw new SequenceError('MISSING_TARGET', '差し替える素材が見つかりません', [command.fromAssetId, command.toAssetId]);
      const moved = document.clips.filter(c => c.trackId === command.trackId && c.content.kind === 'audio' && c.content.assetId === command.fromAssetId);
      // M7: 何も動かせなかった（指定トラックに fromAssetId の音声クリップが無い）場合は
      // 無変化の成功ではなく拒否する。呼び出し側（UI）が「戻せませんでした」を出せるようにする。
      if (!moved.length) throw new SequenceError('MISSING_TARGET', '差し替える音声クリップが見つかりません', [command.trackId, command.fromAssetId]);
      for (const clip of moved) {
        const content = clip.content; if (content.kind !== 'audio') continue;
        const stream = to.streams.find(s => s.index === content.streamIndex && s.kind === 'audio');
        if (!stream) throw new SequenceError('BROKEN_REFERENCE', '差し替え先に同じ音声ストリームがありません', [clip.id]);
        if (stream.duration !== undefined && compareTime(sourceTimeAt(clip, clipEnd(clip), document.fps), stream.duration) > 0)
          throw new SequenceError('BROKEN_REFERENCE', '差し替え先の音声の長さが足りません', [clip.id]);
      }
      const ids = new Set(moved.map(c => c.id));
      next = structuredClone(document);
      for (const clip of next.clips) {
        if (ids.has(clip.id) && clip.content.kind === 'audio') clip.content.assetId = command.toAssetId;
        if (clip.anchor?.kind === 'source' && ids.has(clip.anchor.clipOccurrenceId)) clip.anchor.sourceAssetId = command.toAssetId;
      }
      const streams = new Set(moved.flatMap(c => c.content.kind === 'audio' ? [c.content.streamIndex] : []));
      for (const transcript of next.transcripts)
        if (transcript.assetId === command.fromAssetId && streams.has(transcript.streamIndex)) transcript.assetId = command.toAssetId;
      break;
    }
    case 'replace-text-style-asset': {
      // 旧資産は消さない。参照だけをクリップ単位で切り替えるので、Undo 1 回で旧描画へ戻る。
      const to = document.assets.find(a => a.id === command.toAssetId);
      if (!to || to.kind !== 'component' || !document.assets.some(a => a.id === command.fromAssetId))
        throw new SequenceError('MISSING_TARGET', '差し替える描画部品が見つかりません', [command.fromAssetId, command.toAssetId]);
      if (!to.textStyleCatalog)
        throw new SequenceError('MISSING_TARGET', '切替先のスタイル部品にカタログがありません', [command.fromAssetId, command.toAssetId]);
      const moved = document.clips.filter(c => c.content.kind === 'telop' && textComponentId(document, c.content) === command.fromAssetId);
      if (!moved.length) throw new SequenceError('MISSING_TARGET', '切り替える字幕が見つかりません', [command.fromAssetId]);
      const ids = new Set(moved.map(c => c.id));
      next = structuredClone(document);
      for (const clip of next.clips) if (ids.has(clip.id) && clip.content.kind === 'telop') clip.content.componentAssetId = command.toAssetId;
      break;
    }
    case 'move-track': {
      const from = document.tracks.findIndex(t => t.id === command.trackId);
      if (from < 0) throw new SequenceError('MISSING_TARGET', '対象のトラックが見つかりません', [command.trackId]);
      if (!Number.isSafeInteger(command.index) || command.index < 0 || command.index >= document.tracks.length)
        throw new SequenceError('INVALID_RANGE', 'トラックの移動先が不正です');
      next = structuredClone(document);
      const track = next.tracks.splice(from, 1)[0]!;
      next.tracks.splice(command.index, 0, track);
      break;
    }
    case 'set-track-enabled': {
      next = structuredClone(document);
      const track = next.tracks.find(t => t.id === command.trackId);
      if (!track) throw new SequenceError('MISSING_TARGET', '対象のトラックが見つかりません', [command.trackId]);
      track.enabled = command.enabled;
      break;
    }
    case 'set-transcript': {
      const value=command.transcript,asset=document.assets.find(asset=>asset.id===value.assetId);
      if(!asset || asset.fingerprint!==command.assetFingerprint)throw new SequenceError('REVISION_CONFLICT','文字起こしの対象素材が変わっています');
      const current=document.transcripts.find(item=>item.assetId===value.assetId && item.streamIndex===value.streamIndex)??null;
      if(transcriptIdentity(current)!==transcriptIdentity(command.before))throw new SequenceError('REVISION_CONFLICT','生成中に文字起こしが変わりました。現在の内容を確認してください');
      next=structuredClone(document);
      const index=next.transcripts.findIndex(item=>item.assetId===value.assetId && item.streamIndex===value.streamIndex);
      if(index<0)next.transcripts.push(structuredClone(value));else next.transcripts[index]=structuredClone(value);
      break;
    }
    case 'set-ducking': {
      const patch=command.patch;
      if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['enabled','strength'].includes(key))
        ||('enabled' in patch&&typeof patch.enabled!=='boolean')||('strength' in patch&&!['weak','mid','strong'].includes(patch.strength!)))
        throw new SequenceError('INVALID_RANGE','BGMの自動音量調整の設定が不正です');
      next=structuredClone(document);next.ducking={...next.ducking,...patch};break;
    }
    case 'set-script': {
      if(command.script!==null)scriptDocumentSchema.parse(command.script);
      if((document.scriptDocument?.text??'')===(command.script?.text??'')) return document;
      next=structuredClone(document);
      if(command.script===null) delete next.scriptDocument;
      else next.scriptDocument=structuredClone(command.script);
      break;
    }
    case 'update-clip': {
      next = structuredClone(document);
      const clip = next.clips.find(c => c.id === command.clipId);
      if (!clip) throw new SequenceError('MISSING_TARGET', '対象のクリップが見つかりません', [command.clipId]);
      // Explicit keys keep untrusted callers from changing IDs/time through a property edit.
      if (command.patch.name !== undefined) clip.name = command.patch.name;
      if (command.patch.visual !== undefined) clip.visual = structuredClone(command.patch.visual);
      if (command.patch.content !== undefined) clip.content = structuredClone(command.patch.content);
      guardInsertOwnProperty(document.clips.find(c=>c.id===command.clipId)!,clip);
      next=rebindSpeedProperty(document,next,command.clipId);
      break;
    }
    case 'apply-text-style-all': {
      const asset=document.assets.find(item=>item.id===command.assetId&&item.kind==='component');
      if(!asset?.textStyleCatalog)throw new SequenceError('MISSING_TARGET','スタイルの部品が見つかりません。スタイル一覧を開き直してください。',[command.assetId]);
      if(!asset.textStyleCatalog.entries.some(entry=>entry.id===command.styleId))
        throw new SequenceError('INVALID_RANGE','このスタイル番号は一覧にありません。もう一度選んでください。');
      // Imported headings can also be telops. The inspector scopes bulk edits to their track.
      if(command.trackId!==undefined&&!document.tracks.some(track=>track.id===command.trackId))
        throw new SequenceError('MISSING_TARGET','適用先のトラックが見つかりません。',[command.trackId]);
      // 解除するのは「移行先が宣言していない動き」だけ。全件を none にすると、確認画面が
      // 数えた件数（telopClipsLosingAnimation）より多くの字幕を壊す（I-3）。
      // 全件が command.styleId になるので、判定もそのスタイルの宣言で行う（裁定 5）。
      const support=assetAnimationSupport(asset,command.styleId);
      next=structuredClone(document);
      for(const clip of next.clips){
        if(clip.content.kind!=='telop'||(command.trackId!==undefined&&clip.trackId!==command.trackId))continue;
        clip.content.textMode='component';clip.content.componentAssetId=command.assetId;clip.content.data.template=command.styleId;
        // 動きの解除とスタイル変更は 1 コマンド＝ 1 Undo にまとめる。字幕 300 行の案件では
        // update-clip を並べると MAX_SEQUENCE_COMMAND_LEAVES（50）を超えるため batch は使えない。
        const animation=clip.content.data.animation as TelopAnimationId|undefined;
        if(command.clearUnsupportedAnimations&&animation!==undefined&&animation!=='none'
          &&!supportsAnimation(support,animation))clip.content.data.animation='none';
      }
      break;
    }
    case 'set-text-style-hidden': {
      if(!document.assets.some(item=>item.id===command.assetId&&item.kind==='component'))
        throw new SequenceError('MISSING_TARGET','スタイルの部品が見つかりません。',[command.assetId]);
      const hidden=[...new Set(command.hidden)].filter(hid=>Number.isSafeInteger(hid)&&hid>0).sort((a,b)=>a-b);
      next=structuredClone(document);
      next.textStylePrefs={hidden:{...next.textStylePrefs?.hidden,[command.assetId]:hidden}};
      break;
    }
  }
  // restore-cut explicitly restores the archived ordinary completion floor as well.
  if(effect.type!=='restore-cut'&&effect.type!=='resize-cut-boundary')next=rebindInsertOwnCompletion(document,next,effect);
  if(!['batch','resize-cut-boundary','upgrade-native-speed-operations','set-native-global-speed','set-native-main-speed','reset-native-main-speed'].includes(command.type))next=rebindOperationBasis(document,next);
  if (sequenceContentBytes(next) === originalContent) return document;
  next.revision = document.revision + 1;
  validateSequenceDocument(next);
  return next;
}
