import {
  buildOverlaps,
  finalTotalFrames,
  playbackToFinal,
  type PlaybackOverlap,
} from './transitionEngine';
import type { BgmClip, ImagePlayback, SceneTransition, ShapeSegment, TelopSegment, TitleSegment, VideoInsertPlayback } from './types';
import { collapseBgm, collapseImages, collapseSe, collapseShapes, collapseTelops, collapseTitles, collapseVideoInserts } from './sceneCollapse';
import type { SePlayback } from './types';

/**
 * 書き出し（nativeExport）全工程が読む唯一の時間軸。
 * 重なり系トランジションで総尺が縮むため、PNG 撮影・音声合成・xfade は
 * 各自で時間計算せず、必ずこの manifest の最終座標を使う。
 */
export interface ExportSegment {
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
  /** 最終タイムライン上の開始フレーム（重なり分を前へ詰めた後）。 */
  finalStart: number;
  /**
   * 最終タイムライン上の終了フレーム。`finalStart + (playbackEnd - playbackStart)`（A 側規約＝
   * 自区間の長さをそのまま足すだけで、後続区間の詰めは見ない）。
   * 重なり窓では finalEnd(i) > finalStart(i+1) になる＝これが xfade の重なり量。
   */
  finalEnd: number;
}

export interface ExportTimeline {
  fps: number;
  /** 重なり補正前の再生総フレーム数。 */
  playbackTotal: number;
  /** 最終総フレーム数（出力検算の分母）。 */
  totalFrames: number;
  overlaps: PlaybackOverlap[];
  segments: ExportSegment[];
}

export interface ExportTimelineWithAudio extends ExportTimeline {
  /** 最終座標の SE / BGM（collapse 済み）。書き出しの音声工程はこれだけを読む。 */
  se: SePlayback[];
  bgm: BgmClip[];
}

export function buildExportTimeline(input: {
  fps: number;
  segments: ReadonlyArray<{ originalStart: number; originalEnd: number }>;
  transitions: readonly SceneTransition[];
}): ExportTimeline {
  let acc = 0;
  const play = input.segments.map((s) => {
    const playbackStart = acc;
    acc += Math.max(0, s.originalEnd - s.originalStart);
    return { ...s, playbackStart, playbackEnd: acc };
  });
  const overlaps = buildOverlaps([...input.transitions], play);
  return {
    fps: input.fps,
    playbackTotal: acc,
    totalFrames: finalTotalFrames(acc, overlaps),
    overlaps,
    segments: play.map((s) => {
      const finalStart = playbackToFinal(s.playbackStart, overlaps);
      return {
        ...s,
        finalStart,
        finalEnd: finalStart + (s.playbackEnd - s.playbackStart),
      };
    }),
  };
}

/**
 * SE / BGM を最終座標で timeline に載せる。collapse はここだけが行う
 * （各工程が独自に時間計算することを禁止する契約の一部）。
 */
export function attachAudio(
  timeline: ExportTimeline,
  se: readonly SePlayback[],
  bgm: readonly BgmClip[],
): ExportTimelineWithAudio {
  return {
    ...timeline,
    se: collapseSe([...se], timeline.overlaps),
    bgm: collapseBgm([...bgm], timeline.overlaps),
  };
}

/**
 * 図形注釈を最終座標で timeline に載せる。attachAudio と同格の最終座標付与。
 * 入力 shapes は「再生座標・reorder 済み・縮退除外済み」（呼び出し元 fastCutPlan が
 * clampShapes → projectShapes → reorderStartEnd → filter(endFrame>startFrame) を
 * 済ませて渡す契約）。ここでは collapseShapes（重なり系トランジションの前詰め）を適用し、
 * collapse 後にも endFrame > startFrame の縮退除外を再適用してから返す。
 */
export function attachShapes<T extends ExportTimeline>(
  timeline: T,
  shapes: readonly ShapeSegment[],
): T & { shapes: ShapeSegment[] } {
  const collapsed = collapseShapes([...shapes], timeline.overlaps).filter((s) => s.endFrame > s.startFrame);
  return { ...timeline, shapes: collapsed };
}

