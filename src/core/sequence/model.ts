import type { ColorGrade } from '../colorGrade';
import type { MainAudioSettings } from '../mainAudio';
import type { ScriptDocument } from '../scriptAlignment';
import type { Motion } from '../motion';
import type { EditorTelop, EditorTitle, EditorShape, ElementAnim, ImageType, MainLayout, TitleStyle } from '../types';
import { addTime, frameSeconds, multiplyTime, rational, type Rational } from './time';

export interface MediaStream {
  index: number;
  kind: 'video' | 'audio';
  duration: Rational;
  codec: string;
  frameRate?: Rational;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  rotation?: number;
  sampleAspectRatio?: Rational;
  color?: { primaries: string; transfer: string; matrix: string; range: 'full' | 'limited' | 'unknown' };
}
export interface SequenceAsset {
  id: string;
  kind: 'media' | 'image' | 'lut' | 'component';
  /** Project-relative managed path; its existence is checked at the server boundary. */
  file: string;
  name: string;
  fingerprint: string;
  streams: MediaStream[];
  /** Content-immutable lineage. An audio fix registers a new asset; it never rewrites bytes in place. */
  origin?: { kind: 'audio-fix'; from: string; fix: 'denoise' | 'normalize' }
    | { kind: 'import'; role: 'music' | 'effect' };
  /** Frozen identity of the style component. A pack update never rewrites an existing project's copy. */
  // packId/version/componentHash are optional: projects saved before T0b have none.
  // They are filled in when the style tab prepares its assets (POST /api/sequence/text-styles →
  // backfillTextStyleCatalog → register-assets), not on plain load. A document that has never been
  // through that route still has all three missing, so never assume they are present.
  textStyleCatalog?: { source: 'builtin' | 'project' | 'installed'; packId?: string; version?: string;
    componentHash?: string; entries: { id: number; name: string;
      /** このスタイル固有の対応アニメーション。**未定義＝固有の宣言が無い**＝カタログ単位へフォールバック
       *  （T6 以前に保存された案件はすべてこの形。挙動は従来どおり）。 */
      animations?: string[] }[];
    /** 部品が `export const TELOP_ANIMATIONS` で宣言した対応アニメーション。未定義＝「不明」＝全種非対応。 */
    animations?: string[] };
}
export interface SequenceTrack {
  id: string;
  kind: 'visual' | 'audio';
  name: string;
  enabled: boolean;
}

