import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * フォーカスを受け取れる要素のセレクタ（表示順＝DOM 順で拾う）。
 * `tabindex="-1"` はプログラムからのフォーカス専用なので Tab の巡回には含めない。
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 表示されていて Tab で到達できる要素かどうか（サイクル 4 Codex 指摘 P2）。
 *
 * 属性（hidden / aria-hidden / disabled）だけでは足りない。CSS で祖先ごと隠した要素は
 * 属性上は無傷のまま残るため、巡回対象に混ざる。狭い画面（640px 以下）でヘルプの
 * `.help-detail-pane` を `display:none` にしている箇所がこれで、見えないボタンが
 * 先頭・末尾として数えられ、先頭で Shift+Tab が詰まる／表示上の末尾で Tab が
 * ダイアログの外へ抜ける、という食い違いを起こしていた。
 *
 * 祖先を root まで辿って display / visibility を見る。`offsetParent === null` や
 * `getClientRects().length === 0` は実ブラウザでは正確だが、レイアウトを持たない
 * jsdom では全要素が「非表示」になり回帰テストが書けないので採らない。
 */
function isDisplayed(el: HTMLElement, root: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView;
  if (view === null) return true;
  let node: HTMLElement | null = el;
  while (node !== null) {
    if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
      const firstSummary = Array.from(node.children).find((child) => child.tagName === 'SUMMARY');
      if (!(firstSummary instanceof HTMLElement) || (firstSummary !== el && !firstSummary.contains(el))) return false;
    }
    const style = view.getComputedStyle(node);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (node === root) break;
    node = node.parentElement;
  }
  return true;
}

/** root の中で Tab の巡回対象になる要素を DOM 順に返す（テストから使う）。 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.hasAttribute('hidden') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      isDisplayed(el, root),
  );
}

/**
 * `aria-modal="true"` を名乗るダイアログの中に Tab を閉じ込める（サイクル 3 残 Minor）。
 *
 * aria-modal は支援技術に「この外側は今は無いものとして扱え」と宣言する属性なのに、
 * 実際の Tab は背後のツールバー・タイムラインへ普通に抜けていた。宣言と挙動が食い違うと、
 * キーボードだけの利用者は「見えないダイアログの外」を触ってしまう。
 *
 * - 最後の要素で Tab → 先頭へ、先頭で Shift+Tab → 最後へ
 * - フォーカスが外へ出ている状態の Tab は、ダイアログの先頭（Shift なら末尾）へ引き戻す
 * - 中に 1 つも対象が無ければ Tab を握り潰す（外へ抜けさせない）
 *
 * capture 相で購読するのは、途中のコンポーネントが Tab を先に消費しても巡回を保つため。
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Tab' || e.isComposing) return;
      const root = ref.current;
      if (root === null) return;
      const items = focusableIn(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, ref]);
}
