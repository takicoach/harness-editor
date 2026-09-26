import type { EditState } from '../edit/editState';

/**
 * ドラッグ取り消し（pointercancel / Escape）で戻す対象。
 * 「掴んだもの」だけを指す — 選択（selection / multiTelopIds）は対象に含めない。
 */
export type DragCancelTarget =
  | { kind: 'telop'; id: number }
  | { kind: 'se'; id: number }
  | { kind: 'bgm'; id: number }
  | { kind: 'image'; id: number }
  | { kind: 'videoInsert'; id: number }
  | { kind: 'shape'; id: number }
  | { kind: 'cut' };

/** target.kind → EditState 上の配列キー。 */
const ENTITY_KEY = {
  telop: 'telops',
  se: 'se',
  bgm: 'bgm',
  image: 'images',
  videoInsert: 'videoInserts',
  shape: 'shapes',
} as const satisfies Record<Exclude<DragCancelTarget['kind'], 'cut'>, keyof EditState>;

/**
 * ドラッグ前の状態から **掴んだエンティティだけ** を現在の状態へ戻す純関数。
 *
 * 以前は `session.setTransient(preDragState)` で EditState 全体を pointerdown 直前へ
 * 巻き戻していた。しかし pre-drag スナップショットは `.tl-scroll` の
 * onPointerDownCapture（＝各つまみの bubble ハンドラより先）で掴むため、
 * 「掴んだ対象を選択する前」の選択が入っている。全体を戻すと Esc で選択が
 * **1 つ前の対象** へ戻り、矢印キーの対象（selectedHandle・useState）だけが
 * 掴んだ対象に取り残される＝画面は A を選択枠で囲みながら ←/→ は B を動かす、という
 * 食い違いが起きていた（サイクル 4 レビュー Important）。
 *
 * ここでは対象エンティティの中身だけを差し戻す。選択・他エンティティ・
 * ドラッグ中に別経路が入れた変更は現在値のまま残る。
 *
 * @param current 現在の（ライブ更新済みの）状態。
 * @param before ドラッグ開始直前の状態。
 * @param target 掴んだ対象。
 */
export function restoreDragTarget(
  current: EditState,
  before: EditState,
  target: DragCancelTarget,
): EditState {
  if (target.kind === 'cut') {
    // カット境界ドラッグが触るのは cutRegions だけ（並び順 cutOrder は動かさない）。
    return { ...current, cutRegions: before.cutRegions };
  }
  const key = ENTITY_KEY[target.kind];
  const previous = (before[key] as { id: number }[]).find((e) => e.id === target.id);
  // ドラッグ前に存在しなかった（＝ドラッグ中に生まれた）対象は戻す先が無いので触らない。
  if (previous === undefined) return current;
  const next = (current[key] as { id: number }[]).map((e) => (e.id === target.id ? previous : e));
  return { ...current, [key]: next } as EditState;
}
