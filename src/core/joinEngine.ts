import { applyCuts } from './cutEngine';
import type { CutOrdering, CutRegion, SceneTransition } from './types';

/** カット後タイムラインの「つなぎ目」。atOriginal=削除カット区間の原本開始、playbackFrame=境界の再生フレーム。 */
export interface Join {
  atOriginal: number;
  playbackFrame: number;
}

/**
 * 隣接 kept 区間の境界を全て返す（＝各削除カット区間に 1 つ）。
 * ordering を渡すと「再生順で隣り合う区間」の境界になる（並び替え対応）。
 * 未指定なら従来どおり原素材順の隣接境界。
 */
export function computeJoins(
  originalTotalFrames: number,
  regions: CutRegion[],
  ordering?: CutOrdering,
): Join[] {
  const segs = ordering ? ordering.segments : applyCuts(originalTotalFrames, regions);
  const joins: Join[] = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const cur = segs[i]!;
    const next = segs[i + 1]!;
    // 境界の原本位置 = 前区間の originalEnd（＝削除カット区間の開始）。
    joins.push({ atOriginal: cur.originalEnd, playbackFrame: cur.playbackEnd });
    // playbackEnd === next.playbackStart（前詰め）。
    void next;
  }
  return joins;
}

/**
 * 保存用: at(原本フレーム) → at(再生フレーム) へ射影する。
 * head/tail（'head'|'tail'）は不変で pass-through。
 * 一致する join が無い number はドロップ（カット解除で消えたつなぎ目）。
 */
export function projectSceneTransitions(transitions: SceneTransition[], joins: Join[]): SceneTransition[] {
  const out: SceneTransition[] = [];
  for (const t of transitions) {
    if (typeof t.at !== 'number') { out.push(t); continue; }
    const join = joins.find((j) => j.atOriginal === t.at);
    if (join === undefined) continue;
    out.push({ ...t, at: join.playbackFrame });
  }
  return out;
}

/**
 * 読込用: at(再生フレーム) → at(原本フレーム) へ逆射影する（アンカー化）。
 * head/tail（'head'|'tail'）は不変で pass-through。
 * 一致する join が無い number はドロップ（カット解除で消えたつなぎ目）。
 */
export function anchorSceneTransitions(transitions: SceneTransition[], joins: Join[]): SceneTransition[] {
  const out: SceneTransition[] = [];
  for (const t of transitions) {
    if (typeof t.at !== 'number') { out.push(t); continue; }
    const join = joins.find((j) => j.playbackFrame === t.at);
    if (join === undefined) continue;
    out.push({ ...t, at: join.atOriginal });
  }
  return out;
}

/**
 * 各シーン転換（at=number のみ）を現在のつなぎ目へ解決する。
 * at と一致する join が無ければドロップ（カット解除で消えたつなぎ目）。
 * head/tail は number でないので結果に含めない（呼び出し側が別処理）。
 */
export function resolveSceneTransitions(
  transitions: SceneTransition[], joins: Join[],
): Array<{ transition: SceneTransition; playbackFrame: number }> {
  const out: Array<{ transition: SceneTransition; playbackFrame: number }> = [];
  for (const t of transitions) {
    if (typeof t.at !== 'number') continue;
    const join = joins.find((j) => j.atOriginal === t.at);
    if (join === undefined) continue;
    out.push({ transition: t, playbackFrame: join.playbackFrame });
  }
  return out;
}