/** Remains tied to the original effect interval when a clip is sliced. */
export interface EffectClock {
  offset: Rational;
  rate: Rational;
  duration: Rational;
}
export interface SourceAnchor {
  kind: 'source';
  role: 'speech' | 'visual';
  sourceAssetId: string;
  clipOccurrenceId: string;
  sourceStart: Rational;
  sourceEnd: Rational;
}
export type ClipAnchor = SourceAnchor | { kind: 'timeline' };
/** Private native registration basis; HTTP/UI exposure requires command rebinding first. */
export interface NativeSpeedDocumentMetadata {
  version: 1 | 2;
  family: 'native-exact-v1';
  /** Explicit operation upgrade; separates source lineage from per-piece rate. */
  projectionPolicy?: 'split-rate-v1';
  groupId: string;
  /** Saved once; validation must never derive this from live clip placement. */
  originFrame: number;
  fpsBasis: Rational;
  globalRate: Rational;
  sequenceEndBasis: { kind: 'main-offset'; offsetFrames: number } | { kind: 'empty-fixed'; offsetFrames: 0; endFrame: number };
}
export interface SpeedClockBasis {
  offset: Rational;
  /** Effect/key clock units per unit of the owner's pre-speed frame basis. */
  slope: Rational;
  duration: Rational;
}
export interface SpeedSourceBasis {
  assetId: string;
  streamIndex: number;
  sourceStart: Rational;
  /** Adopted requested window end, not a recovered original cut or decoded EOF. */
  sourceEnd: Rational;
}
/** v2: source intent and render IDs survive a rounded zero-length caption part. */
export interface SpeedCaptionPart {
  partId: string; providerId: string; intentStart: Rational; intentEnd: Rational;
  reservedRenderId: string; continuationGroupId?: string;
  /** Explicit edit of this part; later split descendants inherit it, siblings do not. */
  presentation?: { template: SpeedCaptionLedger['template'] };
}
export interface SpeedCaptionLedger {
  captionId: string;
  template: Omit<SequenceClip, 'id' | 'startFrame' | 'durationFrames' | 'clock' | 'anchor' | 'speed' | 'continuationGroupId'>;
  role: 'speech' | 'visual'; sourceOrigin: Rational;
  clock: SpeedClockBasis; keyframeClock?: SpeedClockBasis;
  parts: SpeedCaptionPart[];
  /** Explicit ordinary fragments detached from this source ledger; never inferred by group alone. */
  detachedContinuations?: { clipId: string; continuationGroupId: string; sourceFrameOffset: Rational; mediaRate: Rational }[];
  baselineProjection: { snapshotKey: string; inputKey: string; parts: { partId: string; startFrame: number; endFrame: number }[] };
}
export type NativeClipSpeedBasis =
  | { kind: 'main'; groupId: string; order: number; span: Rational; override?: Rational;
      runHead?: { phase: Rational; gapFrames: number }; overlapBefore?: Rational;
      /** Original whole projection cell; trim only changes this clip intent window. */
      projectionExtent?: Rational; projectionOffset?: Rational; evaluationSourceStart?: Rational;
      /** Last explicit topology edit: retained anchor window and fixed gap.
       * Subsequent trim changes visible offsets only; original phase/cap survive. */
      structuralPlacement?: { phase: Rational; gapFrames: number; anchorStart: Rational; anchorEnd: Rational };
      evaluationOwnerId?: string; source: SpeedSourceBasis; clock: SpeedClockBasis; keyframeClock?: SpeedClockBasis }
  | { kind: 'main-audio'; providerId: string; evaluationOwnerId?: string; evaluationSourceStart?: Rational;
      /** Media rate belongs to the provider; only this audio stream/intent is stored here. */
      source: SpeedSourceBasis;
      clock: SpeedClockBasis; keyframeClock?: SpeedClockBasis }
  /** Explicit one-sided edit: fixed placement and own media clock, no main provider. */
  | { kind: 'independent-audio'; evaluationOwnerId?: never; placement: { startFrame: number }; mediaRate: Rational;
      projection: { mode: 'absolute' | 'cumulative'; phase: Rational; offset: Rational };
      evaluationSourceStart: Rational; source: SpeedSourceBasis; clock: SpeedClockBasis; keyframeClock?: SpeedClockBasis };
/** One clip-owned shared historical input; never embeds ledgers or earlier snapshots. */
export interface SpeedCaptionBaseline {
  key: string;
  input: { document: NativeSpeedDocumentMetadata; providers: { id: string; basis: NativeClipSpeedBasis }[] };
}
export type SpeedTimingPoint = {kind:'fixed';frame:number} | {kind:'clip'|'gap-before'|'after-main';ownerId:string;offset:Rational};
export interface SpeedTimingClip {
  logicalId:string;
  snapshotKey:string;
  original:Omit<SequenceClip,'speed'>;
  parts:{renderId:string;start:SpeedTimingPoint;end:SpeedTimingPoint}[];
}
export interface SpeedTimingFade {snapshotKey:string;original:SequenceTransition;start:SpeedTimingPoint;end:SpeedTimingPoint}
export interface SpeedTimingBasis {baselines:SpeedCaptionBaseline[];clips:SpeedTimingClip[];fades:SpeedTimingFade[]}
export interface NativeSpeedOperationBasis {version:1;order:string[];timing?:SpeedTimingBasis}
export type NativeClipSpeedMetadata = NativeClipSpeedBasis & {
  operationBasis?: NativeSpeedOperationBasis;
  captions?: SpeedCaptionLedger[];
  captionBaselines?: SpeedCaptionBaseline[];
};
export interface TransformKey {
  /** Position on the original effect clock, NOT the sliced clip's normalized length. */
  frame: Rational;
  value: Partial<Omit<MainLayout, 'background'>> & {opacity?:number};
  /** Legacy global layout keys use cubic easing; new keys default to linear. */
  easing?: 'linear' | 'easeInOut';
}
export interface ClipVisual {
  layout: MainLayout;
  opacity: number;
  keyframes: TransformKey[];
  keyframeClock?: EffectClock;
  keyframesOutside?: 'base' | 'hold';
  motion?: Motion;
  enter?: ElementAnim;
  exit?: ElementAnim;
  colorGrade?: ColorGrade;
  lut?: { assetId: string; intensity: number };
}

