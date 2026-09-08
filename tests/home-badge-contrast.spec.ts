import { test, expect } from '@playwright/test';
import { DISPLAY_STATUSES } from '../src/shared/projectStage';

/**
 * ホームカードのステータスバッジ（`.home-card-badge-wrap .status-badge`）の可読性の回帰テスト。
 *
 * バッジはサムネイル（明るい映像も暗い映像もありうる）の上に浮くため、CSS は暗色の下敷きを
 * 重ねて「暗いチップ」に固定する設計になっている。ところが下敷きが薄く（黒 55%）、
 * ライトテーマの明るい地の上ではチップが中間グレーにしかならず、SE・BGM（#38b6c4）の文字が
 * **コントラスト 1.99:1** まで落ちて読めなかった（G-4 ビジュアル検品の実測）。
 *
 * ここでは最悪条件＝「真っ白なサムネイルの上」を想定し、実際に適用された CSS から
 * チップの実効背景（下敷き→ステータス色の面）を合成して、文字色とのコントラスト比を測る。
 * 閾値は WCAG AA の本文相当 4.5:1（バッジは 10.5px と小さく、大文字扱いにはできない）。
 */

const MIN_CONTRAST = 4.5;

test.describe('ホームのステータスバッジのコントラスト', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: 全ステータスが白サムネイル上で ${MIN_CONTRAST}:1 以上`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('sme-theme', t as string), theme);
      await page.goto('/');
      // 存在検査: ホームが描かれ、実物のバッジが 1 つ以上出ている（空の画面で測らない）。
      await expect(page.locator('.home-card').first()).toBeVisible({ timeout: 15_000 });
      expect(await page.locator('.home-card-badge-wrap .status-badge').count()).toBeGreaterThan(0);

      const results = await page.evaluate((statuses) => {
        function parse(color: string): [number, number, number, number] {
          const nums = color.match(/[\d.]+/g);
          if (nums === null) return [0, 0, 0, 1];
          const [r, g, b, a] = nums.map(Number);
          // color(srgb r g b / a) は 0..1 表記で返るため 255 系へ揃える。
          const scale = color.startsWith('color(') ? 255 : 1;
          return [(r ?? 0) * scale, (g ?? 0) * scale, (b ?? 0) * scale, a ?? 1];
        }
        function over(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
          return [0, 1, 2].map((i) => fg[3] * (fg[i] as number) + (1 - fg[3]) * (bg[i] as number)) as [number, number, number];
        }
        function lum(c: [number, number, number]): number {
          const ch = c.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
        }

        // 実際の CSS を当てるためのプローブ（`.home-card-badge-wrap` の子孫であることが要件）。
        const wrap = document.createElement('div');
        wrap.className = 'home-card-badge-wrap';
        wrap.style.position = 'fixed';
        wrap.style.left = '-9999px';
        document.body.appendChild(wrap);

        const out: Array<{ status: string; contrast: number; fg: string; bg: string }> = [];
        for (const status of statuses) {
          const el = document.createElement('span');
          el.className = `status-badge status-${status}`;
          wrap.appendChild(el);
          const cs = getComputedStyle(el);
          const fg = parse(cs.color);
          // 下敷き（background-color）→ ステータス色の面（background-image の最初の色）の順に、
          // 最悪条件の白サムネイルの上へ合成する。
          const underlay = over(parse(cs.backgroundColor), [255, 255, 255]);
          const tintMatch = cs.backgroundImage.match(/(rgba?\([^)]*\)|color\([^)]*\))/);
          const effective = tintMatch === null ? underlay : over(parse(tintMatch[0]), underlay);
          const l1 = lum([fg[0], fg[1], fg[2]]);
          const l2 = lum(effective);
          const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          out.push({
            status,
            contrast: Math.round(contrast * 100) / 100,
            fg: cs.color,
            bg: `rgb(${effective.map((v) => Math.round(v)).join(', ')})`,
          });
          el.remove();
        }
        wrap.remove();
        return out;
      }, [...DISPLAY_STATUSES, 'activity', 'stale']);

      // 存在検査: 全ステータス分の測定が返っている（空配列を「合格」にしない）。
      expect(results.length).toBe(DISPLAY_STATUSES.length + 2);
      const bad = results.filter((r) => r.contrast < MIN_CONTRAST);
      expect(
        bad,
        `白サムネイル上でコントラスト不足: ${bad.map((r) => `${r.status} ${r.contrast}:1 (${r.fg} on ${r.bg})`).join(' / ')}`,
      ).toEqual([]);
    });
  }
});
