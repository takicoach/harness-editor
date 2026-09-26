import { useEffect, useMemo, useRef, useState } from 'react';
import type { CutRegion, CutSegment } from '../../core/types';
import type { PlaybackOverlap } from '../../core/transitionEngine';
import { playbackToFinal } from '../../core/transitionEngine';
import { formatClock } from '../../shared/format';
import { Waveform } from './Waveform';
import { MAX_THUMBS, STRIP_THUMB_PX, useFilmstripFrames } from './useFilmstrip';
import { useWaveformSamples } from '../audio/useWaveformSamples';
import { TrackIcon } from './TrackIcon';
import { TimelineRuler } from './TimelineRuler';
import { TRACK_LABEL_GUTTER_PX } from './timelineGeometry';

export interface CutSequenceLayout {
  id: number;
  originalStart: number;
  originalEnd: number;
  sourceFramesPerFinalFrame: number;
  left: number;
  width: number;
}

/** 完成順clipを、速度・重なり転換を反映した最終座標へ並べる。 */
export function cutSequenceLayout(
  segments: readonly CutSegment[],
  pxPerFrame: number,
  overlaps: PlaybackOverlap[],
): CutSequenceLayout[] {
  return segments.map((segment) => {
    const finalStart = playbackToFinal(segment.playbackStart, overlaps);
    // A transition overlaps neighbouring clips; it moves the next clip's start
    // left without shortening either source clip itself.
    const finalFrames = Math.max(1, segment.playbackEnd - segment.playbackStart);
    return {
      id: segment.id,
      originalStart: segment.originalStart,
      originalEnd: segment.originalEnd,
      sourceFramesPerFinalFrame: (segment.originalEnd - segment.originalStart) / finalFrames,
      left: TRACK_LABEL_GUTTER_PX + finalStart * pxPerFrame,
      width: Math.max(2, finalFrames * pxPerFrame),
    };
  });
}

/** 最大枚数内で完成順全体を均等に観測し、抽出する原本frameへ戻す。 */
export function cutSequenceThumbnailFrames(layouts: readonly CutSequenceLayout[], max = MAX_THUMBS): number[] {
  const contentStart = TRACK_LABEL_GUTTER_PX;
  const contentEnd = layouts.reduce((end, layout) => Math.max(end, layout.left + layout.width), contentStart);
  const totalWidth = contentEnd - contentStart;
  const count = Math.max(0, Math.min(max, Math.floor(totalWidth / STRIP_THUMB_PX)));
  if (count === 0 || totalWidth <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = contentStart + (i + 0.5) * totalWidth / count;
    // Later clips visually own the overlap, matching TransitionSeries stacking.
    let layout: CutSequenceLayout | undefined;
    for (let j = layouts.length - 1; j >= 0; j--) {
      const candidate = layouts[j];
      if (candidate !== undefined && x >= candidate.left && x < candidate.left + candidate.width) {
        layout = candidate;
        break;
      }
    }
    layout ??= layouts.at(-1);
    if (layout === undefined) continue;
    const fraction = Math.max(0, Math.min(1, (x - layout.left) / layout.width));
    out.push(Math.min(layout.originalEnd - 1, Math.floor(layout.originalStart + fraction * (layout.originalEnd - layout.originalStart))));
  }
  return [...new Set(out)];
}

interface CutSequenceTrackProps {
  canReorder?: boolean;
  sweep?: boolean;
  razor?: boolean;
  onSplit?: (sourceFrame: number) => void;
  range?: { start: number; end: number } | null;
  onRange?: (range: { start: number; end: number; ranges: CutRegion[] } | null) => void;
  onCutRange?: () => void;
  segments: readonly CutSegment[];
  overlaps: PlaybackOverlap[];
  finalDurationFrames: number;
  playerFrame: number;
  pxPerFrame: number;
  totalFrames: number;
  fps: number;
  videoUrl: string;
  selectedSegmentId: number | null;
  onSelect: (id: number) => void;
  onSeekOriginal: (frame: number) => void;
  onSeekFinal: (frame: number) => void;
  onMove: (id: number, targetIndex: number) => void;
}