/**
 * テロップを最終座標で timeline に載せる。attachShapes と同型。
 * 入力 telops は「再生座標・reorder 済み・縮退除外済み」（呼び出し元 fastCutPlan が
 * clampTelops → projectTelops → reorder → filter(endFrame>startFrame) を済ませて渡す契約）。
 * ここでは collapseTelops（重なり系トランジションの前詰め）を適用し、collapse 後にも
 * endFrame > startFrame の縮退除外を再適用してから返す。
 */
export function attachTelops<T extends ExportTimeline>(
  timeline: T,
  telops: readonly TelopSegment[],
): T & { telops: TelopSegment[] } {
  const collapsed = collapseTelops([...telops], timeline.overlaps).filter((t) => t.endFrame > t.startFrame);
  return { ...timeline, telops: collapsed };
}

/**
 * タイトルを最終座標で timeline に載せる。attachShapes と同型。
 * 入力 titles は「再生座標・reorder 済み・縮退除外済み」（呼び出し元 fastCutPlan が
 * clampTitles → projectTitles → reorder → filter(endFrame>startFrame) を済ませて渡す契約、
 * attachTelops と同じ工程列）。
 * collapseTitles 適用後に endFrame > startFrame の縮退除外を再適用してから返す。
 */
export function attachTitles<T extends ExportTimeline>(
  timeline: T,
  titles: readonly TitleSegment[],
): T & { titles: TitleSegment[] } {
  const collapsed = collapseTitles([...titles], timeline.overlaps).filter((t) => t.endFrame > t.startFrame);
  return { ...timeline, titles: collapsed };
}

/**
 * 挿入画像を最終座標で timeline に載せる。attachShapes と同型だが、ImagePlayback は
 * `startFrame/endFrame` ではなく `playbackStart/playbackEnd` を持つ（sceneCollapse.ts の
 * collapseImages がこの名称のまま playbackToFinal を適用する）。
 * 入力 images は「再生座標・reorder 済み・縮退除外済み」（呼び出し元 fastCutPlan が
 * clampImages → projectImages → reorder → filter(playbackEnd>playbackStart) を
 * 済ませて渡す契約）。collapseImages 適用後に playbackEnd > playbackStart の縮退除外を
 * 再適用してから返す。
 */
export function attachImages<T extends ExportTimeline>(
  timeline: T,
  images: readonly ImagePlayback[],
): T & { images: ImagePlayback[] } {
  const collapsed = collapseImages([...images], timeline.overlaps).filter((i) => i.playbackEnd > i.playbackStart);
  return { ...timeline, images: collapsed };
}

/**
 * サブ動画インサートを最終座標で timeline に載せる（M4 T3）。attachImages と同型で、
 * `VideoInsertPlayback` も `playbackStart`/`playbackEnd` を持つ（sceneCollapse.ts の
 * collapseVideoInserts がこの名称のまま playbackToFinal を適用する）。
 *
 * 入力 videoInserts は「再生座標・reorder 済み・縮退除外済み」（呼び出し元 fastCutPlan が
 * clampVideoInserts → projectVideoInserts → reorder → filter(playbackEnd>playbackStart) を
 * 済ませて渡す契約）。**collapse（再生→最終）はここだけが行う**——正典⑧ と M3 の
 * ExportTimeline 契約により、各工程が playbackToFinal を独自に呼ぶことは禁止。
 * collapse 後にも playbackEnd > playbackStart の縮退除外を再適用してから返す。
 *
 * `sourceInFrame` / `playbackRate` は**時間軸に一切関与しない**（正典⑧: 転換は時間軸に
 * 何も足さない）ので collapse で不変のまま通過する。
 */
export function attachVideoInserts<T extends ExportTimeline>(
  timeline: T,
  videoInserts: readonly VideoInsertPlayback[],
): T & { videoInserts: VideoInsertPlayback[] } {
  const collapsed = collapseVideoInserts([...videoInserts], timeline.overlaps).filter(
    (v) => v.playbackEnd > v.playbackStart,
  );
  return { ...timeline, videoInserts: collapsed };
}
