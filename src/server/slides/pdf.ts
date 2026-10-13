import { chromium, type Browser } from 'playwright-core';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const image = (index: number) => `<img src="/__slides-pdf/${index}.jpg" alt="">`;
/** 表示用（1920×1080 の紙に 1 ページ 1 枚・メモなし）とメモ付き（A4 縦に番号・画像・メモ）の HTML。画像は /__slides-pdf/<番号>.jpg で配る。 */
export function slidesPdfHtml(count: number, notes: readonly string[] | null): string {
  if (!notes) return '<!doctype html><html><head><meta charset="utf-8"><style>@page{size:1920px 1080px;margin:0}html,body{margin:0;padding:0;background:#fff}'
    + 'img{display:block;width:1920px;height:1080px;break-after:page}img:last-child{break-after:auto}</style></head><body>'
    + Array.from({ length: count }, (_, index) => image(index)).join('') + '</body></html>';
  return '<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:\'Slides Notes\';src:url(\'/fonts/noto-sans-jp-400.woff2\') format(\'woff2\')}'
    + '@page{size:A4;margin:14mm}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:\'Slides Notes\',\'Hiragino Sans\',sans-serif}'
    + 'section{break-after:page}section:last-child{break-after:auto}h2{margin:0 0 4mm;font-size:10pt;font-weight:400;color:#555}'
    + 'img{display:block;width:100%;aspect-ratio:16/9;border:1px solid #ccc}p{margin:5mm 0 0;font-size:11pt;line-height:1.7;white-space:pre-wrap}</style></head><body>'
    + notes.map((note, index) => `<section><h2>${index + 1} / ${notes.length}</h2>${image(index)}<p>${escapeHtml(note)}</p></section>`).join('') + '</body></html>';
}
/** page.pdf の期限。Playwright の page.pdf には期限の指定が無いので、時間切れでブラウザを閉じて止める。 */
export const SLIDES_PDF_TIMEOUT_MS = 60_000;
/** work が ms 以内に終わらなければ message で失敗する（work 自体は呼び出し側がブラウザを閉じて止める）。 */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export interface SlidesPdfInput { origin: string; signal: AbortSignal; images: readonly Buffer[]; notes: readonly string[] | null }
export type SlidesPdfRenderer = (input: SlidesPdfInput) => Promise<Buffer>;
/** 既存の撮影用 Chromium の page.pdf で作る（新しい依存は足さない）。スライドの中身は画像なので、PDF の中では編集・検索できない。 */
export const renderSlidesPdf: SlidesPdfRenderer = async input => {
  const bin = resolveNativeChromiumBin();
  if (!bin.ok) throw new Error(bin.message);
  input.signal.throwIfAborted();
  let browser: Browser | undefined;
  const abort = () => { void browser?.close().catch(() => undefined); };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    browser = await chromium.launch({ executablePath: bin.bin });
    // 起動中の取消は browser が無く閉じられないので、起動の直後に確かめる。
    input.signal.throwIfAborted();
    const page = await browser.newPage();
    await page.route(url => url.pathname.startsWith('/__slides-pdf/'), route => {
      const index = Number(new URL(route.request().url()).pathname.split('/').pop()!.replace(/\.jpg$/, '')), body = input.images[index];
      return body ? route.fulfill({ status: 200, contentType: 'image/jpeg', body }) : route.fulfill({ status: 404, body: '' });
    });
    // 同じ起点のページに中身を入れる（同梱の書体 /fonts/… を読めるように）。
    await page.goto(`${input.origin}/native-render.html?host=1`);
    await page.setContent(slidesPdfHtml(input.images.length, input.notes), { waitUntil: 'load' });
    await page.waitForFunction(() => Array.from(document.images).every(item => item.complete && item.naturalWidth > 0), undefined, { timeout: 60_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    input.signal.throwIfAborted();
    return await withDeadline(input.notes
      ? page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
      : page.pdf({ width: '1920px', height: '1080px', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }),
    SLIDES_PDF_TIMEOUT_MS, 'PDF の作成が時間内（60 秒）に終わりませんでした。ページ数を減らすか、もう一度書き出してください');
  } finally {
    input.signal.removeEventListener('abort', abort);
    await browser?.close().catch(() => undefined);
  }
};