/** 編集モードの主タイムライン。完成順に同期した映像コマ列と元音声波形を描く。 */
export function CutSequenceTrack({
  canReorder = true,
  sweep = false,
  razor = false,
  onSplit,
  range = null,
  onRange,
  onCutRange,
  segments,
  overlaps,
  finalDurationFrames,
  playerFrame,
  pxPerFrame,
  totalFrames,
  fps,
  videoUrl,
  selectedSegmentId,
  onSelect,
  onSeekOriginal,
  onSeekFinal,
  onMove,
}: CutSequenceTrackProps) {
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [blade, setBlade] = useState<{ id: number; frame: number; fraction: number } | null>(null);
  const layouts = useMemo(
    () => cutSequenceLayout(segments, pxPerFrame, overlaps),
    [segments, pxPerFrame, overlaps],
  );
  const targetFrames = useMemo(() => cutSequenceThumbnailFrames(layouts), [layouts]);
  const filmstrip = useFilmstripFrames(videoUrl === '' ? null : videoUrl, totalFrames, targetFrames);
  const { samples, failed } = useWaveformSamples(videoUrl === '' ? null : videoUrl);
  const sampleSlices = useMemo(() => layouts.map((layout) => {
    if (samples === null || totalFrames <= 0) return null;
    const start = Math.floor(layout.originalStart / totalFrames * samples.length);
    const end = Math.max(start + 1, Math.ceil(layout.originalEnd / totalFrames * samples.length));
    return samples.subarray(start, Math.min(samples.length, end));
  }), [layouts, samples, totalFrames]);
  const contentWidth = Math.max(0, finalDurationFrames * pxPerFrame);
  const dragStart = useRef<number | null>(null);
  const scrubbing = useRef(false);
  const [liveRange, setLiveRange] = useState<{ start: number; end: number } | null>(null);
  const visibleRange = liveRange ?? range;
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]'))) return;
      dragStart.current = null; setLiveRange(null); onRange?.(null);
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [onRange]);
  function frameAt(clientX: number, element: HTMLElement): number {
    return Math.max(0, Math.min(finalDurationFrames, Math.round((clientX - element.getBoundingClientRect().left - TRACK_LABEL_GUTTER_PX) / pxPerFrame)));
  }

  function moveRelative(id: number, delta: number): void {
    if (!canReorder) return;
    const index = layouts.findIndex((layout) => layout.id === id);
    if (index < 0) return;
    onMove(id, index + delta);
  }

  function bladeAt(layout: CutSequenceLayout, clientX: number, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const frame = layout.originalStart + Math.round(fraction * (layout.originalEnd - layout.originalStart));
    return { id: layout.id, frame, fraction: (frame - layout.originalStart) / (layout.originalEnd - layout.originalStart) };
  }

  return (
    <div className="tl-track tl-cut-sequence" data-testid="timeline-cut-sequence" style={{ ['--tl-sequence-w' as string]: `${contentWidth}px` }}
      onPointerMove={event => { if (scrubbing.current) onSeekFinal(Math.min(finalDurationFrames - 1, frameAt(event.clientX, event.currentTarget))); }}
      onPointerUp={() => { scrubbing.current = false; }} onPointerCancel={() => { scrubbing.current = false; }} onLostPointerCapture={() => { scrubbing.current = false; }}>
      <TimelineRuler
        totalFrames={finalDurationFrames}
        pxPerFrame={pxPerFrame}
        fps={fps}
        onScrubStart={(event) => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          scrubbing.current = true;
          const rect = event.currentTarget.getBoundingClientRect();
          const frame = Math.round((event.clientX - rect.left - TRACK_LABEL_GUTTER_PX) / pxPerFrame);
          onSeekFinal(Math.max(0, Math.min(finalDurationFrames - 1, frame)));
        }}
      />
      <div className="tl-sequence-labels" aria-hidden="true">
        <span><TrackIcon kind="video" />映像</span>
        <span><TrackIcon kind="video" />元音声</span>
      </div>
      <div className="tl-sequence-video-lane" data-testid="timeline-video-lane" />
      <div className="tl-sequence-audio-lane" data-testid="timeline-main-audio-lane" />
      {layouts.map((layout, index) => {
        const thumbnails = filmstrip.filter((frame) => frame.frame >= layout.originalStart && frame.frame < layout.originalEnd);
        const selected = selectedSegmentId === layout.id;
        return (
          <div
            key={`${layout.originalStart}:${layout.originalEnd}`}
            className={'tl-sequence-clip' + (selected ? ' selected' : '') + (razor ? ' razor' : '')}
            data-testid={`cut-sequence-clip-${layout.id}`}
            data-original-start={layout.originalStart}
            data-original-end={layout.originalEnd}
            style={{ left: layout.left, width: layout.width }}
            draggable={canReorder && !sweep && !razor}
            onMouseLeave={() => setBlade(null)}
            onDragStart={(event) => {
              setDraggedId(layout.id);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', String(layout.id));
            }}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId = draggedId ?? Number(event.dataTransfer.getData('text/plain'));
              const from = layouts.findIndex((item) => item.id === sourceId);
              if (from < 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const slot = index + (event.clientX >= rect.left + rect.width / 2 ? 1 : 0);
              const target = slot > from ? slot - 1 : slot;
              onMove(sourceId, target);
              setDraggedId(null);
            }}
          >
            <button
              type="button"
              className="tl-sequence-clip-main"
              aria-label={`完成順 ${index + 1}。原素材 ${formatClock(layout.originalStart / fps)}から${formatClock(layout.originalEnd / fps)}${canReorder ? '。Altと左右矢印で並べ替え' : '。選択して仕上げを調整'}`}
              onMouseMove={(event) => { if (razor) setBlade(bladeAt(layout, event.clientX, event.currentTarget)); }}
              onClick={(event) => {
                if (sweep) return;
                if (razor && event.detail > 0) {
                  onSplit?.(bladeAt(layout, event.clientX, event.currentTarget).frame);
                  setBlade(null);
                  return;
                }
                onSelect(layout.id);
                // A normal clip click selects without moving the playhead (NLE convention).
                // Keyboard activation previews its midpoint.
                if (event.detail === 0) onSeekOriginal(Math.floor((layout.originalStart + layout.originalEnd - 1) / 2));
              }}
              onKeyDown={(event) => {
                if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
                event.preventDefault();
                event.stopPropagation();
                moveRelative(layout.id, event.key === 'ArrowLeft' ? -1 : 1);
              }}
            >
              <span className="tl-sequence-number">{index + 1}</span>
              {thumbnails.map((frame) => {
                const local = (frame.frame - layout.originalStart) / layout.sourceFramesPerFinalFrame * pxPerFrame;
                const thumbWidth = Math.min(STRIP_THUMB_PX, layout.width);
                return <img key={frame.frame} src={frame.url} alt="" aria-hidden="true" style={{ left: Math.max(0, Math.min(layout.width - thumbWidth, local - thumbWidth / 2)), width: thumbWidth }} />;
              })}
            </button>
            <Waveform samples={sampleSlices[index] ?? null} width={layout.width} height={34} className="tl-sequence-waveform" />
            <button type="button" className="tl-sequence-audio-select" aria-label={`元音声 ${index + 1}を選択`}
              onMouseMove={(event) => { if (razor) setBlade(bladeAt(layout, event.clientX, event.currentTarget)); }}
              onClick={(event) => {
                if (sweep) return;
                if (razor && event.detail > 0) {
                  onSplit?.(bladeAt(layout, event.clientX, event.currentTarget).frame);
                  setBlade(null);
                } else onSelect(layout.id);
              }} />
            {razor && blade?.id === layout.id && <span className="tl-sequence-blade" data-testid="timeline-razor-guide" data-source-frame={blade.frame} style={{ left: `${blade.fraction * 100}%` }} aria-hidden="true" />}
            <div className="tl-sequence-move" hidden={razor}>
              <button type="button" aria-label={`完成順${index + 1}を前へ`} disabled={!canReorder || index === 0} onClick={() => moveRelative(layout.id, -1)}>‹</button>
              <button type="button" aria-label={`完成順${index + 1}を後ろへ`} disabled={!canReorder || index === layouts.length - 1} onClick={() => moveRelative(layout.id, 1)}>›</button>
            </div>
          </div>
        );
      })}
      {failed && <p className="tl-sequence-waveform-hint">元音声の波形を読み込めません</p>}
      {sweep && <div className="tl-sequence-sweep" data-testid="timeline-sweep-surface"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStart.current = frameAt(event.clientX, event.currentTarget);
          onRange?.(null);
        }}
        onPointerMove={event => {
          if (dragStart.current === null) return;
          const frame = frameAt(event.clientX, event.currentTarget);
          setLiveRange({ start: Math.min(dragStart.current, frame), end: Math.max(dragStart.current, frame) });
        }}
        onPointerUp={event => {
          if (dragStart.current === null) return;
          const frame = frameAt(event.clientX, event.currentTarget);
          const selected = { start: Math.min(dragStart.current, frame), end: Math.max(dragStart.current, frame) };
          dragStart.current = null; setLiveRange(null);
          onRange?.(selected.end > selected.start ? { ...selected, ranges: sequenceRangeToSource(segments, overlaps, selected.start, selected.end) } : null);
        }}
        onPointerCancel={() => { dragStart.current = null; setLiveRange(null); onRange?.(null); }}
        onLostPointerCapture={() => { dragStart.current = null; setLiveRange(null); }}
      />}
      {visibleRange && <div className="tl-sequence-range" style={{ left: TRACK_LABEL_GUTTER_PX + visibleRange.start * pxPerFrame, width: (visibleRange.end - visibleRange.start) * pxPerFrame }} />}
      {canReorder && range && range.end > range.start && liveRange === null && onCutRange && (
        <div className="tl-cut-fab tl-sequence-cut-fab" style={{ left: TRACK_LABEL_GUTTER_PX + (range.start + range.end) / 2 * pxPerFrame }}>
          <button type="button" className="tl-cut-fab-btn" data-testid="timeline-sweep-cut"
            title="選択範囲をカット（Deleteでもカット・Escで解除）"
            onPointerDown={event => event.stopPropagation()}
            onClick={onCutRange}>✂ カット</button>
        </div>
      )}
      <div className="tl-playhead tl-sequence-playhead" style={{ left: TRACK_LABEL_GUTTER_PX + Math.max(0, Math.min(finalDurationFrames, playerFrame)) * pxPerFrame }}>
        <span className="tl-playhead-chip">{formatClock(fps > 0 ? playerFrame / fps : 0)}</span>
      </div>
    </div>
  );
}

