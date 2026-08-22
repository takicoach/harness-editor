/**
 * タイムラインの横スクロール挙動（再生追従・ホイール判定）を担う純粋関数群。
 * DOM に触れず数値だけで完結させ、ユニットテストで挙動を固定する。
 */

/**
 * 再生追従スクロール。再生ヘッドの X（コンテンツ座標・ガター込み）を、可視域の左から
 * `anchorRatio` の位置へ寄せる scrollLeft を返す。
 *
 * - ヘッドが anchor 線より左にいる間は desired が負 → 0 にクランプ（先頭は素直に左から流れる）。
 * - anchor 線を越えたら scrollLeft がヘッドに追従し、ヘッドは画面内 anchorRatio の位置に張り付く。
 *   毎フレーム呼ぶことで滑らかな（ヌルヌルした）追従になる。
 * - 末尾では scrollWidth - clientWidth でクランプし、ヘッドは右端へ自然に寄る。
 */
export function followScrollLeft(
  playheadX: number,
  clientWidth: number,
  scrollWidth: number,
  anchorRatio = 0.45,
): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  const desired = playheadX - clientWidth * anchorRatio;
  return Math.max(0, Math.min(max, desired));
}

/** zoomAnchoredScrollLeft の入力。 */
export interface ZoomAnchor {
  /** ズーム前の、アンカー（再生ヘッド or マウス位置）のコンテンツ座標 X（ガター込み）。 */
  anchorContentX: number;
  /** 可視域の左端から見たアンカーの位置（px）。ズーム後もここへ戻す。 */
  viewportOffset: number;
  /** ズーム倍率（クランプ後 pxPerFrame ÷ クランプ前 pxPerFrame）。 */
  ratio: number;
  /** トラック見出しの固定幅。ズームしても伸縮しないので拡大対象から除く。 */
  gutter: number;
  /** 可視域の幅。 */
  clientWidth: number;
  /** ズーム後のコンテンツ全幅。 */
  scrollWidth: number;
}

/**
 * アンカー固定ズームの scrollLeft を返す。
 *
 * アンカー（ボタンズーム＝再生ヘッド／Ctrl+ホイール＝マウス位置）が、ズーム前後で
 * 画面上の同じ位置に留まるようにスクロール位置を補正する。これが無いと拡大のたびに
 * 「今いる場所」が画面外へ飛んでいく。
 *
 * ガター（見出し幅）はズームで伸縮しないため、拡大するのはガターより右の距離だけ。
 */
export function zoomAnchoredScrollLeft({
  anchorContentX,
  viewportOffset,
  ratio,
  gutter,
  clientWidth,
  scrollWidth,
}: ZoomAnchor): number {
  const anchorAfter = gutter + (anchorContentX - gutter) * ratio;
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.max(0, Math.min(max, anchorAfter - viewportOffset));
}

/** 端ドラッグ自動スクロール（edge-autoscroll）が発動する、可視域端からの距離（px）。 */
export const EDGE_ZONE_PX = 40;

/** 端ドラッグ自動スクロールの最大速度（px / アニメーションフレーム）。端ちょうどでこの値。 */
export const MAX_EDGE_SCROLL_PX = 20;

/**
 * 端ドラッグ自動スクロール（edge-autoscroll）の 1 フレームぶんのスクロール量を返す。
 *
 * ドラッグ中のポインタが可視域（`.tl-body`）の左右端 `EDGE_ZONE_PX` 以内へ入ったら、
 * 端への深さに比例した速度で横スクロールさせる。ゾーン境界で 0・端ちょうどで
 * `MAX_EDGE_SCROLL_PX`。可視域の外へ出ても最大速度でクランプする（暴走させない）。
 *
 * 符号は scrollLeft への加算量と同じ向き＝左端は負（先頭側へ）・右端は正（末尾側へ）。
 * 可視域が端ゾーン 2 つ分より狭いときは左右のゾーンが重なるため、深く入っている方
 * （＝近い方の端）を採る。DOM に触れない純関数（呼び出し側が rAF で回す）。
 */
export function edgeScrollVelocity(
  pointerX: number,
  viewportLeft: number,
  viewportRight: number,
): number {
  if (!Number.isFinite(pointerX) || !Number.isFinite(viewportLeft) || !Number.isFinite(viewportRight)) {
    return 0;
  }
  if (viewportRight <= viewportLeft) return 0;
  // ゾーンへ入った深さ（px）。0 以下ならそのゾーンの外。
  const leftDepth = viewportLeft + EDGE_ZONE_PX - pointerX;
  const rightDepth = pointerX - (viewportRight - EDGE_ZONE_PX);
  const depth = Math.max(leftDepth, rightDepth);
  if (depth <= 0) return 0;
  const ratio = Math.min(1, depth / EDGE_ZONE_PX);
  const speed = MAX_EDGE_SCROLL_PX * ratio;
  return leftDepth >= rightDepth ? -speed : speed;
}

/** 端スクロール速度の基準フレーム間隔（ms）。60Hz を 1.0 倍とする。 */
export const EDGE_SCROLL_BASE_FRAME_MS = 1000 / 60;

/** 端スクロールの 1 フレーム倍率の上限。タブ復帰などの巨大 dt で一気に飛ばさないための蓋。 */
export const MAX_EDGE_SCROLL_FRAME_SCALE = 3;

