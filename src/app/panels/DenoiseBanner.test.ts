/**
 * DenoiseBanner のユニットテスト。
 *
 * DOM レンダリングを使わず、フェーズ表示テキストのロジックを純関数として検証する。
 */

import { describe, it, expect } from 'vitest';
import { denoisePhaseLabelJa } from './DenoiseBanner';

describe('denoisePhaseLabelJa', () => {
  it('preparing → 準備中', () => {
    expect(denoisePhaseLabelJa('preparing')).toBe('準備中');
  });

  it('denoising → ノイズ除去中', () => {
    expect(denoisePhaseLabelJa('denoising')).toBe('ノイズ除去中');
  });

  it('finalizing → 書き出し中', () => {
    expect(denoisePhaseLabelJa('finalizing')).toBe('書き出し中');
  });

  it('未知のフェーズ → そのまま返す', () => {
    expect(denoisePhaseLabelJa('unknown-phase')).toBe('unknown-phase');
  });
});
