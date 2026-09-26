/**
 * @vitest-environment jsdom
 *
 * 監査 data-safety-3 の回帰テスト。
 * 「先に保存するか…」と文言だけで警告し、置いてあるボタンは即時破棄の「再読込」1 つ、
 * という無防備な状態に戻っていないことを固定する。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExternalChangeBanner } from './ExternalChangeBanner';

afterEach(() => cleanup());

/** styles.css から、そのセレクタ群に与えられた宣言を拾う（テストへ色を書き写さない）。 */
function declFor(selector: string, prop: string): string | undefined {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  let found: string | undefined;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of (m[2] ?? '').split(';')) {
      const [k, v] = decl.split(':');
      if (k?.trim() === prop) found = v?.trim();
    }
  }
  return found;
}

describe('ExternalChangeBanner', () => {
  it('二次ボタンの意匠は面も枠も透明でない（ベタ打ち文字に見せない）', () => {
    // .btn-secondary の実値を styles.css から読む。透明へ戻すと赤くなる。
    expect(declFor('.btn-secondary', 'background')).toBeDefined();
    expect(declFor('.btn-secondary', 'background')).not.toBe('transparent');
    expect(declFor('.btn-secondary', 'border-color')).toBeDefined();
    expect(declFor('.btn-secondary', 'border-color')).not.toBe('transparent');
  });

  it('未保存があるときは「保存してから再読込」が主ボタンで、破棄は別ボタン', () => {
    const onSaveThenReload = vi.fn();
    const onDiscardReload = vi.fn();
    render(
      <ExternalChangeBanner
        dirty
        onReload={vi.fn()}
        onSaveThenReload={onSaveThenReload}
        onDiscardReload={onDiscardReload}
      />,
    );

    const save = screen.getByRole('button', { name: '保存してから再読込' });
    const discard = screen.getByRole('button', { name: '保存せずに再読込' });
    // 主ボタン＝バナー既定の意匠、破棄側＝低強調（同じ見た目で並べない）。
    expect(save.className).toContain('ext-banner-btn');
    // 破棄の入口は「押せるものに見える」意匠であること（ghost の完全な無地にしない）。
    expect(discard.className).toContain('btn-secondary');
    expect(discard.className).not.toContain('btn-ghost');

    fireEvent.click(save);
    expect(onSaveThenReload).toHaveBeenCalledTimes(1);
    expect(onDiscardReload).not.toHaveBeenCalled();

    fireEvent.click(discard);
    expect(onDiscardReload).toHaveBeenCalledTimes(1);
  });

  it('未保存があるとき、無条件に破棄する「再読込」ボタンは出さない', () => {
    render(
      <ExternalChangeBanner
        dirty
        onReload={vi.fn()}
        onSaveThenReload={vi.fn()}
        onDiscardReload={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '再読込' })).toBeNull();
  });

  it('保存衝突（409）中は、この 1 つのバナーが復帰 UI を兼ねる', () => {
    // 別窓のポップオーバーがバナーの操作領域を覆い、本文だけが見えないボタンを
    // 押せと案内していた（レビュー指摘）。文言もボタンも衝突用へ切り替える。
    const onOverwriteSave = vi.fn();
    const onDiscardReload = vi.fn();
    render(
      <ExternalChangeBanner
        dirty
        conflict
        onReload={vi.fn()}
        onSaveThenReload={vi.fn()}
        onDiscardReload={onDiscardReload}
        onOverwriteSave={onOverwriteSave}
      />,
    );
    // 覆われて見えないボタンを名指しする本文・ボタンは出さない。
    expect(screen.queryByRole('button', { name: '保存してから再読込' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存せずに再読込' })).toBeNull();
    expect(document.body.textContent).not.toContain('「保存してから再読込」を押すと');

    fireEvent.click(screen.getByRole('button', { name: 'この画面の内容で上書き保存' }));
    expect(onOverwriteSave).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole('button', { name: '外部の内容で開き直す（この画面の編集は失われます）' }),
    );
    expect(onDiscardReload).toHaveBeenCalledTimes(1);
  });

  it('衝突していなければ従来どおり「保存してから再読込」が主ボタン', () => {
    render(
      <ExternalChangeBanner
        dirty
        conflict={false}
        onReload={vi.fn()}
        onSaveThenReload={vi.fn()}
        onDiscardReload={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '保存してから再読込' })).not.toBeNull();
  });

  it('title を上書きすると見出しに出る（導入・部品更新・変換の着地で使い回す・hardening）', () => {
    const onReload = vi.fn();
    render(
      <ExternalChangeBanner
        title="更新の反映に再読込が必要です"
        dirty={false}
        onReload={onReload}
        onSaveThenReload={vi.fn()}
        onDiscardReload={vi.fn()}
      />,
    );
    const heading = screen.getByText('更新の反映に再読込が必要です');
    expect(heading.tagName).toBe('STRONG');
    expect(screen.queryByText('プロジェクトファイルが外部で更新されました')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '再読込' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('title を上書きしても、未保存があれば 2 ボタン（保存してから／保存せずに）がそれぞれのハンドラを呼ぶ', () => {
    const onSaveThenReload = vi.fn();
    const onDiscardReload = vi.fn();
    render(
      <ExternalChangeBanner
        title="更新の反映に再読込が必要です"
        dirty
        onReload={vi.fn()}
        onSaveThenReload={onSaveThenReload}
        onDiscardReload={onDiscardReload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '保存してから再読込' }));
    fireEvent.click(screen.getByRole('button', { name: '保存せずに再読込' }));
    expect(onSaveThenReload).toHaveBeenCalledTimes(1);
    expect(onDiscardReload).toHaveBeenCalledTimes(1);
  });

  it('未保存が無ければ従来どおり「再読込」1 つ', () => {
    const onReload = vi.fn();
    render(
      <ExternalChangeBanner
        dirty={false}
        onReload={onReload}
        onSaveThenReload={vi.fn()}
        onDiscardReload={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
