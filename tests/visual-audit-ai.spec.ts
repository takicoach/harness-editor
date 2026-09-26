import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { createTempProject, removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { MAX_THUMBS, STRIP_THUMB_PX } from '../src/app/timeline/useFilmstrip';

/**
 * G-4 ビジュアル検品のうち **AI タブだけ**を分けた spec。
 *
 * AI タブを開くと AiTerminal がマウントされ /api/pty/ensure → WS 接続まで走る。pty は
 * サーバー側グローバルシングルトンで「書き込み接続は常に1本」（後から繋いだ方が takeover）
 * のため、AI タブを開く spec を default project（複数 worker 並列）に置くと
 * claude-terminal.spec.ts の writer を奪ってフレークさせる（playwright.config.ts のコメント
 * 参照）。よってこのファイルは ai-tab-pty project（workers:1）に置く。
 *
 * プロジェクト自体は使い捨てコピーを開く。pty は projectId 単位ではなく1本きりなので
 * コピーでも検証内容は変わらない一方、共有フィクスチャ sample-project を開くと、開いた
 * プロジェクトへの sidecar 生成が **他 worker の watchProject に外部更新として見える**
 * （smoke.spec.ts「自分の保存は外部更新バナーを誘発しない」が拾う）。対象をずらせば起きない。
 */

// 出力先は既定で .aaa-shots/G-4（追跡しない）。証拠を更新する時だけ
// `npm run shots:evidence`（AAA_UPDATE_EVIDENCE=1）で docs/reports 側へ書く。
const OUT_DIR = shotDir('G-4');

const PRESETS = ['standard', 'tall-dock', 'subtitle'] as const;
const THEMES = ['light', 'dark'] as const;

test.use({ viewport: { width: 1600, height: 1000 } });

let projectId = '';
let projectDir = '';

test.beforeEach(() => {
  ({ id: projectId, dir: projectDir } = createTempProject('visual-audit-ai-tmp'));
});

test.afterEach(async ({ page }) => {
  await page.close();
  removeTempProject(projectDir);
});

for (const preset of PRESETS) {
  for (const theme of THEMES) {
    test(`G-4 AI タブ: ${preset} / ${theme}`, async ({ page }) => {
      await page.addInitScript(
        ([t, l]) => {
          localStorage.setItem('sme-theme', t as string);
          localStorage.setItem('sme-layout', l as string);
          localStorage.setItem('sme-folder-open', 'open');
        },
        [theme, preset],
      );

      await page.goto('/');
      const card = page.locator('.home-card', { hasText: projectId });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.click();
      await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

      await page.locator('.rightdock-tab[data-tab="ai"]').click();

      // 存在検査: ターミナルのコンテナが実在し、xterm の描画面（canvas か行 DOM）が
      // 面積を持っている。空の黒い箱を「破綻なし」と言わないため。
      const term = page.locator('.rightdock-body .clt');
      await expect(term).toBeVisible({ timeout: 15_000 });
      const box = await term.boundingBox();
      expect(box, 'AI ターミナルに矩形が無い').not.toBeNull();
      expect(box!.width).toBeGreaterThan(200);
      expect(box!.height).toBeGreaterThan(100);
      // 偽 claude（tests/fixtures/fake-claude.mjs）の出力がターミナルに届くまで待つ。
      await expect(term.locator('.xterm-screen, canvas').first()).toBeVisible({ timeout: 15_000 });

      // G-4 実測の破綻: ターミナルの文字が枠に密着し、border-radius:10px の角丸で
      // 1 行目の先頭文字が削られていた（"FAKE-CLAUDE" の F が欠ける）。
      // 併せて、枠の地色がダーク固定（#101418）だったため、余白を入れるとライトテーマで
      // 白い端末のまわりに黒い額縁が出る。枠の地色は端末の配色（shared/terminalColors.ts）に揃える。
      const frame = await page.evaluate(() => {
        const host = document.querySelector('.rightdock-body .clt-term') as HTMLElement;
        const screen = document.querySelector('.rightdock-body .xterm-screen') as HTMLElement;
        const h = host.getBoundingClientRect();
        const s = screen.getBoundingClientRect();
        return { padLeft: s.left - h.left, padTop: s.top - h.top, bg: getComputedStyle(host).backgroundColor };
      });
      expect(frame.padLeft, '端末の文字が枠に密着している（角丸で先頭文字が削られる）').toBeGreaterThanOrEqual(4);
      expect(frame.padTop, '端末の文字が枠上端に密着している').toBeGreaterThanOrEqual(4);
      expect(frame.bg, '端末の枠の地色が端末の配色と違う（余白が額縁として浮く）').toBe(
        theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(16, 20, 24)',
      );

      // 存在検査（H-3(d)）: このショットは**全画面**を撮る。AI タブ（右ドック）だけ検査して
      // 撮ると、まだクリップが描かれていないタイムラインが一緒に写り、「破綻なし」に見えて
      // しまう（実測: docs/reports/aaa-screenshots/G-4/standard-light-inspector-ai.png は
      // 動画トラックが空のまま撮れていた）。空の画面はいつでも綺麗なので、写る側の主要素も
      // 実在を確かめてから撮る（visual-audit.spec.ts のタイムライン検査と同じ基準）。
      await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible();
      expect(await page.locator('.tl-track').count(), 'タイムラインのトラックが無い').toBeGreaterThanOrEqual(3);
      expect(await page.locator('.tl-telop').count(), 'じまくクリップが1つも無い').toBeGreaterThanOrEqual(1);
      // 動画トラックのフィルムストリップ（＝サムネ）が**全部**描き終わってから撮る。
      // useFilmstrip は 1 枚ずつ逐次 seek するため、1 枚見えた時点で撮ると描画途中の
      // 歯抜けが写る（実測: 検査を入れた直後の初回ランは 1/12 枚で撮ろうとしていた）。
      // 期待枚数は product 側の規則（幅 / STRIP_THUMB_PX、上限 MAX_THUMBS）で決まる。
      // 定数はテストに写さず product から import する — 写すと product 側を変えた瞬間に
      // 検査が「常に満たされる条件」へ黙って退化する（E-2）。
      await expect
        .poll(
          () =>
            page.evaluate(({ maxThumbs, thumbPx }) => {
              const base = document.querySelector('.tl-track-cut .tl-video-base');
              if (base === null) return 'no-video-track';
              const want = Math.min(maxThumbs, Math.floor(base.getBoundingClientRect().width / thumbPx));
              const got = document.querySelectorAll('.tl-filmstrip-thumb').length;
              return got >= want && want > 0 ? 'complete' : `${got}/${want}`;
            }, { maxThumbs: MAX_THUMBS, thumbPx: STRIP_THUMB_PX }),
          { timeout: 60_000, message: 'フィルムストリップが描き終わる前に撮ろうとしている' },
        )
        .toBe('complete');
      const pv = await page.locator('.pv-stage').boundingBox();
      expect(pv!.width).toBeGreaterThan(200);
      expect(pv!.height).toBeGreaterThan(150);

      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(over, `AI タブ(${preset}/${theme}) で横に ${over}px はみ出している`).toBeLessThanOrEqual(1);

      await page.screenshot({
        path: join(OUT_DIR, `${preset}-${theme}-inspector-ai.png`),
        animations: 'disabled',
      });
    });
  }
}
