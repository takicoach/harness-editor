import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SLIDES_OUTLINE_SCHEMA } from '../src/core/slides/contract';
import { pageBody, scriptText } from '../src/core/slides/fixtures';
import { FIXTURES_ROOT, removeTempProject } from './helpers';
import { slidesShot, slidesState } from './slidesHelpers';

const OUTLINE = [
  { key: 's1', layout: 'cover', title: 'スイングの基本', sourceParagraphIds: ['p1'] },
  { key: 's2', layout: 'chapter', title: '握り方', sourceParagraphIds: ['p2'] },
  { key: 's3', layout: 'points', title: '握り方のコツ', sourceParagraphIds: ['p3', 'p4'] },
  { key: 's4', layout: 'compare', title: '良い例と悪い例', sourceParagraphIds: ['p5'] },
  { key: 's5', layout: 'steps', title: '練習の順番', sourceParagraphIds: ['p6'] },
  { key: 's6', layout: 'image-text', title: '構えの形', sourceParagraphIds: ['p7', 'p8'] },
] as const;
/** 貼り付けの画面で、依頼文が出たのを確かめてから回答を貼り、確かめて採用する。 */
async function pasteAnswer(page: Page, opener: string, answer: unknown, adopt: string): Promise<void> {
  await page.getByRole('button', { name: opener }).click();
  const dialog = page.getByRole('dialog', { name: '貼り付けで頼む' });
  await expect(dialog.getByLabel('依頼文')).not.toHaveValue('');
  await dialog.getByLabel('AI の回答').fill(JSON.stringify(answer));
  await dialog.getByRole('button', { name: '確かめる' }).click();
  await dialog.getByRole('button', { name: adopt }).click();
  await expect(dialog).toHaveCount(0);
}
for (const theme of ['light', 'dark'] as const) {
  test(`ホームから作り、台本→構成案→本文を貼り付けで作って直し、PDF まで書き出す。幅 1280・1440 ではみ出さない（${theme}）`, async ({ page, request }) => {
    test.setTimeout(180_000);
    const name = `e2e-スライド受け入れ-${theme}-${Date.now()}`, dir = join(FIXTURES_ROOT, name);
    await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    try {
      await page.goto('/');
      const home = page.getByRole('region', { name: 'スライド' });
      await home.getByRole('button', { name: '＋ スライドを作る' }).click();
      await home.getByLabel('スライドの名前').fill(name);
      await home.getByRole('button', { name: '作る', exact: true }).click();
      await page.getByRole('navigation', { name: 'スライドの道具' }).getByRole('button', { name: '台本から作る' }).click();
      const drawer = page.getByRole('complementary', { name: '台本から作る' });
      await drawer.getByLabel('台本', { exact: true }).fill(scriptText(8));
      await drawer.getByRole('button', { name: '段落に分ける' }).click();
      await pasteAnswer(page, '構成案を貼り付けで頼む', { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: OUTLINE }, 'この構成案を使う');
      await expect(drawer.getByText('全段落 8 / 8 がどれかのページに入っています')).toBeVisible();
      await drawer.getByRole('button', { name: 'この構成で作る' }).click();
      await pasteAnswer(page, '次の 6 ページの本文を貼り付けで頼む', OUTLINE.map(entry => pageBody(entry.key, entry.layout)), '合格したページを採用');
      await expect(drawer.getByText('6 / 6 ページができました')).toBeVisible();
      await slidesShot(page, `b15-generated-${theme}`);
      // 手直し（話すメモ）。AI が作ったページに「手直し」の印が付く。
      await page.getByLabel('話すメモ').fill('ここで会場に質問する');
      await expect.poll(async () => (await slidesState(request, name)).document.pages[0]!.editedAfterGeneration).toBe(true);
      await expect(page.getByRole('region', { name: 'ページの帯' }).getByText('手直し')).toBeVisible();
      // 書き出しは保存前の直しも含めて描く（セッションの今の版）。保存は自動保存に任せる。
      await page.getByRole('button', { name: 'PDF', exact: true }).click();
      const exportDialog = page.getByRole('dialog', { name: '書き出し' });
      await exportDialog.getByRole('button', { name: '書き出す' }).click();
      await expect(exportDialog.getByRole('status')).toHaveText('書き出しました', { timeout: 120_000 });
      expect(readdirSync(join(dir, '書き出し')).filter(file => file.endsWith('.pdf'))).toHaveLength(1);
      await slidesShot(page, `b15-pdf-${theme}`);
      await exportDialog.getByRole('button', { name: '閉じる' }).click();
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await slidesShot(page, `b15-${width}-${theme}`);
      }
    } finally { await page.goto('about:blank'); removeTempProject(dir); }
  });
}
