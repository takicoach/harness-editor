/**
 * 新画面チュートリアルの DOM 観測。照らす対象が「見えて押せるか」と、ダイアログが開いているかを読む。
 * jsdom では getBoundingClientRect が 0・elementFromPoint が未実装なので、本物の判定は e2e で確かめる。
 */
import { MODAL_SELECTOR } from '../isModalOpen';
import type { TutorialRect } from './TutorialOverlay';

/** 開いている間はチュートリアルを隠すもの。既存のモーダル判定＋aria-modal のダイアログ＋書き出しパネル。 */
export const NATIVE_TUTORIAL_BLOCKER_SELECTOR = `${MODAL_SELECTOR}, [role="dialog"][aria-modal="true"], .native-export-panel`;
const CREATE_DIALOG_SELECTOR = '.home-create-dialog';

export interface DialogState {
  dialogOpen: boolean;
  createDialogOpen: boolean;
}

export function readDialogState(root: ParentNode = document): DialogState {
  return {
    dialogOpen: root.querySelector(NATIVE_TUTORIAL_BLOCKER_SELECTOR) !== null,
    createDialogOpen: root.querySelector(CREATE_DIALOG_SELECTOR) !== null,
  };
}

/** 見えて押せるときの矩形。見えない・画面外・遮られているなら null。 */
export function usableRect(element: Element, win: Window = window): TutorialRect | null {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return null;
    if (win.getComputedStyle(node).display === 'none') return null;
  }
  if (win.getComputedStyle(element).visibility === 'hidden') return null;
  const r = element.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  // 画面内に見えている部分。作品一覧のように画面より大きい対象は、見えている部分の中心で当たり判定する。
  const visibleLeft = Math.max(r.left, 0), visibleTop = Math.max(r.top, 0);
  const visibleRight = Math.min(r.right, win.innerWidth), visibleBottom = Math.min(r.bottom, win.innerHeight);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;
  const doc = element.ownerDocument;
  if (typeof doc.elementFromPoint === 'function') {
    const hit = doc.elementFromPoint((visibleLeft + visibleRight) / 2, (visibleTop + visibleBottom) / 2);
    // 自分の吹き出しに当たるのは遮蔽に数えない（数えると吹き出しの移動でちらつく）。
    if (hit === null || (!element.contains(hit) && hit.closest('.tut') === null)) return null;
  }
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

/** セレクタに一致し、見えて押せる要素の外接矩形。1 つも無ければ null。 */
export function locateUsableTarget(selector: string, root: ParentNode = document, win: Window = window): TutorialRect | null {
  const rects = Array.from(root.querySelectorAll(selector))
    .map((element) => usableRect(element, win))
    .filter((rect): rect is TutorialRect => rect !== null);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