/** A range may cross reordered/speed-adjusted clips. Cut only the intersected source spans. */
export function sequenceRangeToSource(segments: readonly CutSegment[], overlaps: PlaybackOverlap[], start: number, end: number): CutRegion[] {
  return segments.flatMap(segment => {
    const from = playbackToFinal(segment.playbackStart, overlaps);
    const duration = segment.playbackEnd - segment.playbackStart;
    const a = Math.max(start, from), b = Math.min(end, from + duration);
    if (b <= a || duration <= 0) return [];
    const rate = (segment.originalEnd - segment.originalStart) / duration;
    return [{ start: Math.max(segment.originalStart, Math.floor(segment.originalStart + (a - from) * rate)), end: Math.min(segment.originalEnd, Math.ceil(segment.originalStart + (b - from) * rate)) }];
  });
}

/** Resolve an edit target without the ambiguous generic inverse inside a crossfade. */
export function sequenceSourceFrameAt(segments: readonly CutSegment[], overlaps: PlaybackOverlap[], finalFrame: number, preferredId?: number): { segmentId: number; originalFrame: number } | null {
  if (!Number.isFinite(finalFrame)) return null;
  const candidates = segments.flatMap(segment => {
    const start = playbackToFinal(segment.playbackStart, overlaps);
    const duration = segment.playbackEnd - segment.playbackStart;
    if (duration <= 0 || finalFrame < start || finalFrame >= start + duration) return [];
    return [{ segmentId: segment.id, originalFrame: Math.min(segment.originalEnd - 1, Math.floor(segment.originalStart + (finalFrame - start) * (segment.originalEnd - segment.originalStart) / duration)) }];
  });
  return candidates.find(candidate => candidate.segmentId === preferredId) ?? candidates.at(-1) ?? null;
}
