import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import type { FrameRetention } from './mp4FrameSource';
import type { Rational } from '../../core/sequence/time';

/** Export only (export speed design, stage 2). The export
 * runner passes the minimum frames per source to the drawing page as retain=N; the
 * preview never sets it and keeps the 64 MiB byte budget alone. */
export const EXPORT_RETAIN_FRAMES = 8;
/** One source's ceiling even when minFrames asks for more (8K RGBA is 132 MB a frame). */
export const EXPORT_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
/** Decoded frames of all open sources together. Over it, sources not needed at the next
 * frame are released (farthest next use first); a source needed next is never released. */
export const EXPORT_SOURCES_TOTAL_BYTES = 1024 * 1024 * 1024;

/** Which decoded source sample a video layer of a drawn frame used (export measurement, window.harnessNativeFrameSamples). */
export interface NativeFrameSample { clip: string; source: string; sample: number; pts: Rational }

export interface SourceReleaseOptions { totalBytes: number }
export interface RendererSourceOptions { retention?: FrameRetention; release?: SourceReleaseOptions }

/** The decoder key of a video clip: the same file and stream share one decoder. */
export function videoSourceKey(asset: Pick<SequenceAsset, 'fingerprint'>, streamIndex: number): string {
  return `${asset.fingerprint}:${streamIndex}`;
}

export function parseRetainFrames(value: string | null): number | undefined {
  if (value === null) return undefined;
  const frames = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(frames) || frames < 1 || frames > 64) throw new Error(`書き出しの保持枚数が不正です: ${value}`);
  return frames;
}
export function exportRendererOptions(retainFrames: number | undefined): RendererSourceOptions {
  if (retainFrames === undefined) return {};
  return { retention: { minFrames: retainFrames, maxBytes: EXPORT_SOURCE_MAX_BYTES, keepDecoderOpen: true }, release: { totalBytes: EXPORT_SOURCES_TOTAL_BYTES } };
}

export interface FrameSpan { start: number; end: number }
/** Half-open frame spans in which each source is drawn: the video clips of enabled tracks,
 * exactly the clips ScenePlan.frame() returns as visuals. */
export function videoSourceUses(document: SequenceDocument): Map<string, FrameSpan[]> {
  const enabled = new Set(document.tracks.filter(track => track.enabled).map(track => track.id));
  const spans = new Map<string, FrameSpan[]>();
  for (const clip of document.clips) {
    const content = clip.content;
    if (content.kind !== 'video' || !enabled.has(clip.trackId) || clip.durationFrames <= 0) continue;
    const asset = document.assets.find(value => value.id === content.assetId);
    if (!asset) continue;
    const key = videoSourceKey(asset, content.streamIndex), list = spans.get(key) ?? [];
    list.push({ start: clip.startFrame, end: clip.startFrame + clip.durationFrames }); spans.set(key, list);
  }
  for (const [key, list] of spans) {
    list.sort((a, b) => a.start - b.start);
    const merged: FrameSpan[] = [];
    for (const span of list) {
      const last = merged.at(-1);
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end); else merged.push({ ...span });
    }
    spans.set(key, merged);
  }
  return spans;
}
/** First frame at or after `frame` that draws the source; undefined when none remains. */
function nextUse(spans: readonly FrameSpan[] | undefined, frame: number): number | undefined {
  for (const span of spans ?? []) if (span.end > frame) return Math.max(span.start, frame);
  return undefined;
}

export type ReleaseReason = 'lastUse' | 'overBudget';
/** After drawing `frame` (an export draws frames in order): which open sources to release.
 * Past its last use a source is released at once. A source that returns later stays open
 * while all sources together hold at most totalBytes; above that, sources not needed at the
 * next frame are released, the one needed farthest ahead first. Releasing is always safe: the next
 * request opens the source again. */
export function sourcesToRelease(frame: number, open: ReadonlyArray<{ key: string; bytes: number }>, uses: ReadonlyMap<string, readonly FrameSpan[]>, totalBytes: number): Array<{ key: string; reason: ReleaseReason }> {
  const released: Array<{ key: string; reason: ReleaseReason }> = [], idle: Array<{ key: string; bytes: number; next: number }> = [];
  let held = 0;
  for (const source of open) {
    const spans = uses.get(source.key), later = nextUse(spans, frame + 1);
    if (later === undefined) { released.push({ key: source.key, reason: 'lastUse' }); continue; }
    held += source.bytes;
    if (later !== frame + 1) idle.push({ ...source, next: later });
  }
  idle.sort((a, b) => b.next - a.next);
  for (const source of idle) {
    if (held <= totalBytes) break;
    released.push({ key: source.key, reason: 'overBudget' }); held -= source.bytes;
  }
  return released;
}
