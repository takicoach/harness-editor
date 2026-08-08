/**
 * @vitest-environment jsdom
 *
 * 書き出し進捗リングの回帰。旧表示（横長バー）はラベルと同じ行に敷かれ、進捗が
 * 進むほどラベルを押し出して「書き出…」と切れていた。リング化の要点は
 * ①進捗が % で読めること ②ラベルが省略されないこと ③不定区間が分かること。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import {
  RenderProgressRing,
  ringDashOffset,
  ringGeometry,
  ringPercentText,
} from './RenderProgressRing';
import { renderRingLabel } from './Toolbar';

afterEach(() => {
  cleanup();
});

describe('ringDashOffset', () => {
  const { circumference } = ringGeometry();

  it('0% は全周ぶんオフセット（弧を描かない）', () => {
    expect(ringDashOffset(0, circumference)).toBeCloseTo(circumference, 6);
  });

  it('50% は半周', () => {
    expect(ringDashOffset(50, circumference)).toBeCloseTo(circumference / 2, 6);
  });

  it('100% は 0（全周を描く）', () => {
    expect(ringDashOffset(100, circumference)).toBeCloseTo(0, 6);
  });

  it('範囲外・非有限は 0..100 へクランプする（弧が反転しない）', () => {
    expect(ringDashOffset(-10, circumference)).toBeCloseTo(circumference, 6);
    expect(ringDashOffset(140, circumference)).toBeCloseTo(0, 6);
    expect(ringDashOffset(Number.NaN, circumference)).toBeCloseTo(circumference, 6);
  });
});

describe('ringPercentText', () => {
  it('四捨五入して % を付ける', () => {
    expect(ringPercentText(45.6)).toBe('46%');
    expect(ringPercentText(0)).toBe('0%');
    expect(ringPercentText(100)).toBe('100%');
  });

  it('null（不定）はテキストなし', () => {
    expect(ringPercentText(null)).toBeNull();
  });
});

describe('RenderProgressRing の描画', () => {
  function dial() {
    return screen.getByRole('progressbar');
  }
  function valueArc(): SVGCircleElement {
    const el = document.querySelector('.tb-render-ring-value');
    if (el === null) throw new Error('value arc not found');
    return el as unknown as SVGCircleElement;
  }

  it('0%: 中央に 0% を出し、弧は全周ぶんオフセットされる', () => {
    render(<RenderProgressRing percent={0} label="書き出し中" />);
    expect(screen.getByText('0%')).toBeTruthy();
    expect(dial().getAttribute('aria-valuenow')).toBe('0');
    const { circumference } = ringGeometry();
    expect(Number(valueArc().getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference, 3);
  });

  it('50%: 弧が半周ぶん描かれる', () => {
    render(<RenderProgressRing percent={50} label="書き出し中" />);
    expect(screen.getByText('50%')).toBeTruthy();
    expect(dial().getAttribute('aria-valuenow')).toBe('50');
    const { circumference } = ringGeometry();
    expect(Number(valueArc().getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference / 2, 3);
  });

  it('100%: 弧が全周（オフセット 0）', () => {
    render(<RenderProgressRing percent={100} label="仕上げ中…" />);
    expect(screen.getByText('100%')).toBeTruthy();
    expect(Number(valueArc().getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 3);
  });

  it('不定（percent=null）: % を出さず回転アニメのクラスが付く', () => {
    render(<RenderProgressRing percent={null} label="準備中（初回は数分かかります）" />);
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(dial().hasAttribute('aria-valuenow')).toBe(false);
    expect(document.querySelector('.tb-render-ring')?.classList.contains('indeterminate')).toBe(true);
  });

  it('ラベルは省略されず全文が入る（「書き出…」で切れないこと）', () => {
    const label = '準備中（初回は数分かかります）';
    render(<RenderProgressRing percent={null} label={label} />);
    const labelEl = document.querySelector('.tb-render-ring-label');
    expect(labelEl?.textContent).toBe(label);
    // 省略記号を付ける .tb-render-label（done/error 用）は使わない。
    expect(labelEl?.classList.contains('tb-render-label')).toBe(false);
  });
});

describe('renderRingLabel', () => {
  it('% はリング中央が担当するのでラベルには入れない', () => {
    expect(renderRingLabel('rendering', 45)).toBe('書き出し中');
    expect(renderRingLabel('rendering', 0)).toBe('書き出し中');
  });

  it('100% 到達後は「仕上げ中…」（renderPhaseLabel と同じ判断）', () => {
    expect(renderRingLabel('rendering', 100)).toBe('仕上げ中…');
    expect(renderRingLabel('rendering', 99.6)).toBe('仕上げ中…');
    expect(renderRingLabel('finalizing', 40)).toBe('仕上げ中…');
  });

  it('percent 未確定は phase 文言', () => {
    expect(renderRingLabel('preparing', null)).toBe('準備中（初回は数分かかります）');
    expect(renderRingLabel('bundling', null)).toBe('バンドル中…');
    expect(renderRingLabel('rendering', null)).toBe('書き出し中…');
    expect(renderRingLabel('something-else', null)).toBe('書き出し中…');
  });
});
