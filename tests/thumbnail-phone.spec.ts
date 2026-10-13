import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { shapeLayer, textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { canvasToScreen, createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

test('右下にスマホでの見え方と目安。18% で「大きい」に変わり、閉じた状態は再読み込み後も続く', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-phone');
  try {
    await openThumbnailMode(page, project.id);
    const panel = page.getByRole('region', { name: 'スマホでの見え方' }), label = panel.locator('.native-thumbnail-gauge');
    await expect(label).toHaveText('文字なし');
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('title', '目安') });
    await expect(label).toHaveText('小さめ');
    // 120px × 1.08 = 129.6px ＝ 720px の 18%（境界ちょうどは「大きい」）。
    await thumbnailCommand(request, project.id, { type: 'update-layer', pageId, layerId: 'title', patch: { visual: { position: { x: 0, y: 0 }, scale: 1.08, rotation: 0, opacity: 1 } } });
    await expect(label).toHaveText('大きい');
    await expect(panel.locator('img.native-thumbnail-phone-image')).toBeVisible({ timeout: 60_000 });
    await panel.screenshot({ path: join(shotDir('thumbnail'), 'b16-phone.png') });
    await panel.getByRole('button', { name: 'スマホでの見え方を閉じる' }).click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect(page.getByRole('button', { name: 'スマホでの見え方', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'スマホでの見え方' })).toHaveCount(0);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

for (const width of [1280, 1440]) test(`スマホでの見え方の小窓は小さく、キャンバスと重ならず、キャンバスのクリックを奪わない（${width}px）`, async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 860 });
  const project = createThumbnailProject(`e2e-thumb-phone-place-${width}`);
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    // キャンバスの右下の隅に四角を置く（小窓が重なると、ここが覆われてクリックも小窓が受けていた）。
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: { ...shapeLayer('corner'), visual: { position: { x: .75, y: .7 }, scale: 1, rotation: 0, opacity: 1 } } });
    const panel = page.getByRole('region', { name: 'スマホでの見え方' }), surface = page.locator('.native-thumbnail-surface');
    await expect(panel).toBeVisible();
    const apart = async () => {
      const a = await panel.boundingBox(), b = await surface.boundingBox();
      if (!a || !b) return 'no-box';
      return a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height ? 'apart' : `overlap ${JSON.stringify({ panel: a, canvas: b })}`;
    };
    await expect.poll(apart).toBe('apart');
    expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(200);
    // 文字の大きさの目安は見出しの右に短く出す。
    await expect(panel.locator('.native-thumbnail-phone-head .native-thumbnail-gauge')).toHaveText('文字なし');
    // 表示倍率を変えても、引き出しを閉じて広くしても重ならない。
    await page.getByRole('combobox', { name: '倍率' }).selectOption('50');
    await expect.poll(apart).toBe('apart');
    await page.getByRole('button', { name: '全体表示' }).click();
    await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: 'テキスト' }).click();
    await expect(page.locator('.native-thumbnail-drawer')).toHaveCount(0);
    await expect.poll(apart).toBe('apart');
    // キャンバスの右下の隅は重ね表示（キャンバスの操作）が受ける。押すとその四角が選ばれる。
    // 引き出しを閉じた直後は倍率を測り直している途中のことがあるので、位置を測り直しながら確かめる。
    let corner = await canvasToScreen(page, 1260, 700);
    await expect(async () => {
      corner = await canvasToScreen(page, 1260, 700);
      const hit = await page.evaluate(({ x, y }) => { const element = document.elementFromPoint(x, y); return element?.closest('.native-thumbnail-overlay') ? 'overlay' : `${element?.tagName}.${element?.className}`; }, corner);
      expect(hit).toBe('overlay');
    }).toPass({ timeout: 10_000 });
    await page.mouse.click(corner.x, corner.y);
    await expect(page.locator('[data-handle="corner-br"]')).toBeVisible();
    // 閉じたら、下の帯の「スマホでの見え方」で出し直せる。
    await panel.getByRole('button', { name: 'スマホでの見え方を閉じる' }).click();
    await expect(panel).toHaveCount(0);
    const toggle = page.locator('.native-thumbnail-bottom').getByRole('button', { name: 'スマホでの見え方', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect.poll(apart).toBe('apart');
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