/**
 * 端スクロール速度を実時間へ正規化する倍率を返す。
 *
 * `edgeScrollVelocity` は「60Hz の 1 フレームあたり px」を返す。これをそのまま加算すると
 * 120Hz のディスプレイでは倍速、負荷でコマ落ちした環境では鈍足になる。rAF の
 * timestamp 差分（dt）を基準間隔で割った倍率を掛けて、実時間あたりの速度を揃える。
 *
 * - 前回時刻が無い初回フレームは 1 倍（dt を推測しない）。
 * - dt が 0・負・非有限（計測不能）も 1 倍で素通しする。
 * - 巨大 dt（タブ非アクティブからの復帰など）は `MAX_EDGE_SCROLL_FRAME_SCALE` でクランプ。
 */
export function edgeScrollFrameScale(dtMs: number | null): number {
  if (dtMs === null || !Number.isFinite(dtMs) || dtMs <= 0) return 1;
  return Math.min(MAX_EDGE_SCROLL_FRAME_SCALE, dtMs / EDGE_SCROLL_BASE_FRAME_MS);
}

/** edgeScrollSpeed の入力。座標はすべてビューポート座標（clientX/getBoundingClientRect 系）。 */
export interface EdgeScrollInput {
  /** ポインタの X。 */
  pointerX: number;
  /** ポインタの Y。可視域の上下外なら発動しない。 */
  pointerY: number;
  /** 可視域（スクロールコンテナ）の矩形。 */
  rect: { left: number; right: number; top: number; bottom: number };
  /** トラック見出しの固定幅。ここより左は常に見えているので発動域から除く。 */
  gutter: number;
  /** 端から何 px を発動域にするか。省略時は可視域の幅から自動算出（edgeScrollZone）。 */
  zone?: number;
  /** 最深部（端に張り付いた時）の速度（px/秒）。 */
  maxSpeed?: number;
}

/**
 * 端ホバー自動スクロールの発動域の幅（px）を、可視域の幅（ガターを除く）から決める。
 *
 * 固定 px にすると、4K で気持ちよい幅が MacBook では画面に対して広すぎ、
 * 端のクリップを掴もうとしただけで走り出してしまう。可視幅の 4%（上限 64px・下限 28px）とし、
 * どの画面でも「端に寄せた時だけ」発動する体感を揃える。
 */
export function edgeScrollZone(inner: number): number {
  return Math.max(28, Math.min(64, inner * 0.04));
}

/**
 * 端ホバー自動スクロールの速度（px/秒。負＝左へ）を返す。
 *
 * マウス（横スワイプできない環境）でタイムラインの右端より先を見るための操作。
 * カーソルを可視域の左右の端へ寄せるほど速くスクロールする。トラックパッドの横スワイプの代替。
 *
 * - 可視域の外（上下・左右とも）なら 0＝停止。パネルからカーソルが出れば即止まる。
 * - 左の発動域はガターの右端から数える（見出し列の上にいる間は発動しない）。
 * - 速度は「発動域にどれだけ食い込んだか」の 2 乗に比例させる。入り口では這うように遅く、
 *   端に張り付くと最速になり、狙ったクリップの手前で止めやすい。
 */
export function edgeScrollSpeed({
  pointerX,
  pointerY,
  rect,
  gutter,
  zone,
  maxSpeed = 1600,
}: EdgeScrollInput): number {
  if (pointerY < rect.top || pointerY > rect.bottom) return 0;
  if (pointerX < rect.left || pointerX > rect.right) return 0;
  // 発動域が重なるほど可視域が狭い場合は、半分ずつに分けて左右の取り合いを防ぐ。
  const inner = Math.max(0, rect.right - (rect.left + gutter));
  const z = Math.min(zone ?? edgeScrollZone(inner), inner / 2);
  if (z <= 0) return 0;

  const fromRight = rect.right - pointerX;
  if (fromRight <= z) {
    const ratio = Math.min(1, (z - fromRight) / z);
    return maxSpeed * ratio * ratio;
  }
  const fromLeft = pointerX - (rect.left + gutter);
  if (fromLeft >= 0 && fromLeft <= z) {
    const ratio = Math.min(1, (z - fromLeft) / z);
    // ratio=0（発動域の外縁ちょうど）で -0 を返さない。
    return ratio === 0 ? 0 : -maxSpeed * ratio * ratio;
  }
  return 0;
}

/** ホイール操作の意図。zoom=拡縮 / pan=横スクロール / native=ブラウザ標準（縦スクロール等）。 */
export type WheelAction =
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number }
  | { kind: 'native' };

/** wheelAction が見るホイールイベントの最小形。 */
export interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
}

/**
 * ホイールイベントの意図を判定する。
 * - Ctrl/Cmd＋ホイール → ズーム（上で拡大・下で縮小）。
 * - Shift＋縦ホイール → 横スクロール（縦量を横へ変換）。
 * - それ以外 → ブラウザ標準（縦ホイール＝縦スクロールで素材トラックを上下に閲覧、
 *   横スワイプ＝横スクロール）。縦ホイールを横パンへ奪わないことで「下＝下」を直感的にする。
 */
export function wheelAction(e: WheelLike): WheelAction {
  if (e.ctrlKey || e.metaKey) {
    return { kind: 'zoom', factor: e.deltaY < 0 ? 1.2 : 1 / 1.2 };
  }
  if (e.shiftKey && e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
    return { kind: 'pan', dx: e.deltaY };
  }
  return { kind: 'native' };
}
