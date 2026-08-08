import React from 'react';
import type { Join } from '../../core/joinEngine';
import type { SceneTransition } from '../../core/types';
import { frameToXMapped } from './timelineGeometry';
import type { DisplayMap } from '../../core/timelineDisplayMap';

interface Props {
  joins: Join[];
  sceneTransitions: SceneTransition[];
  pxPerFrame: number;
  /** 尾マーカーの位置（原本フレーム＝素材の終端）。定規は原本座標なので frameToXMapped に原本を渡す。 */
  tailFrame: number;
  selectedAt: 'head' | 'tail' | number | null;
  onSelect: (at: 'head' | 'tail' | number) => void;
  /** 表示マップ（per-segment 速度有効時）。省略時は恒等（従来通り）。 */
  map?: DisplayMap;
}

/** 1 つのつなぎ目マークの配置情報。frame は frameToX に渡す「原本フレーム」。 */
export interface JoinMarkSpec {
  at: 'head' | 'tail' | number;
  /** 配置に使う原本フレーム。定規は原本座標なので **再生フレームではなく原本フレーム**。 */
  frame: number;
  title: string;
}

/**
 * 頭・各つなぎ目・尾のマーク配置を原本座標で組む純関数。
 * **重要**: つなぎ目は `j.atOriginal`（原本）を使う。`j.playbackFrame`（再生フレーム）を渡すと
 * カットが手前にあるぶん左へずれ、カット帯（原本座標で描画）と一致しない（実機で見つからない）。
 * 頭=0、尾=素材終端（原本）。
 */
export function joinMarkSpecs(joins: Join[], tailFrame: number): JoinMarkSpec[] {
  return [
    { at: 'head', frame: 0, title: '動画の最初のシーン転換' },
    ...joins.map((j) => ({ at: j.atOriginal, frame: j.atOriginal, title: 'シーン転換' })),
    { at: 'tail', frame: tailFrame, title: '動画の最後のシーン転換' },
  ];
}

/** つなぎ目マーク（菱形）。転換設定済みは .set クラス、選択中は .selected。頭尾も両端に描く。 */
export const JoinMarkers: React.FC<Props> = ({ joins, sceneTransitions, pxPerFrame, tailFrame, selectedAt, onSelect, map }) => {
  const hasAt = (at: 'head' | 'tail' | number) => sceneTransitions.some((t) => t.at === at);
  const markClass = (at: 'head' | 'tail' | number): string => {
    const cls = ['tl-join-mark'];
    if (hasAt(at)) cls.push('set');
    if (selectedAt === at) cls.push('selected');
    return cls.join(' ');
  };
  return (
    <div className="tl-join-markers">
      {joinMarkSpecs(joins, tailFrame).map((spec) => (
        <button
          key={String(spec.at)}
          type="button"
          className={markClass(spec.at)}
          style={{ left: frameToXMapped(spec.frame, pxPerFrame, map) }}
          title={spec.title}
          data-join-at={spec.at}
          onClick={() => onSelect(spec.at)}
        />
      ))}
    </div>
  );
};
