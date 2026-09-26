import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, openEditor, useTempProject } from './helpers';

// F-1 キーフレームアニメの e2e。UI から「打つ・動かす・消す」ができ、telopData.ts へ keys が
// 書き出され、再読込で保持されることを確認する。
//
// 共有 sample-project は使わない（テストごとの専用コピーで走る）。保存を伴う spec が共有
// フィクスチャを afterEach で `git checkout --` / `git clean -fdx` すると、同時に走る別 spec が
// 生成物の消えた瞬間を読む（helpers.ts の createTempProject 参照。実測: フルスイートが回ごとに
// 別ファイルで赤くなる）。対象をずらせば原理的に起こらない。
const projectId = useTempProject('keyframes-tmp');

function telopDataPath(): string {
  return join(FIXTURES_ROOT, projectId(), 'src', 'テロップテンプレート', 'telopData.ts');
}

async function openSample(page: import('@playwright/test').Page): Promise<void> {
  await openEditor(page, projectId());
  await page.locator('.tx-row').first().click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
}

test('テロップのキーフレームを打つ・動かす・消す→保存→再読込で保持される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openSample(page);

  const presetSelect = page.locator('#ins-telop-motion-preset');
  await expect(presetSelect).toBeVisible();
  await presetSelect.selectOption('keyframes');

  // 切り替えた時点で開始/終了の 2 点ができる。
  const keys = page.locator('.ins-motion-key');
  await expect(keys).toHaveCount(2);

  // 打つ → 3 点。
  await page.getByRole('button', { name: 'キーフレームを打つ' }).click();
  await expect(keys).toHaveCount(3);

  // 動かす（2 番目の時間スライダー）。
  const timeSlider = page.getByLabel('2 番目のキーフレームの時間');
  await timeSlider.fill('0.8');
  await expect(page.locator('.ins-motion-key-title').nth(1)).toContainText('80%');

  // 値を変える（1 番目の大きさ）。
  await page.getByLabel('1 番目のキーフレームの大きさ').fill('1.5');

  // 消す（3 番目）→ 2 点。
  await page.getByRole('button', { name: '3 番目のキーフレームを削除' }).click();
  await expect(keys).toHaveCount(2);

  // 保存 → telopData.ts に keys が書き出される。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  const saved = readFileSync(telopDataPath(), 'utf8');
  expect(saved).toContain('preset: "keyframes"');
  expect(saved).toContain('keys: [');

  // 再読込で保持される。
  await page.reload();
  await openSample(page);
  await expect(page.locator('#ins-telop-motion-preset')).toHaveValue('keyframes');
  await expect(page.locator('.ins-motion-key')).toHaveCount(2);

  expect(pageErrors).toEqual([]);
});

test('部品が旧版の案件では、書き出しに反映されない旨が UI に出る（黙って食い違わせない）', async ({ page }) => {
  await openSample(page);
  await page.locator('#ins-telop-motion-preset').selectOption('keyframes');
  // フィクスチャは旧版のテロップ部品（目印なし）＝キーは書き出しに出ない案件。
  const note = page.locator('.ins-motion-keys [role="note"]');
  await expect(note).toBeVisible();
  await expect(note).toContainText('書き出しに反映されません');
});

test('時間スライダーで他のキーを追い越しても、掴んだキーが入れ替わらない', async ({ page }) => {
  await openSample(page);
  await page.locator('#ins-telop-motion-preset').selectOption('keyframes');
  const keys = page.locator('.ins-motion-key');
  await expect(keys).toHaveCount(2);
  await page.getByRole('button', { name: 'キーフレームを打つ' }).click();
  await expect(keys).toHaveCount(3);

  // 3 番目（いちばん後ろのキー）に目印の大きさを付ける。
  await page.getByLabel('3 番目のキーフレームの大きさ').fill('2.5');

  // 2 番目（50%）を追い越して 20% へ。表示は時間順なので目印のキーは 2 番目へ移る。
  await page.getByLabel('3 番目のキーフレームの時間').fill('0.2');
  await expect(page.locator('.ins-motion-key-title').nth(1)).toContainText('20%');
  await expect(page.getByLabel('2 番目のキーフレームの大きさ')).toHaveValue('2.5');

  // 続きを動かしても、動くのは同じ（目印の）キー。追い越された 50% のキーは動かない。
  await page.getByLabel('2 番目のキーフレームの時間').fill('0.1');
  await expect(page.locator('.ins-motion-key-title').nth(1)).toContainText('10%');
  await expect(page.getByLabel('2 番目のキーフレームの大きさ')).toHaveValue('2.5');
  await expect(page.locator('.ins-motion-key-title').nth(2)).toContainText('50%');
});
