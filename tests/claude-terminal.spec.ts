import { test, expect } from '@playwright/test';
import { TERMINAL_FONT_FAMILY } from '../src/app/panels/claudeTerminalOptions';

// 偽 claude（SME_CLAUDE_BIN、playwright.config.ts の webServer env で注入）で
// AI タブの埋め込みターミナルが起動しエコーが往復することを確認する。
test('AI タブ: 埋め込みターミナルが起動しエコーが往復する', async ({ page }) => {
  await page.goto('/');
  // 既存の claude-panel.spec.ts と同じ手順でプロジェクトを開き AI タブへ。
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage')).toBeVisible();
  await page.locator('.rightdock-tab[data-tab="ai"]').click();

  const term = page.getByTestId('claude-terminal');
  await expect(term).toBeVisible({ timeout: 15_000 });
  await expect(term).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });
  await term.click(); // フォーカス
  await page.keyboard.type('ping-123');
  await expect(term).toContainText('ping-123'); // エコーが返る＝入出力往復
});

// I-2 回帰: ホーム画面（プロジェクト未選択）で AiTerminal がマウントされ、
// AI タブを開く前・プロジェクトを選ぶ前から AI の導入確認や pty ensure が
// 走ってしまうバグ。修正前は App.tsx のフォールバック分岐が open.status に関わらず
// 常に <ClaudePanel embedded>（＝AiTerminal を含む）を描画していた。
test('ホーム画面（プロジェクト未選択）では AI の導入確認すら呼ばない（I-2 回帰）', async ({ page }) => {
  const aiOrPtyRequests: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/ai/') || url.includes('/api/pty/')) aiOrPtyRequests.push(url);
  });
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });
  // AiTerminal がマウントされていれば mount 直後に /api/ai/tools が飛ぶ。
  // 十分な猶予を置いても一件も飛んでいないことを確認する。
  await page.waitForTimeout(1500);
  expect(aiOrPtyRequests).toEqual([]);
});

// C-1 回帰: 旧 WebSocket の onclose が新接続の wsRef を潰し、restart 直後の入力が
// 黙って消えるバグ。修正前は「pty exit → 再起動」で新セッションに切り替わった直後、
// 旧 ws の遅延イベント（onclose 等）が wsRef.current を null に潰し、term.onData の
// send が `?.` で握り潰される（キー入力が届かない）。
test('AI タブ: pty exit → 再起動で新接続が生き残り、キー入力が消えない（C-1 回帰）', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage')).toBeVisible();
  await page.locator('.rightdock-tab[data-tab="ai"]').click();

  const term = page.getByTestId('claude-terminal');
  await expect(term).toBeVisible({ timeout: 15_000 });
  await expect(term).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });

  // 偽 claude を終了させる（入力に "exit" が来ると自死するよう拡張済み）。pty は既定で
  // canonical モード（行バッファリング）のため、Enter を押すまで偽 claude 側の
  // 'data' イベントには渡らない（打った文字はカーネル側の pty echo で画面には出る）。
  await term.click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');

  // pty exit → phase=exited の再起動導線。
  await expect(page.locator('.clt-exit')).toContainText('Claude が終了しました', { timeout: 15_000 });
  await page.locator('.clt-exit button', { hasText: '再起動する' }).click();

  // 新しい pty が立ち上がり、ターミナルが再び生きている。
  await expect(term).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });

  // C-1 本体: 新接続でキー入力が黙って消えていないか（旧 ws の遅延 onclose が wsRef を
  // 潰していると、ここでの送信が term.onData 内の `?.` で握り潰され、エコーが返らない）。
  await term.click();
  await page.keyboard.type('ping-after-restart');
  await expect(term).toContainText('ping-after-restart', { timeout: 15_000 });
});

test('AI タブ: 2 タブ目を開くと 1 タブ目に takeover 表示が出る', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage')).toBeVisible();
  await page.locator('.rightdock-tab[data-tab="ai"]').click();
  await expect(page.getByTestId('claude-terminal')).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });

  const page2 = await context.newPage();
  await page2.goto('/');
  await page2.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page2.locator('.pv-stage')).toBeVisible();
  await page2.locator('.rightdock-tab[data-tab="ai"]').click();
  await expect(page2.getByTestId('claude-terminal')).toBeVisible({ timeout: 15_000 });

  // pty の書き込み接続はエディタ全体で1本のため、2 タブ目の接続で 1 タブ目は
  // takeover 表示に切り替わる（フレークしやすいので expect.poll 相当の自動リトライ付き
  // toContainText を十分な timeout で待つ）。
  await expect(page.locator('.clt-exit')).toContainText('別のタブ', { timeout: 15_000 });
});

