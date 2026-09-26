import { useLayoutEffect, type RefObject } from 'react';

/**
 * バナー帯（`.conv-banner-slot`）の実寸を測って CSS 変数 `--banner-slot-h` へ流す。
 * 右上に固定表示する保存エラー箱の top を帯の下へずらすために使う（サイクル 2 Minor）。
 *
 * 計測は**初回マウント時の 1 回だけ**にする（deps は空）。
 * 帯は条件なしで常時マウントされているので、以後の高さ変化は ResizeObserver が拾う。
 * 毎レンダーで走らせると、App の再描画（テロップやクリップのドラッグ中は
 * pointermove ごとに起きる）のたびに
 *   1. `offsetHeight` の同期読み＝強制レイアウト
 *   2. documentElement への `setProperty`
 *   3. ResizeObserver の生成・observe・disconnect
 * が入り、ドラッグの追従が重くなる（サイクル 3 Important）。
 */
export function useBannerSlotHeight(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const apply = (): void => {
      document.documentElement.style.setProperty('--banner-slot-h', `${Math.round(el.offsetHeight)}px`);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
