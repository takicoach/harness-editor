/**
 * @vitest-environment jsdom
 *
 * aria-modal を名乗るダイアログのフォーカストラップ（サイクル 3 残 Minor）。
 *
 * 宣言（aria-modal="true"＝外側は無いものとして扱え）と実際の Tab の挙動が食い違うと、
 * キーボードだけの利用者は「見えないダイアログの外」を触ってしまう。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useFocusTrap, focusableIn } from './useFocusTrap';

afterEach(cleanup);

function Dialog({ empty = false }: { empty?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div>
      <button type="button" data-testid="outside">
        外のボタン
      </button>
      <div ref={ref} role="dialog" aria-modal="true" data-testid="dialog">
        {!empty && (
          <>
            <button type="button" data-testid="first">
              先頭
            </button>
            <input data-testid="middle" />
            <button type="button" data-testid="last">
              末尾
            </button>
            <button type="button" data-testid="disabled" disabled>
              押せない
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function setup(empty = false): HTMLElement {
  return render(<Dialog empty={empty} />).container;
}

/**
 * 祖先を CSS で隠したペイン（640px 以下のヘルプの `.help-detail-pane` 相当）を挟んだ版。
 * ボタン自身は無傷（hidden も disabled も付かない）なので、属性だけ見る実装では
 * 巡回対象に残ってしまう。
 */
function PaneDialog() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div ref={ref} role="dialog" aria-modal="true" data-testid="dialog">
      {/* DOM 上の先頭と末尾を隠れたペインが占める＝表示上の端とズレる配置。 */}
      <div style={{ display: 'none' }}>
        <button type="button" data-testid="in-hidden-pane">
          見えないボタン（先頭側）
        </button>
      </div>
      <button type="button" data-testid="first">
        先頭
      </button>
      <button type="button" data-testid="last">
        末尾
      </button>
      <div style={{ display: 'none' }}>
        <button type="button" data-testid="in-hidden-pane-tail">
          見えないボタン（末尾側）
        </button>
      </div>
    </div>
  );
}

function ClosedDetailsDialog() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div ref={ref} role="dialog" aria-modal="true" data-testid="details-dialog">
      <button type="button" data-testid="before-details">手前</button>
      <details>
        <summary data-testid="restore-summary">書き出した記録を戻す</summary>
        <input data-testid="closed-details-input" />
        <summary data-testid="closed-details-second-summary">末尾側の要素</summary>
      </details>
    </div>
  );
}
const byId = (c: HTMLElement, id: string): HTMLElement =>
  c.querySelector(`[data-testid="${id}"]`) as HTMLElement;

describe('focusableIn', () => {
  it('無効化されたボタンは巡回対象に入れない', () => {
    const c = setup();
    const ids = focusableIn(byId(c, 'dialog')).map((el) => el.dataset['testid']);
    expect(ids).toEqual(['first', 'middle', 'last']);
  });
});

describe('focusableIn — 祖先の CSS 非表示', () => {
  it('display:none の祖先を持つボタンは巡回対象から外れる', () => {
    const c = render(<PaneDialog />).container;
    // 前提の存在検査: 隠れたボタンは DOM に実在している（空の箱を見て緑にしない）。
    expect(byId(c, 'in-hidden-pane')).not.toBeNull();
    const ids = focusableIn(byId(c, 'dialog')).map((el) => el.dataset['testid']);
    expect(ids).toEqual(['first', 'last']);
  });

  it('末尾は「表示上の末尾」になり、そこからの Tab は外へ抜けない', () => {
    const c = render(<PaneDialog />).container;
    byId(c, 'last').focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(byId(c, 'first'));
  });

  it('先頭からの Shift+Tab は隠れたボタンではなく表示上の末尾へ回る', () => {
    const c = render(<PaneDialog />).container;
    byId(c, 'first').focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(byId(c, 'last'));
  });
});

describe('focusableIn — 閉じた details', () => {
  it('表示中の最初の summary だけを巡回対象に残す', () => {
    const c = render(<ClosedDetailsDialog />).container;
    const ids = focusableIn(byId(c, 'details-dialog')).map((el) => el.dataset['testid']);
    expect(ids).toEqual(['before-details', 'restore-summary']);
  });

  it('閉じた summary から Tab するとダイアログの先頭へ戻る', () => {
    const c = render(<ClosedDetailsDialog />).container;
    byId(c, 'restore-summary').focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(byId(c, 'before-details'));
  });
});

describe('useFocusTrap', () => {
  it('末尾で Tab を押すと先頭へ戻る（外へ抜けない）', () => {
    const c = setup();
    byId(c, 'last').focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(byId(c, 'first'));
  });

  it('先頭で Shift+Tab を押すと末尾へ回る', () => {
    const c = setup();
    byId(c, 'first').focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(byId(c, 'last'));
  });

  it('途中の要素では既定の移動に任せる（巡回を邪魔しない）', () => {
    const c = setup();
    byId(c, 'middle').focus();
    // preventDefault されない＝ブラウザ既定の Tab 移動が生きる。
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(true);
  });

  it('フォーカスが外にあるときの Tab はダイアログの先頭へ引き戻す', () => {
    const c = setup();
    byId(c, 'outside').focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(byId(c, 'first'));
  });

  it('中に対象が 1 つも無ければ Tab を握り潰す（外へ抜けさせない）', () => {
    const c = setup(true);
    byId(c, 'outside').focus();
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(byId(c, 'outside'));
  });

  it('Tab 以外のキーには触らない', () => {
    const c = setup();
    byId(c, 'last').focus();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(byId(c, 'last'));
  });
});