type ElementData<T> = Omit<T, 'id' | 'originalStart' | 'originalEnd' | 'timelinePlacement'>;
export interface TextAppearance {
  fontFamily: string; fontSize: number; fontWeight: number; color: string;
  strokeColor: string; strokeWidth: number; background: string;
  align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number;
}
export const DEFAULT_TEXT_APPEARANCE: TextAppearance = {
  fontFamily: '"Noto Sans JP", "Hiragino Sans", sans-serif', fontSize: 64, fontWeight: 600,
  color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, background: 'transparent',
  align: 'center', lineHeight: 1.4, letterSpacing: 0,
};
export type ClipContent =
  | { kind: 'video'; assetId: string; streamIndex: number; sourceIn: Rational; rate: Rational; endBehavior?: 'hold' }
  | { kind: 'audio'; assetId: string; streamIndex: number; sourceIn: Rational; rate: Rational;
      role: 'speech' | 'music' | 'effect'; settings: MainAudioSettings; loop: boolean; endBehavior?: 'silence' }
  | { kind: 'image'; assetId: string; style?: ImageType; legacyId?: number }
  /** Legacy fades cover the complete composed scene, including subtitles. */
  | { kind: 'scene-fade'; color: string; phase: 'head' | 'tail' | 'join' }
  | { kind: 'telop'; data: ElementData<EditorTelop>; legacyId?: number; appearance?: TextAppearance;
      /** Unspecified preserves the original appearance-presence rule. Both modes keep their settings. */
      textMode?: 'free' | 'component';
      /** Per-clip binding; unspecified uses the migrated document's component. */
      componentAssetId?: string }
  | { kind: 'title'; data: ElementData<EditorTitle>; style: TitleStyle; legacyId?: number }
  | { kind: 'shape'; data: ElementData<EditorShape> };

export interface SequenceClip {
  id: string;
  trackId: string;
  name: string;
  startFrame: number;
  durationFrames: number;
  content: ClipContent;
  clock: EffectClock;
  visual?: ClipVisual;
  anchor?: ClipAnchor;
  /** Separate clip IDs always; links only couple editing operations. */
  linkGroupId?: string;
  continuationGroupId?: string;
  /** Explicit old soundtrack usage; never inferred from a filename or asset. */
  legacyAudioContinuity?:{version:1;sourceFingerprint:string;ownerClipId:string;leftClampBridge?:true};
  /** Explicit migrated subtitle usage and source-relative expected effect clocks. */
  legacyCaptionContinuity?:{version:1;sourceFingerprint:string;ownerClipId:string;
    witnesses:Array<{clipId:string;sourceStart:Rational;sourceEnd:Rational;assetId:string;streamIndex:number;role:'speech'|'visual';
      clock:{offset:Rational;slope:Rational;duration:Rational};keyframeClock?:{offset:Rational;slope:Rational;duration:Rational}}>};
  legacyMainRole?:{version:1;sourceFingerprint:string;kind:'main'|'main-audio';providerId?:string;
    witnesses:Array<{clipId:string;edge:'start'|'end';kind:'main'|'main-audio';providerId?:string;assetId:string;streamIndex:number;sourceTime:Rational;rate:Rational}>};
  speed?: NativeClipSpeedMetadata;
  insertOwnSpeed?: InsertOwnSpeedMetadata;
}
/** Explicit fixed native insertion. This never denotes a main/follow provider. */
export interface InsertOwnSpeedMetadata {
  version: 1;
  placement: {startFrame:number;exposure:Rational};
  rate: Rational;
  source: SpeedSourceBasis;
  /** Non-recursive finite ancestor interval retained across ordinary slicing. */
  sourceLimit?: {sourceStart:Rational;exposure:Rational};
  clock: SpeedClockBasis;
  keyframeClock?: SpeedClockBasis;
}
export type TransitionKind = 'crossfade' | 'wipeLeft' | 'wipeRight' | 'wipeUp' | 'wipeDown'
  | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown' | 'fadeBlack' | 'fadeWhite';
