import { expect, test, type Page } from '@playwright/test';
import { removeTempProject } from './helpers';
import { openNativeAi } from './aiTabHelpers';
import { createThumbnailProject } from './thumbnailHelpers';

// OSS 利用者報告（2026-11-04）: AI タブの端末で Mac の日本語入力を使うと、支離滅裂な文字が入力される。
// 原因: AI パネルの入力欄向けの max-width:100% が xterm の隠し入力欄（幅の基準が 0 の箱の中）にも当たって幅が 0 に潰れ、
// 変換を確定するたびに入力欄の中のカーソルが先頭へ戻っていた。xterm は「確定した文字は末尾に足される」前提で切り出すため、
// 2 語目から前の語の断片（「日本語」の次に「です」と打つと「本語」）が送られていた。
// 実ブラウザの IME の流れ（キーは keyCode 229、変換中の文字の更新、確定）を Chrome の入力の口から送って確かめる。
async function typeWithIme(page: Page, steps: string[], commit: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const key = (type: 'rawKeyDown' | 'keyUp', code: number, name: string) =>
    cdp.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: name });
  for (const text of steps) {
    await key('rawKeyDown', 229, 'Process');
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await key('keyUp', 65, 'a');
  }
  await key('rawKeyDown', 229, 'Process');
  await cdp.send('Input.insertText', { text: commit });
  await key('keyUp', 13, 'Enter');
  await cdp.detach();
}

test('AI タブの端末: 日本語入力で続けて確定した語が、そのまま端末へ送られる', async ({ page }) => {
  const project = createThumbnailProject('e2e-ai-ime');
  const sent: string[] = [];
  page.on('websocket', ws => ws.on('framesent', frame => {
    if (typeof frame.payload !== 'string' || !frame.payload.startsWith('{')) return;
    const message = JSON.parse(frame.payload) as { type?: string; data?: string };
    if (message.type === 'input' && typeof message.data === 'string') sent.push(message.data);
  }));
  try {
    const term = await openNativeAi(page, project.id);
    await term.click();
    await typeWithIme(page, ['n', 'に', 'にほ', 'にほんご', '日本語'], '日本語');
    await typeWithIme(page, ['d', 'で', 'です'], 'です');
    await typeWithIme(page, ['k', 'か', '蚊'], '蚊');
    // 送る回の区切りは xterm 次第（続けて確定すると 1 回にまとまることがある）なので、届いた文字の並びで見る。
    await expect.poll(() => sent.filter(data => !data.startsWith('\x1b')).join('')).toBe('日本語です蚊');
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
