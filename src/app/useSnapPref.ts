import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

export interface SnapPref {
  /** 吸着 ON/OFF（既定 ON）。 */
  snapEnabled: boolean;
  setSnapEnabled: (next: boolean | ((prev: boolean) => boolean)) => void;
  /** Alt を押している間 true（ドラッグ中の一時解除）。再描画を起こさないよう ref で持つ。 */
  altHeldRef: MutableRefObject<boolean>;
}

/**
 * 「吸着」の設定を 1 か所で持つフック（監査 interaction-7）。
 *
 * 以前はタイムラインだけが吸着トグルと「ドラッグ中 Alt で一時解除」を持ち、
 * プレビュー上の位置ドラッグ（`PreviewOverlay`）は `snapPosition` を無条件で
 * かけていた。同じ「吸着」なのに画面によって解除できたりできなかったりする。
 *
 * App が 1 つだけ呼び、タイムラインとプレビューの両方へ配る。
 * Alt の keydown/keyup 購読もここに集約する（blur でのリセット込み——Alt+Tab で
 * フォーカスを失うと keyup が届かず、押しっぱなし扱いで固着する）。
 */
export function useSnapPref(): SnapPref {
  const [snapEnabled, setSnapEnabled] = useState(true);
  const altHeldRef = useRef(false);

  useEffect(() => {
    function down(e: KeyboardEvent): void {
      if (e.key === 'Alt') altHeldRef.current = true;
    }
    function up(e: KeyboardEvent): void {
      if (e.key === 'Alt') altHeldRef.current = false;
    }
    function reset(): void {
      altHeldRef.current = false;
    }
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
    };
  }, []);

  return { snapEnabled, setSnapEnabled, altHeldRef };
}
