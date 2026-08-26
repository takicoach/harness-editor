/**
 * @vitest-environment jsdom
 */
/**
 * 共通ゴミ箱アイコン（SVG）の契約テスト。
 * 絵文字版はフォント依存でプラットフォームごとに字面が変わり、色もテーマへ追従しない。
 * SVG 版は currentColor でテーマ追従し、支援技術には露出しない（ラベルは親ボタンの title/aria が持つ）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { TrashIcon } from './TrashIcon';

afterEach(cleanup);

function svgOf(node: ReactElement): SVGSVGElement {
  const { container } = render(node);
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('svg が描画されていません');
  return svg;
}

describe('TrashIcon', () => {
  it('svg を描画し、既定サイズは 16', () => {
    const svg = svgOf(<TrashIcon />);
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
  });

  it('size prop で幅・高さを指定できる', () => {
    const svg = svgOf(<TrashIcon size={20} />);
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');
  });

  it('aria-hidden で支援技術から隠す（ラベルは親ボタンが持つ）', () => {
    const svg = svgOf(<TrashIcon />);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('線色は currentColor（テーマ追従）で、塗りは持たない', () => {
    const svg = svgOf(<TrashIcon />);
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('fill')).toBe('none');
  });

  it('className を渡せる', () => {
    const svg = svgOf(<TrashIcon className="ml-row-delete" />);
    expect(svg.getAttribute('class')).toBe('ml-row-delete');
  });
});
