import { useEffect, useMemo, useRef } from 'react';
import type { PlaybackModel } from '../../preview/playbackModel';
import type { Selection } from '../edit/editState';
import { TRACK_LABEL_GUTTER_PX as GUTTER } from './timelineGeometry';
import { useTimelineDrag } from './useTimelineDrag';
import type { AssetKind, AssetPlacementAction } from '../edit/assetPlacementOps';

export interface SequenceAsset {
  kind: AssetKind; id: number; start: number; end: number; label: string;
}
const name = (file: string) => file.split('/').at(-1) ?? file;

/** Use the exact projection consumed by preview, including cuts, order, speed and overlaps. */
export function sequenceAssetRows(model: PlaybackModel): { label: string; items: SequenceAsset[] }[] {
  const telops = model.telops.map(t => ({ kind: 'telop' as const, id: t.id, start: t.startFrame, end: t.endFrame, label: t.text }));
  return [
    { label: '字幕 / テロップ', items: telops },
    { label: 'タイトル', items: model.titles.map(t => ({ kind: 'title' as const, id: t.id, start: t.startFrame, end: t.endFrame, label: t.text })) },
    { label: '画像', items: model.images.map(t => ({ kind: 'image' as const, id: t.id, start: t.playbackStart, end: t.playbackEnd, label: name(t.file) })) },
    { label: 'サブ動画', items: model.videoInserts.map(t => ({ kind: 'videoInsert' as const, id: t.id, start: t.playbackStart, end: t.playbackEnd, label: name(t.file) })) },
    { label: 'BGM', items: model.bgm.map(t => ({ kind: 'bgm' as const, id: t.id, start: t.startFrame, end: t.endFrame, label: name(t.file) })) },
    { label: '効果音', items: model.se.map(t => ({ kind: 'se' as const, id: t.id, start: t.playbackFrame, end: t.playbackEnd, label: name(t.file) })) },
    { label: '図形', items: model.shapes.map(t => ({ kind: 'shape' as const, id: t.id, start: t.startFrame, end: t.endFrame, label: t.kind })) },
  ];
}

