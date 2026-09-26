/**
 * @vitest-environment jsdom
 *
 * Space の既定動作を譲る要素集合（サイクル 1 レビューの残件・interaction-12 の続き）。
 * 折りたたみ（summary）やタブ・スイッチ・チェックボックスの上で Space を押すと、
 * その要素の操作と再生/停止が同時に起きていた。
 */
import { describe, expect, it } from 'vitest';
import { yieldsSpaceToTarget } from './Timeline';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

describe('yieldsSpaceToTarget', () => {
  it('ボタン・リンクには譲る（従来）', () => {
    expect(yieldsSpaceToTarget(el('<button>a</button>'))).toBe(true);
    expect(yieldsSpaceToTarget(el('<a href="#">a</a>'))).toBe(true);
    expect(yieldsSpaceToTarget(el('<div role="button">a</div>'))).toBe(true);
  });

  it('折りたたみの見出し（summary）に譲る', () => {
    expect(yieldsSpaceToTarget(el('<summary>詳細</summary>'))).toBe(true);
  });

  it('role=tab / switch / checkbox / radio に譲る', () => {
    expect(yieldsSpaceToTarget(el('<div role="tab">t</div>'))).toBe(true);
    expect(yieldsSpaceToTarget(el('<div role="switch">s</div>'))).toBe(true);
    expect(yieldsSpaceToTarget(el('<div role="checkbox">c</div>'))).toBe(true);
    expect(yieldsSpaceToTarget(el('<div role="radio">r</div>'))).toBe(true);
  });

  it('入力欄・プルダウンにも譲る', () => {
    expect(yieldsSpaceToTarget(el('<input type="checkbox" />'))).toBe(true);
    expect(yieldsSpaceToTarget(el('<select></select>'))).toBe(true);
  });

  it('ただの div や null には譲らない（再生/停止が効く）', () => {
    expect(yieldsSpaceToTarget(el('<div>x</div>'))).toBe(false);
    expect(yieldsSpaceToTarget(null)).toBe(false);
  });
});