export interface SequenceTransition {
  id: string;
  trackId: string;
  outClipId: string;
  inClipId?: string;
  kind: TransitionKind;
  startFrame: number;
  durationFrames: number;
  /** Single-clip fades specify whether color covers the entrance or exit. */
  edge?: 'in' | 'out';
  /** Existing video transitions changed visual opacity only; preserve their audio mix. */
  audioCurve?: 'linear' | 'none';
  /** `join:<trackId>:<outClipId>:<inClipId>`; the same key a scene fade uses for this join. */
  joinKey?: string;
  /** The gap-free boundary before the overlap was created. Releasing restores it exactly. */
  joinFrame?: number;
}
export interface SourceTranscript {
  assetId: string;
  streamIndex: number;
  words: Array<{ id: string; text: string; start: Rational; end: Rational }>;
}
/** Saved, non-executable metadata for one still-deleted continuous interval. */
export interface CutArchiveBoundary {
  references: Array<{clipId:string;edge:'start'|'end';offsetFrames:number}>;
  hintFrame:number;
  ambiguous:boolean;
}
export interface CutArchiveEntry {
  id:string;
  durationFrames:number;
  /** Ordinary completion within this band; excludes a temporary insert-own extension. */
  completionFloorFrames:number;
  origin:{cutId:string;startFrame:number;endFrame:number};
  boundary:CutArchiveBoundary;
  /** Explicit insertion witnesses for fixed tracks after partial restoration.
   * Canonical boundary remains on the completed AV axis; absent means legacy canonical placement. */
  trackBoundaries?:{trackId:string;destinationTrackId?:string;boundary:CutArchiveBoundary}[];
  /** Local frame zero is the beginning of this deleted interval. No media bytes. */
  clips:SequenceClip[];
  tracks:SequenceTrack[];
  speed?:NativeSpeedDocumentMetadata;
  insertOwnSpeed?:SequenceDocument['insertOwnSpeed'];
  /** Explicit raw-source reconstruction, distinct from a recorded historical deletion.
   * Kept on partial remnants as the provenance of the original reconstruction. */
  sourceRecovery?:{version:1;documentId:string;revision:number;ownerClipIds:string[];
    sources:Array<{assetId:string;streamIndex:number;start:Rational;end:Rational}>};
  /** Reconstruction from preserved legacy source data, not a native deletion snapshot. */
  legacyRecovery?:{version:1;sourceFingerprint:string;originalStart:number;originalEnd:number;fps:Rational;mainRate:Rational};
}
/** Explicit left-to-right deletion lineage. Members keep their own saved frame
 * and speed basis; this is not a shared time axis or an asset occurrence guess. */
export interface CutArchiveGroup {id:string;entryIds:string[]}
export interface SequenceDocument {
  schemaVersion: 2;
  id: string;
  name: string;
  revision: number;
  fps: Rational;
  resolution: { width: number; height: number };
  sequenceEndFrame: number;
  cutArchive?:{version:1;entries:CutArchiveEntry[];groups?:CutArchiveGroup[]};
  speed?: NativeSpeedDocumentMetadata;
  /** Current ordinary completion floor, excluding temporary own-speed extension. */
  insertOwnSpeed?: {version:1;fpsBasis:Rational;endFloor:number};
  background: string;
  assets: SequenceAsset[];
  /** Low-to-high compositing order. UI presents visual tracks in reverse. */
  tracks: SequenceTrack[];
  clips: SequenceClip[];
  transitions: SequenceTransition[];
  transcripts: SourceTranscript[];
  scriptDocument?: ScriptDocument;
  ducking: { enabled: boolean; strength: 'weak' | 'mid' | 'strong' };
  rendering?: { telopComponentAssetId?: string; imageComponentAssetId?: string; telopBottomOffset: number | null; telopFontSize: number | null;
    /** Frozen legacy staticFile names resolve to managed content, never public/ rereads. */
    staticFiles?: Record<string, string> };
  /** Original end is kept separately from a user's later sequence extension. */
  legacy?: { sourceFingerprint: string; primaryAssetId: string; originalEndFrame: number;
    /** Remains after every imported band is consumed; adoption Undo removes it with the bands. */
    cutHistoryImport?:{version:1;sourceFingerprint:string} };
  /** スタイル一覧の「使わない」。キーは component asset の id、値は非表示のスタイル番号。表示だけの設定で描画には効かない。 */
  textStylePrefs?: { hidden: Record<string, number[]> };
}

export function clipEnd(clip: SequenceClip): number { return clip.startFrame + clip.durationFrames; }
export function isMediaContent(content: ClipContent): content is Extract<ClipContent, { kind: 'video' | 'audio' }> {
  return content.kind === 'video' || content.kind === 'audio';
}
export function sourceTimeAt(clip: SequenceClip, frame: number, fps: Rational): Rational {
  if (!isMediaContent(clip.content)) throw new Error('A media clip is required');
  return addTime(clip.content.sourceIn, multiplyTime(frameSeconds(frame - clip.startFrame, fps), clip.content.rate));
}
export function effectFrameAt(clip: SequenceClip, frame: number): Rational {
  return addTime(clip.clock.offset, multiplyTime(rational(frame - clip.startFrame), clip.clock.rate));
}
