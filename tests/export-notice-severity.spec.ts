import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { createTempProject, removeTempProject } from './helpers';
import { shotDir } from './shotDir';

/**
 * 書き出し通知の**色の重要度**を実アプリで測り、証拠画像を撮る spec（E-2）。
 *
 * 直した破綻: 情報通知（info）が `--accent`（サーモン）で着色されており、実際の警告
 * （warn＝ゴールド）より警戒色に見えていた。2 件同時に立つと視覚的な重要度が逆転する。
 *
 * この spec が要る理由（E-2 差し戻し）: 証拠 png（docs/reports/aaa-screenshots/E-2/notes-*.png）
 * を撮った spec がリポジトリに残っておらず、**証拠を再生成・再検証できなかった**。
 * ここで撮り直せるようにし、同時に「案内が注意より派手ではない」を彩度で数値判定する
 * （CSS の規約は ExportNotices.render.test.tsx が別途固定している。こちらは実ブラウザの
 * computed style ＝ 変数解決後の実際の色を見る）。
 *
 * 出力先は既定で `.aaa-shots/E-2`（追跡しない）。証拠を更新する時だけ
 * `npm run shots:evidence`（AAA_UPDATE_EVIDENCE=1）で docs/reports 側へ書く。
 */

const OUT_DIR = shotDir('E-2');

let projectId = '';
let projectDir = '';

test.beforeEach(() => {
  ({ id: projectId, dir: projectDir } = createTempProject('export-note-tmp'));
});

test.afterEach(async ({ page, request }) => {
  await page.close();
  await request.delete(`/api/render?id=${projectId}`).catch(() => {});
  removeTempProject(projectDir);
});