// フォント回帰: xterm の Terminal に fontFamily を指定しないと既定 'monospace' に
// フォールバックし、環境によって罫線・記号（─│▶⚠╭等）のグリフを持たないフォント
// （例: courier-new 系）に解決される。その場合ブラウザは文字ごとに別フォントへ
// フォールバックして描画するため、罫線と英数字で advance width が不揃いになり
// 「桁がずれる」（実測: 英数字7.20px前後に対し一部記号が12.00pxまで開く）。
//
// xterm 自身が文字幅計測に使う内部実装（CharSizeService の
// TextMetricsMeasureStrategy）の OffscreenCanvasRenderingContext2D.measureText を
// フックして、アプリが実際に Terminal へ渡した fontFamily を捕まえる。
// (1) その値が claudeTerminalOptions.ts の TERMINAL_FONT_FAMILY と一致することを確認する
//     （import で読むため文字列をテスト側で再定義しない＝二重管理にならない）。
//     これは配線そのものの検証: 手元の Chromium ではたまたま既定の generic 'monospace'
//     が実害の無いフォントへ解決されるため（実測: alnum 7.201px vs 罫線 7.225px、
//     差0.02px＝タスク記載の実測差5pxに遠く及ばない）、値の一致を見ずに幅だけ見ると
//     fontFamily 未指定へ後退しても検知できない。
// (2) 加えて実際の描画幅（英数字・罫線・記号）が全て一致することも確認する
//     （将来 TERMINAL_FONT_FAMILY を別の値に変えた際、値としては非空でも実際には
//     グリフ欠落でフォールバックする、というケースまで拾う保険）。
test('AI タブ: 端末フォントが等幅に統一され、罫線・記号で桁がずれない（フォント回帰）', async ({ page }) => {
  await page.addInitScript(() => {
    const capturedFonts: string[] = [];
    (window as Window & { __capturedFonts?: string[] }).__capturedFonts = capturedFonts;
    const proto = OffscreenCanvasRenderingContext2D.prototype;
    const original = proto.measureText;
    proto.measureText = function (this: OffscreenCanvasRenderingContext2D, text: string) {
      capturedFonts.push(this.font);
      return original.call(this, text);
    };
  });

  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage')).toBeVisible();
  await page.locator('.rightdock-tab[data-tab="ai"]').click();

  const term = page.getByTestId('claude-terminal');
  await expect(term).toBeVisible({ timeout: 15_000 });
  await expect(term).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });

  const { font, result } = await page.evaluate(() => {
    const fonts = (window as Window & { __capturedFonts?: string[] }).__capturedFonts ?? [];
    const capturedFont = fonts.at(-1);
    if (capturedFont === undefined) {
      throw new Error('xterm が OffscreenCanvasRenderingContext2D.measureText を使っていない（内部実装差異）');
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('2d context を取得できない');
    ctx.font = capturedFont;
    const chars = ['M', 'l', 'O', '─', '│', '▶', '⚠', '╭'];
    const widths: Record<string, number> = {};
    for (const c of chars) widths[c] = ctx.measureText(c).width;
    return { font: capturedFont, result: widths };
  });

  // (1) 配線の検証: アプリが実際に Terminal へ渡した値が TERMINAL_FONT_FAMILY と一致する。
  // ブラウザの CSS font シリアライズは "Consolas" のように空白を含まない family 名の
  // 引用符を落として返す（CSSOM の serialize-an-identifier 規則）ため、引用符の有無を
  // 無視して比較する（値そのものの一致は見ているので配線検証としては後退しない）。
  const normalize = (s: string) => s.replace(/"/g, '');
  expect(normalize(font)).toBe(normalize(`12px ${TERMINAL_FONT_FAMILY}`));

  // (2) 実測幅の検証: 等幅フォントなら単一コードポイント文字の advance width は全て同じになる。
  // フォールバック発生時の実測差（約5px）に対して十分小さい epsilon。
  const values = Object.values(result);
  const max = Math.max(...values);
  const min = Math.min(...values);
  expect(max - min, `widths=${JSON.stringify(result)}`).toBeLessThan(0.5);
});
