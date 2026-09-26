import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { canvasOpaquePixelRatio, createTempProject, removeTempProject } from './helpers';
import { shotDir } from './shotDir';

/**
 * G-4 ビジュアル検品用の撮影 spec（ライト/ダーク × レイアウトプリセット3種 × 主要画面）。
 *
 * 目的は「撮る」ことではなく「空でないことを確かめてから撮る」こと。空の画面はいつでも
 * 綺麗に見えるため、各ショットの直前に**存在検査**（その画面に出ているべき要素が実在し、
 * 幅・高さを持つか）を置く。加えて、横スクロールバーが生えていない（＝どこかがはみ出して
 * いない）ことを機械的に検査する。
 *
 * 共有フィクスチャ `sample-project` は触らない（他 spec の並列実行を壊すため。helpers.ts の
 * createTempProject の説明を参照）。
 */

// 出力先は既定で .aaa-shots/G-4（追跡しない）。証拠を更新する時だけ
// `npm run shots:evidence`（AAA_UPDATE_EVIDENCE=1）で docs/reports 側へ書く。
const OUT_DIR = shotDir('G-4');

const PRESETS = ['standard', 'tall-dock', 'subtitle'] as const;
const THEMES = ['light', 'dark'] as const;

// エディタの実使用に近い作業領域（既定 1280x720 は実機より狭く、はみ出しを過検出する）。
test.use({ viewport: { width: 1600, height: 1000 } });

let projectId = '';
let projectDir = '';

test.beforeEach(() => {
  ({ id: projectId, dir: projectDir } = createTempProject('visual-audit-tmp'));
});

test.afterEach(async ({ page, request }) => {
  // ページを先に閉じる（開いたままだとクライアント発の再取得が削除中のプロジェクトへ飛び、
  // サーバーが out/ を作り直して ENOTEMPTY になる）。
  await page.close();
  await request.delete(`/api/render?id=${projectId}`).catch(() => {});
  removeTempProject(projectDir);
});

/** 要素が実在し、面積を持つことを確かめる（存在検査）。 */
async function expectSolid(page: Page, selector: string, minWidth = 1, minHeight = 1): Promise<void> {
  const loc = page.locator(selector).first();
  await expect(loc, `${selector} が見えない`).toBeVisible({ timeout: 15_000 });
  const box = await loc.boundingBox();
  expect(box, `${selector} に矩形が無い`).not.toBeNull();
  expect(box!.width, `${selector} の幅が ${minWidth}px 未満`).toBeGreaterThanOrEqual(minWidth);
  expect(box!.height, `${selector} の高さが ${minHeight}px 未満`).toBeGreaterThanOrEqual(minHeight);
}

/**
 * ドキュメントに横スクロールが生えていないこと（＝どこかの要素が右へはみ出していない）。
 * 1px はブラウザの丸め差の許容。
 */
async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, `${where}: 横方向に ${over}px はみ出している`).toBeLessThanOrEqual(1);
}

/** 主要な固定ゾーンがビューポートの外へ出ていないこと（切れの検出）。 */
async function expectInsideViewport(page: Page, selector: string): Promise<void> {
  const r = await page.locator(selector).first().evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { right: b.right, bottom: b.bottom, w: window.innerWidth, h: window.innerHeight };
  });
  expect(r.right, `${selector} が右へ ${r.right - r.w}px はみ出している`).toBeLessThanOrEqual(r.w + 1);
  expect(r.bottom, `${selector} が下へ ${r.bottom - r.h}px はみ出している`).toBeLessThanOrEqual(r.h + 1);
}