for (const theme of ['light', 'dark'] as const) {
  test(`書き出し通知: 案内(info)は注意(warn)より派手ではない（${theme}）`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('sme-theme', t as string), theme);
    // mock 書き出しでは「高速→互換経路へやり直し」の warning が立たない（実 ffmpeg が要る）ため、
    // POST に mock 限定スイッチを足して 2 件同時表示を作る（renderApi.ts の mockWarning）。
    await page.route('**/api/render?*', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      return route.continue({ url: `${req.url()}&mockWarning=1` });
    });

    await openProject(page, projectId);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('.tb-render-btn').click();
    const dialog = page.locator('[data-testid="export-dialog"]');
    await expect(dialog).toBeVisible();
    await page.locator('[data-testid="export-start"]').click();
    await expect(dialog).toHaveCount(0);

    // ---- 存在検査（空の画面はいつでも綺麗に見える）----
    const notices = page.locator('[data-testid="export-notices"]');
    const info = notices.locator('.export-note-info');
    const warn = notices.locator('.export-note-warn');
    await expect(info, 'info の通知が出ていない（色の比較にならない）').toBeVisible({ timeout: 15_000 });
    await expect(warn, 'warn の通知が出ていない（色の比較にならない）').toBeVisible({ timeout: 15_000 });
    for (const [name, loc] of [['info', info], ['warn', warn]] as const) {
      const box = await loc.boundingBox();
      expect(box, `${name} に矩形が無い`).not.toBeNull();
      expect(box!.width, `${name} の幅が無い`).toBeGreaterThan(100);
      expect(box!.height, `${name} の高さが無い`).toBeGreaterThan(10);
      expect((await loc.innerText()).length, `${name} が空文字`).toBeGreaterThan(5);
    }

    // ---- 色の重要度を数値で測る ----
    // 「派手さ」＝彩度（0..1・chroma ÷ 最大値）。無彩色（灰・白・黒）は 0、
    // サーモンやゴールドのような色付きは大きくなる。
    //
    // 色は文字列を正規表現で読まない。computed style は `color-mix(...)` を
    // **解決せずそのまま返す**ことがあり（Chromium 実測: .export-note-warn の
    // background-color）、`rgb()` 前提の自前パーサは黙って 0 を返す＝派手さを
    // 見落とす fail-open になる（実測: これで壊れた旧 CSS が緑になった）。
    // 1x1 canvas に実際に塗って**画素**を読む（どの記法でも解決される・α も下地と合成される）。
    const measured = await page.evaluate(() => {
      const cv = document.createElement('canvas');
      cv.width = 1;
      cv.height = 1;
      const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
      const SENTINEL = '#010203';
      /** css 色を実際に塗って彩度を測る。解決できなければ null（＝測れていない）。 */
      const chroma = (css: string): number | null => {
        ctx.fillStyle = SENTINEL;
        ctx.fillStyle = css;
        // 代入が無効なら fillStyle は据え置かれる＝この色は測れていない。
        if (ctx.fillStyle === SENTINEL && css.replace(/\s/g, '') !== SENTINEL) return null;
        // 半透明の色は「中間グレーの上に置いた見え」で測る（下地込みの実際の見え）。
        const paint = ctx.fillStyle;
        ctx.fillStyle = '#808080';
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = paint;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data as unknown as [number, number, number];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        return max <= 0 ? 0 : (max - min) / max;
      };
      const of = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        const cs = getComputedStyle(el);
        const parts = {
          text: chroma(cs.color),
          bg: chroma(cs.backgroundColor),
          border: chroma(cs.borderTopColor),
        };
        return { parts, raw: { text: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor } };
      };
      return {
        // 測定器そのものの検査（色を解決できているか）。
        probe: {
          neutral: chroma('rgb(40, 40, 40)'),
          mixed: chroma('color-mix(in srgb, rgb(255, 90, 60) 60%, rgb(20, 20, 20))'),
          translucent: chroma('rgba(255, 0, 0, 0.5)'),
        },
        info: of('.export-note-info'),
        warn: of('.export-note-warn'),
      };
    });

    // 測定器の存在検査: 無彩色は 0・混色記法も半透明も解決できている。
    // （ここが null や 0 のまま素通りすると「派手さ 0」で何でも緑になる）
    expect(measured.probe.neutral, '無彩色を彩度ありと測っている').toBe(0);
    expect(measured.probe.mixed, 'color-mix を解決できていない').not.toBeNull();
    expect(measured.probe.mixed!, 'color-mix の彩度が測れていない').toBeGreaterThan(0.3);
    expect(measured.probe.translucent!, '半透明色の彩度が測れていない').toBeGreaterThan(0.3);

    /** 3 か所（文字・地・縁）のうち最も派手な値。null＝測れていない場合は失敗させる。 */
    const maxChroma = (m: typeof measured.info): number => {
      for (const [k, v] of Object.entries(m.parts)) {
        expect(v, `${k} の色を解決できていない: ${JSON.stringify(m.raw)}`).not.toBeNull();
      }
      return Math.max(...Object.values(m.parts).map((v) => v as number));
    };
    const infoC = maxChroma(measured.info);
    const warnC = maxChroma(measured.warn);

    // (1) warn は注意色を保っている（案内と同じ見た目に退化していない）。
    expect(
      measured.warn.parts.text!,
      `warn の文字が無彩色になっている（注意色を失った）: ${JSON.stringify(measured.warn)}`,
    ).toBeGreaterThan(0.3);

    // (2) 案内(info)の**地色と縁**はほぼ無彩色であること。ここが実測の破綻の場所で、
    // 以前は --accent（サーモン）で塗られていた（実測の彩度: light 縁 0.35 / dark 地 0.33）。
    // 直後の値は light 地 0.04・縁 0.08 / dark 地 0.13・縁 0.18 なので、その間の 0.25 を
    // 「案内に許される色味の上限」とする（両側に 0.05 以上の余裕がある）。
    for (const part of ['bg', 'border'] as const) {
      expect(
        measured.info.parts[part]!,
        `案内(info)の ${part} が色味を持ちすぎている（注意色に見える）: ${JSON.stringify(measured.info)}`,
      ).toBeLessThan(0.25);
    }

    // (3) そのうえで、案内が注意より派手にならないこと（重要度の逆転そのもの）。
    expect(
      infoC,
      `info が warn 並みに派手（重要度の逆転）: info=${JSON.stringify(measured.info)} warn=${JSON.stringify(measured.warn)}`,
    ).toBeLessThan(warnC - 0.2);

    // ---- 実物を画像として残す（DOM の PASS は破綻の不在を意味しない）----
    const box = await notices.boundingBox();
    expect(box, '通知帯に矩形が無い').not.toBeNull();
    await page.screenshot({
      path: join(OUT_DIR, `notes-${theme}.png`),
      animations: 'disabled',
      clip: { x: box!.x, y: box!.y, width: box!.width, height: box!.height },
    });
  });
}

/** プロジェクトを開いてプレビューがマウントされるまで待つ。 */
async function openProject(page: Page, id: string): Promise<void> {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: id });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
}