export function SequenceAssetTracks({ model, pxPerFrame, selection, playerFrame, onSelect, onPlace, snapEnabled = false, altHeld, getAutoScrollDx, onDragActivity }: {
  model: PlaybackModel; pxPerFrame: number; selection: Selection | null; playerFrame: number;
  onSelect: (selection: Selection, finalFrame: number) => void;
  onPlace?: (item: SequenceAsset, start: number, end: number, action: AssetPlacementAction) => void;
  snapEnabled?: boolean; altHeld?: { current: boolean }; getAutoScrollDx?: () => number;
  onDragActivity?: (activity: { active: boolean; moved: boolean }) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => sequenceAssetRows(model), [model]);
  type Handle = { item: SequenceAsset; action: 'move' | 'trim-start' | 'trim-end' };
  const select = (item: SequenceAsset, start = item.start, end = item.end) => onSelect({ kind: item.kind, id: item.id }, Math.min(model.durationInFrames - 1, Math.floor((start + end - 1) / 2)));
  function range(handle: Handle, frame: number) {
    const { item, action } = handle;
    return action === 'move' ? { start: frame, end: frame + item.end - item.start }
      : action === 'trim-start' ? { start: frame, end: item.end } : { start: item.start, end: frame };
  }
  function constrain(handle: Handle, raw: number, allowSnap = true): number {
    const { item, action } = handle;
    let min = action === 'trim-end' ? item.start + 1 : 0;
    const max = action === 'trim-start' ? item.end - 1 : action === 'move' ? model.durationInFrames - (item.end - item.start) : model.durationInFrames;
    if (action === 'trim-start' && item.kind === 'videoInsert') {
      const video = model.videoInserts.find(v => v.id === item.id);
      if (video) min = Math.max(min, item.start - Math.floor(video.sourceInFrame / (video.playbackRate ?? 1)));
    }
    let result = Math.max(min, Math.min(max, raw));
    if (allowSnap && snapEnabled && !altHeld?.current) {
      const targets = [0, model.durationInFrames, ...(playerFrame < item.start || playerFrame > item.end ? [playerFrame] : []), ...model.keptSegments.flatMap(s => [s.playbackStart, s.playbackEnd]),
        ...rows.flatMap(row => row.items.filter(x => x.kind !== item.kind || x.id !== item.id).flatMap(x => [x.start, x.end]))];
      let distance = Math.max(1, 8 / pxPerFrame);
      for (const target of targets) for (const offset of action === 'move' ? [0, item.end - item.start] : [0]) {
        const candidate = target - offset;
        const d = Math.abs(candidate - raw);
        if (candidate >= min && candidate <= max && d < distance) { result = candidate; distance = d; }
      }
    }
    return Math.round(result);
  }
  const { drag, beginDrag, cancelDrag } = useTimelineDrag<Handle>({
    getTrackOriginX: () => root.current?.getBoundingClientRect().left ?? 0,
    pxPerFrame, getAutoScrollDx, onDrag: constrain,
    onClick: ({ item }) => select(item),
    onCommit: (handle, frame) => {
      const next = range(handle, frame);
      onPlace?.(handle.item, next.start, next.end, handle.action);
      select(handle.item, next.start, next.end);
    },
  });
  const active = drag !== null, moved = drag?.moved ?? false;
  useEffect(() => { cancelDrag(); }, [pxPerFrame, cancelDrag]);
  useEffect(() => { onDragActivity?.({ active, moved }); }, [active, moved, onDragActivity]);
  useEffect(() => () => { onDragActivity?.({ active: false, moved: false }); }, [onDragActivity]);
  function begin(item: SequenceAsset, action: Handle['action'], event: React.PointerEvent) {
    if (!onPlace || event.button !== 0) return;
    select(item);
    beginDrag({ item, action }, event, action === 'trim-end' ? item.end : item.start);
  }
  return <div ref={root} className="tl-sequence-assets" data-testid="timeline-sequence-assets">
    {rows.map(row => {
      const laneEnds: number[] = [];
      const clips = [...row.items].sort((a, b) => a.start - b.start).map(item => {
        let lane = laneEnds.findIndex(end => end <= item.start);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = item.end;
        const preview = drag?.moved && drag.handle.item.kind === item.kind && drag.handle.item.id === item.id ? range(drag.handle, drag.frame) : null;
        return { ...item, ...preview, lane };
      });
      return <div className="tl-sequence-asset-row" key={row.label} style={{ height: Math.max(1, laneEnds.length) * 32 + 8 }}>
        <span className="tl-sequence-asset-label">{row.label}</span>
        {clips.map((item, index) => <div key={`${item.kind}:${item.id}:${index}`}
          className={'tl-sequence-asset ' + item.kind + (selection?.kind === item.kind && 'id' in selection && selection.id === item.id ? ' selected' : '')}
          title={`${item.label} · ${(item.start / model.fps).toFixed(2)}–${(item.end / model.fps).toFixed(2)} 秒`}
          style={{ left: GUTTER + item.start * pxPerFrame, width: Math.max(3, (item.end - item.start) * pxPerFrame), top: 4 + item.lane * 32 }}>
          <button type="button" className="tl-sequence-asset-body" data-testid={`sequence-asset-${item.kind}-${item.id}`}
            aria-label={`${row.label}：${item.label}`} aria-pressed={selection?.kind === item.kind && 'id' in selection && selection.id === item.id}
            onPointerDown={event => begin(item, 'move', event)} onClick={event => { if (!onPlace || event.detail === 0) select(item); }}>{item.label}</button>
          {onPlace && (['start', 'end'] as const).map(edge => <button type="button" key={edge}
            className={`tl-sequence-asset-handle ${edge}`} aria-label={`${item.label}の${edge === 'start' ? '開始' : '終了'}を変更`}
            data-testid={`sequence-trim-${edge}-${item.kind}-${item.id}`}
            onPointerDown={event => begin(item, edge === 'start' ? 'trim-start' : 'trim-end', event)}
            onKeyDown={event => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault(); event.stopPropagation();
              const action = edge === 'start' ? 'trim-start' : 'trim-end';
              const handle: Handle = { item, action };
              const next = range(handle, constrain(handle, item[edge] + (event.key === 'ArrowLeft' ? -1 : 1), false));
              onPlace(item, next.start, next.end, action); select(item, next.start, next.end);
            }} />)}
        </div>)}
      </div>;
    })}
    <div className="tl-playhead tl-sequence-assets-playhead" style={{ left: GUTTER + playerFrame * pxPerFrame }} />
  </div>;
}
