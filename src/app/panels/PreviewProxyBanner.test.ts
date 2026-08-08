import { describe, expect, it } from 'vitest';
import { proxyRecommendMessage, shouldShowProxyBanner } from './PreviewProxyBanner';
import type { PreviewProxyState } from '../usePreviewProxy';

describe('proxyRecommendMessage', () => {
  it('理由を「・」で連結して案内文にする', () => {
    expect(proxyRecommendMessage(['長尺（約24分）', '可変フレームレート（Zoom・画面録画で多い形式）'])).toBe(
      'この動画は長尺（約24分）・可変フレームレート（Zoom・画面録画で多い形式）のため、編集用に軽くする処理をおすすめします（書き出しの画質には影響しません）。',
    );
  });
  it('理由が空でも文が成立する', () => {
    expect(proxyRecommendMessage([])).toContain('容量が大きい');
  });
});

describe('shouldShowProxyBanner', () => {
  const idleRecommended: PreviewProxyState = {
    status: 'idle', hasProxy: false, recommended: true, reasons: ['長尺（約24分）'],
  };

  it('推奨あり・未 dismiss の idle で表示する', () => {
    expect(shouldShowProxyBanner(idleRecommended, false)).toBe(true);
  });
  it('dismiss 済み・軽量版あり・推奨なし・unknown は表示しない', () => {
    expect(shouldShowProxyBanner(idleRecommended, true)).toBe(false);
    expect(shouldShowProxyBanner({ ...idleRecommended, hasProxy: true }, false)).toBe(false);
    expect(shouldShowProxyBanner({ ...idleRecommended, recommended: false }, false)).toBe(false);
    expect(shouldShowProxyBanner({ status: 'unknown' }, false)).toBe(false);
  });
  it('running / done / error は dismiss に関わらず表示する', () => {
    expect(shouldShowProxyBanner({ status: 'running', percent: 5, startedAt: 1 }, true)).toBe(true);
    expect(shouldShowProxyBanner({ status: 'done' }, true)).toBe(true);
    expect(shouldShowProxyBanner({ status: 'error', error: { code: 'x', message: 'y' } }, true)).toBe(true);
  });
});
