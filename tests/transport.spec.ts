import { test, expect } from '@playwright/test';
import { openEditor, useTempProject } from './helpers';

/**
 * トランスポート操作（←→ コマ送り・JKL）と、アンカー固定ズームの回帰テスト。
 * ズームで「今いる場所」が画面外へ飛ばないこと＝この機能の本体なので、
 * 再生ヘッドの画面 X がズーム前後でほぼ動かないことを固定する。
 */

// 共有 sample-project は smoke / heavy-job-confirm の afterEach が git checkout/clean で
// 巻き戻すため、その窓に重なると読み込みが壊れる（helpers.ts の useTempProject 参照）。
// このファイルは保存を伴わない読み取り専用の検証なので、専用コピーへ隔離するだけで足りる。
const projectId = useTempProject('transport-tmp');

test('←→ でコマ送りでき、Shift＋→ は 1 秒進む', async ({ page }) => {
  await openEditor(page, projectId());

  // ルーラーをクリックして頭出し（つまみ非選択の状態を作る）。
  const ruler = page.locator('.tl-ruler');
  const rbox = await ruler.boundingBox();
  expect(rbox).not.toBeNull();
  await page.mouse.click(rbox!.x + 178, rbox!.y + rbox!.height / 2);

  // 既定ズームは 1 フレーム＝1px。10 コマ進めればヘッドは約 10px 右へ動く。
  // シークはプレイヤーの frameupdate 経由で反映されるので、動き切るまで待ってから測る。
  const head = page.locator('.tl-playhead');
  await expect.poll(async () => (await head.boundingBox())!.x).toBeGreaterThan(150);
  const start = (await head.boundingBox())!.x;

  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await head.boundingBox())!.x).toBeGreaterThan(start + 5);
  const forward = (await head.boundingBox())!.x;
  expect(forward - start).toBeGreaterThan(5);

  // 同じ回数戻せば元の位置（往復が対称）。
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Math.abs((await head.boundingBox())!.x - start)).toBeLessThan(2);

  // Shift＋→ は 1 秒ぶん＝10 コマよりさらに大きく進む。
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await head.boundingBox())!.x - start).toBeGreaterThan(forward - start);
});

test('L で早送り・K で停止（速度バッジが出て消える）', async ({ page }) => {
  await openEditor(page, projectId());

  const badge = page.locator('.tl-rate-badge');
  await expect(badge).toHaveCount(0);

  // L 2 回 → 2 倍速。
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  await expect(badge).toHaveText('▶▶ 2x');

  // K → 停止し等速へ戻る＝バッジが消える。
  await page.keyboard.press('k');
  await expect(badge).toHaveCount(0);
});

test('ズームしても再生ヘッドは画面上の同じ位置に留まる', async ({ page }) => {
  await openEditor(page, projectId());

  // まず十分に拡大し、さらに横スクロールした状態を作る（先頭付近・スクロール不能な幅では
  // そもそもアンカーを固定しようがなく、この機能の対象外）。上限 12px/frame でクランプ。
  const zoomIn = page.locator('.tl-zoom button', { hasText: '＋' });
  const zoomOut = page.locator('.tl-zoom button', { hasText: '−' });
  for (let i = 0; i < 4; i++) await zoomIn.click();
  const body = page.locator('.tl-body');
  await body.evaluate((el) => { el.scrollLeft = 2000; });

  // 可視域の中ほどへ頭出しする（拡縮で飛びやすい位置）。
  const ruler = page.locator('.tl-ruler');
  const bbox = (await body.boundingBox())!;
  const rbox = await ruler.boundingBox();
  await page.mouse.click(bbox.x + 300, rbox!.y + rbox!.height / 2);

  const head = page.locator('.tl-playhead');
  await expect.poll(async () => (await head.boundingBox())!.x).toBeGreaterThan(bbox.x + 100);
  const before = (await head.boundingBox())!.x;

  // ズームアウト（÷2）→ ヘッドの画面 X はほぼ不動。
  await zoomOut.click();
  expect(Math.abs((await head.boundingBox())!.x - before)).toBeLessThan(4);

  // ズームインで戻しても同じ位置。
  await zoomIn.click();
  expect(Math.abs((await head.boundingBox())!.x - before)).toBeLessThan(4);
});
