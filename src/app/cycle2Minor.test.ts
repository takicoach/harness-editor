/**
 * サイクル 2 の持ち越し Minor の回帰ガード（ソース上の配線を固定する）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONVERT_REOPEN_ABORTED_TOAST } from './App';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(APP_DIR, rel), 'utf8');

describe('handleConvert の保存失敗通知', () => {
  it('開き直しを見送ったら黙らずに知らせる', () => {
    expect(CONVERT_REOPEN_ABORTED_TOAST).toContain('保存できなかったため開き直しませんでした');
    expect(read('App.tsx')).toContain("if (!reopened) showToast(CONVERT_REOPEN_ABORTED_TOAST, 'error');");
  });
});

describe('保存エラー箱と外部変更バナーの重なり', () => {
  it('箱の top はツールバー実寸＋帯の高さから決まる（60px の決め打ちではない）', () => {
    const css = read('styles.css');
    expect(css).toContain('top: calc(var(--topbar-h, 52px) + 8px + var(--banner-slot-h, 0px))');
    // 起点になる --topbar-h が実在すること（変数名を変えたらここが赤くなる）。
    expect(css).toMatch(/--topbar-h:\s*\d+px/);
    expect(css).not.toContain('top: calc(60px +');
  });

  it('帯の実寸を測って CSS 変数へ流している', () => {
    // 計測本体は useBannerSlotHeight へ切り出した（サイクル 3 Important）。
    expect(read('App.tsx')).toContain('useBannerSlotHeight(bannerSlotRef)');
    expect(read('useBannerSlotHeight.ts')).toContain("setProperty('--banner-slot-h'");
  });
});