test.describe('G-4 ビジュアル検品の撮影', () => {
  for (const preset of PRESETS) {
    for (const theme of THEMES) {
      test(`${preset} / ${theme}`, async ({ page }) => {
        test.setTimeout(180_000);

        const shot = async (name: string): Promise<void> => {
          await page.screenshot({
            path: join(OUT_DIR, `${preset}-${theme}-${name}.png`),
            animations: 'disabled',
          });
        };

        // テーマ／レイアウトはアプリ起動前の localStorage で決まる（index.html の初期化
        // スクリプトと App の loadLayout が読む）。
        await page.addInitScript(
          ([t, l]) => {
            localStorage.setItem('sme-theme', t as string);
            localStorage.setItem('sme-layout', l as string);
            localStorage.setItem('sme-folder-open', 'open');
          },
          [theme, preset],
        );

        // ---- ホーム ----
        await page.goto('/');
        const card = page.locator('.home-card', { hasText: projectId });
        await expect(card).toBeVisible({ timeout: 15_000 });
        // 存在検査: カードが1件以上・ツールバーの？ボタンが実在する。
        expect(await page.locator('.home-card').count()).toBeGreaterThan(0);
        await expectSolid(page, '.home-card', 100, 40);
        await expectSolid(page, '.tb-tutorial-btn', 10, 10);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        // 存在検査: サムネイルが実際に描かれるまで待つ（空のカードを撮って「綺麗」と言わない）。
        // VideoThumb は <video> のメタデータ→シーク→canvas 転写を経て <img> に置き換わるため、
        // 待たずに撮ると初回ランだけ灰色の空カードが写る（実測）。
        await expect(card.locator('img.ml-thumb-video-el')).toBeVisible({ timeout: 20_000 });
        await expectNoHorizontalOverflow(page, `home(${preset}/${theme})`);
        await shot('home');

        // ---- ヘルプ（チュートリアル図鑑）----
        await page.locator('.tb-tutorial-btn').click();
        const help = page.locator('[data-testid="help-dialog"]');
        await expect(help).toBeVisible();
        // 存在検査: 一覧に項目があり、詳細ペインに見出しと画像が出ている。
        expect(await help.locator('.help-item').count()).toBeGreaterThan(3);
        await expectSolid(page, '.help-detail-pane .help-cap', 10, 10);
        await expectSolid(page, '.help-detail-pane .help-img', 100, 60);
        await expectInsideViewport(page, '[data-testid="help-dialog"]');
        await shot('help');
        await page.keyboard.press('Escape');
        await expect(help).toHaveCount(0);

        // ---- タイムライン（プロジェクトを開く）----
        await card.click();
        await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
        // 存在検査: トラック・テロップクリップ・文字起こし行・プレビュー・タイムライン目盛。
        expect(await page.locator('.tl-track').count()).toBeGreaterThanOrEqual(3);
        expect(await page.locator('.tl-telop').count()).toBeGreaterThanOrEqual(1);
        expect(await page.locator('.tx-row').count()).toBeGreaterThanOrEqual(1);
        await expectSolid(page, '.pv-stage', 200, 150);
        await expectSolid(page, '.tl-ruler', 100, 5);
        await expectSolid(page, '.rightdock-tabs', 100, 20);
        await expectSolid(page, '.tl-telop', 2, 6);
        // 存在検査: 動画トラックのフィルムストリップが実際に読み込まれている
        // （空のトラックを撮ると「破綻なし」に見えるが、それは中身が無いだけ）。
        await expect(page.locator('.tl-filmstrip-thumb').first()).toBeVisible({ timeout: 20_000 });
        await expectNoHorizontalOverflow(page, `timeline(${preset}/${theme})`);
        await expectInsideViewport(page, '.tl-body');
        await expectInsideViewport(page, '.rightdock');
        await shot('timeline');

        // ---- 素材ライブラリ（左ドックの素材タブ）----
        await page.locator('.lc-tab[data-tab="materials"]').click();
        // 存在検査: 素材一覧に行が実在する（空の一覧を「綺麗」と言わない）。
        await expectSolid(page, '.lc-tabs', 60, 20);
        expect(await page.locator('.ml-row, .ml-cell').count()).toBeGreaterThanOrEqual(1);
        await expectSolid(page, '.ml-row, .ml-cell', 40, 16);
        // G-4 実測の破綻: 波形（固定 120px）が名前の列を食い潰し、`beep.mp3` が
        // clientWidth 31px / scrollWidth 57px＝「bee…」まで潰れていた。素材名は切れないこと。
        const nameFit = await page.locator('.ml-row-name').first().evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
          text: el.textContent ?? '',
        }));
        expect(
          nameFit.scroll,
          `素材名「${nameFit.text}」が ${nameFit.client}px に収まらず省略されている`,
        ).toBeLessThanOrEqual(nameFit.client + 1);
        // 存在検査: 行の波形 canvas に実際にピクセルが描かれている（空の canvas を
        // 「破綻なし」と読み違えない。波形が空でも DOM 上は canvas が在る）。
        const waveInk = await canvasOpaquePixelRatio(page.locator('canvas.ml-row-wave').first());
        expect(waveInk, '素材行の波形 canvas に何も描かれていない').toBeGreaterThan(0);
        await expectInsideViewport(page, '.lc');
        await shot('material-library');
        await page.locator('.lc-tab[data-tab="projects"]').click();

        // ---- Inspector: 文字起こしタブ（じまく選択）----
        await page.locator('.tx-row').first().click();
        await expect(page.locator('.rightdock-tab[data-tab="transcript"]')).toHaveClass(/active/);
        await expectSolid(page, '.rightdock-body .tx', 100, 100);
        await expect(page.locator('.tx-row.selected')).toBeVisible();
        await expectNoHorizontalOverflow(page, `transcript(${preset}/${theme})`);
        await shot('inspector-transcript');

        // ---- Inspector: 設定タブ（じまく）----
        await page.locator('.rightdock-tab[data-tab="settings"]').click();
        await expectSolid(page, '.rightdock-body .ins', 100, 100);
        await expect(page.locator('.rightdock-body .ins #ins-telop-manual')).toBeVisible();
        await expectNoHorizontalOverflow(page, `settings-telop(${preset}/${theme})`);
        await expectInsideViewport(page, '.rightdock-body .ins');
        // G-4 実測の破綻: subtitle プリセットで設定タブを開くと、右ドックの設定と subpanel に
        // 同じフォームが 2 つ出て id が重複していた（label[for] が先頭しか指さない）。
        const dupIds = await page.evaluate(() => {
          const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id).filter((id) => id !== '');
          return Array.from(new Set(ids.filter((id, i) => ids.indexOf(id) !== i)));
        });
        expect(dupIds, `文書内で id が重複している: ${dupIds.join(', ')}`).toEqual([]);
        await shot('inspector-settings-telop');

        // ---- Inspector: 設定タブ（効果音）----
        await page.locator('.tl-se-clip').first().click();
        await expect(page.locator('.rightdock-tab[data-tab="settings"]')).toHaveClass(/active/);
        await expect(page.locator('.rightdock-body .ins')).toContainText('効果音ファイル');
        expect(await page.locator('.rightdock-body .ins-section').count()).toBeGreaterThanOrEqual(3);
        await expectNoHorizontalOverflow(page, `settings-se(${preset}/${theme})`);
        await shot('inspector-settings-se');

        // ---- Inspector: 設定タブ（挿入画像）----
        await page.locator('.tl-image-block').first().click();
        await expect(page.locator('.rightdock-body .ins')).toContainText('画像ファイル');
        await expectNoHorizontalOverflow(page, `settings-image(${preset}/${theme})`);
        await shot('inspector-settings-image');

        // ---- Inspector: 設定タブ（メイン動画＝トラックヘッダ選択）----
        await page.locator('.tl-track-cut .tl-track-label-clickable').first().click();
        await expectSolid(page, '.rightdock-body .ins', 100, 100);
        await expectNoHorizontalOverflow(page, `settings-main(${preset}/${theme})`);
        await shot('inspector-settings-main');

        // ---- 書き出しダイアログ → 進捗 ----
        await page.locator('.tb-render-btn').click();
        const dialog = page.locator('[data-testid="export-dialog"]');
        await expect(dialog).toBeVisible();
        await expectInsideViewport(page, '[data-testid="export-dialog"]');
        await shot('export-dialog');
        await page.locator('[data-testid="export-start"]').click();
        await expect(dialog).toHaveCount(0);
        const running = page.locator('.tb-render-running');
        await expect(running).toBeVisible({ timeout: 15_000 });
        // 存在検査: 進捗リングと％ラベルが実在する（枠だけの進捗を「綺麗」と言わない）。
        await expectSolid(page, 'svg.cp-ring[role="progressbar"]', 10, 10);
        await expect(page.locator('.tb-render-running .tb-render-label')).toContainText(/\d+%/, {
          timeout: 10_000,
        });
        await expectInsideViewport(page, '.tb-render-running');
        await shot('export-progress');
        // 進捗のまま次へ進むと他の検査を揺らすのでキャンセルして idle へ戻す。
        await page.locator('.tb-render-running .tb-render-x').click();
        await expect(page.locator('.tb-render-btn')).toBeVisible({ timeout: 15_000 });

        // ---- 外部更新バナー ----
        // 一時プロジェクトの telopData.ts を「外部から」書き換える（chokidar → SSE）。
        const telopPath = join(projectDir, 'src', 'テロップテンプレート', 'telopData.ts');
        const { readFileSync, writeFileSync } = await import('node:fs');
        writeFileSync(telopPath, readFileSync(telopPath, 'utf8') + '\n// G-4 外部編集\n', 'utf8');
        const banner = page.locator('.ext-banner');
        await expect(banner).toBeVisible({ timeout: 10_000 });
        await expectSolid(page, '.ext-banner', 100, 20);
        await expectInsideViewport(page, '.ext-banner');
        // バナー表示中もプレビュー領域が潰れていないこと（グリッド退行の検知）。
        const pvBox = await page.locator('.pv-stage').boundingBox();
        expect(pvBox!.height, 'バナー表示でプレビューが潰れている').toBeGreaterThan(150);
        await expectNoHorizontalOverflow(page, `banner(${preset}/${theme})`);
        await shot('banner-external');
      });
    }
  }
});
