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
 * 束ねたマーク。`members` が 2 件以上なら「密集していて 1 個ずつ描けない」束。
 * `at` は代表（クリックで選ばれる対象）で、束に頭・尾が含まれるならそれを優先する
 * （fit 倍率でも「動画の最初／最後のシーン転換」に必ず手が届くようにするため）。
 */
export interface JoinMarkCluster {
  at: 'head' | 'tail' | number;
  /** 束の描画 X（＝束の先頭メンバーの X）。 */
  x: number;
  members: JoinMarkSpec[];
}

/** 束ねの最小間隔（px）。これ未満に近いマークは 1 個へまとめる。 */
export const JOIN_MARK_MIN_GAP_PX = 12;

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

/**
 * 近すぎるマークを束ねる純関数（サイクル 4 レビュー Important）。
 *
 * fit 倍率（長尺の実案件で約 0.05px/frame）ではつなぎ目が数十個も
 * 数 px 間隔に並び、ひし形同士が重なって「狙った転換を個別に押せない」状態になっていた。
 * 直前に置いた束から `minGapPx` 未満の距離にあるマークは、その束へ吸収する。
 * **取りこぼさない**（全メンバーはどれかの束に属する）ので、束の件数バッジから
 * 「ここに何個あるか」は読める。個別に選ぶにはズームする。
 */
export function clusterJoinMarks(
  specs: JoinMarkSpec[],
  xOf: (frame: number) => number,
  minGapPx: number,
): JoinMarkCluster[] {
  // joins は再生順（computeJoins）で来るため、カットの並び替え（cutOrder）が入った案件では
  // 原本座標が単調にならない。束ねは「直前の束との距離」で判定するので、描画 X の昇順に
  // 揃えてから走査する（逆行するマークは距離が負になり、倍率に依らず必ず吸収されていた）。
  // 安定ソートなので同じ X の頭・尾・つなぎ目は入力順を保つ。
  const ordered = specs.map((spec) => ({ spec, x: xOf(spec.frame) })).sort((a, b) => a.x - b.x);
  const clusters: JoinMarkCluster[] = [];
  for (const { spec, x } of ordered) {
    const last = clusters.at(-1);
    if (last !== undefined && x - last.x < minGapPx) {
      last.members.push(spec);
      // 頭・尾は束の中でも代表を譲らない（fit でも最初／最後の転換に手が届くように）。
      if ((spec.at === 'head' || spec.at === 'tail') && last.at !== 'head' && last.at !== 'tail') {
        last.at = spec.at;
      }
      continue;
    }
    clusters.push({ at: spec.at, x, members: [spec] });
  }
  return clusters;
}

/** 束の title（1 件なら元の説明、複数なら件数と「拡大すると個別に選べます」）。 */
export function clusterTitle(cluster: JoinMarkCluster): string {
  if (cluster.members.length === 1) return cluster.members[0]!.title;
  return `シーン転換 ${cluster.members.length} 個（拡大すると 1 個ずつ選べます）`;
}

/** つなぎ目マーク（菱形）。転換設定済みは .set クラス、選択中は .selected。頭尾も両端に描く。 */
export const JoinMarkers: React.FC<Props> = ({ joins, sceneTransitions, pxPerFrame, tailFrame, selectedAt, onSelect, map }) => {
  const hasAt = (at: 'head' | 'tail' | number) => sceneTransitions.some((t) => t.at === at);
  const markClass = (cluster: JoinMarkCluster): string => {
    const cls = ['tl-join-mark'];
    // 束のうち 1 つでも転換が付いていれば「設定済み」の色にする（束が空に見えるのを防ぐ）。
    if (cluster.members.some((m) => hasAt(m.at))) cls.push('set');
    if (cluster.members.some((m) => selectedAt === m.at)) cls.push('selected');
    if (cluster.members.length > 1) cls.push('cluster');
    return cls.join(' ');
  };
  const clusters = clusterJoinMarks(
    joinMarkSpecs(joins, tailFrame),
    (frame) => frameToXMapped(frame, pxPerFrame, map),
    JOIN_MARK_MIN_GAP_PX,
  );
  return (
    <div className="tl-join-markers">
      {clusters.map((cluster) => (
        <button
          key={String(cluster.at)}
          type="button"
          className={markClass(cluster)}
          style={{ left: cluster.x }}
          title={clusterTitle(cluster)}
          data-join-at={cluster.at}
          data-join-count={cluster.members.length}
          onClick={() => onSelect(cluster.at)}
        >
          {cluster.members.length > 1 && (
            // ひし形は 45 度回転しているので、数字は逆回転して水平に戻す。
            <span className="tl-join-mark-count">{cluster.members.length}</span>
          )}
        </button>
      ))}
    </div>
  );
};
