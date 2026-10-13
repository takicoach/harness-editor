import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeRgba, startEditorServer } from '../../../scripts/native-render-capture';
import { applySlideCommand } from '../../core/slides/commands';
import { slidesFixture } from '../../core/slides/fixtures';
import { SLIDE_THEMES } from '../../core/slides/themes';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import type { SlidesExportStatus } from './exports';
import { SlidesStore } from './store';

const available = resolveNativeChromiumBin().ok && resolveFfmpegBin().ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('スライドの書き出しの検証に Chromium と FFmpeg が必要です');
type RGB = readonly [number, number, number];
const TEXT = SLIDE_THEMES['forest-gold'].colors.text, rgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
function count(data: Uint8Array, channels: number, target: RGB, tolerance = 40): number {
  let total = 0;
  for (let i = 0; i + 2 < data.length; i += channels) if (Math.hypot(data[i]! - target[0], data[i + 1]! - target[1], data[i + 2]! - target[2]) < tolerance) total++;
  return total;
}
async function readPdf(bytes: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isOffscreenCanvasSupported: false, isImageDecoderSupported: false }).promise;
  const images: Array<{ width: number; height: number; data: Uint8Array; channels: number }> = [], texts: string[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), ops = await page.getOperatorList(), at = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
    if (at >= 0) {
      const image = await new Promise<{ width: number; height: number; data: Uint8Array; kind: number }>(resolve => page.objs.get(ops.argsArray[at]![0] as string, resolve));
      images.push({ width: image.width, height: image.height, data: image.data, channels: image.kind === 3 ? 4 : 3 });
    }
    texts.push((await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(''));
  }
  return { pages: pdf.numPages, images, texts };
}
let root = '', project = '', server: Awaited<ReturnType<typeof startEditorServer>> | undefined;
beforeAll(async () => {
  if (!available) return;
  root = mkdtempSync(join(tmpdir(), 'slides-export-')); project = join(root, 'export-case'); mkdirSync(project);
  let document = applySlideCommand(slidesFixture(), { type: 'add-page', pageId: 'page-3', layout: 'compare' });
  document = applySlideCommand(document, { type: 'set-notes', pageId: 'page-1', notes: 'メモのテスト' });
  new SlidesStore(project).save({ expectedSavedRevision: null, executionId: 'seed', document });
  server = await startEditorServer(process.cwd(), root);
}, 120_000);
afterAll(async () => { await server?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });
async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server!.origin}/api/slides${route}${route.includes('?') ? '&' : '?'}id=export-case`,
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(json)}`);
  return json as T;
}
async function exportAs(format: 'png' | 'pdf' | 'pdf-notes'): Promise<SlidesExportStatus> {
  const state = await api<{ sessionId: string; document: { revision: number } }>('/session', {}), executionId = crypto.randomUUID();
  let status = await api<SlidesExportStatus>('/export', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId, format });
  const deadline = Date.now() + 120_000;
  while (['checking', 'rendering', 'composing'].includes(status.phase)) {
    if (Date.now() > deadline) throw new Error('書き出しが終わりません');
    await new Promise(resolve => setTimeout(resolve, 250));
    status = await api(`/export/status?executionId=${executionId}`);
  }
  if (status.phase !== 'complete') throw new Error(`書き出しに失敗: ${status.error}`);
  return status;
}

describe.skipIf(!available)('スライドの書き出し（受け入れ 6）', () => {
  it('表示用 PDF のページ数が文書と一致し、各ページの画像に見出しの文字色の画素がある', async () => {
    const status = await exportAs('pdf');
    expect(status.files).toEqual(['書き出し/export-case.pdf']);
    const pdf = await readPdf(readFileSync(join(project, status.files![0]!)));
    expect([pdf.pages, pdf.images.length]).toEqual([3, 3]);
    for (const image of pdf.images) {
      expect([image.width, image.height]).toEqual([1920, 1080]);
      expect(count(image.data, image.channels, rgb(TEXT))).toBeGreaterThan(300);
      // 否定対照: 使っていない色は数えない（数え方が空振りしていない）。
      expect(count(image.data, image.channels, [255, 0, 255])).toBe(0);
    }
    expect(pdf.texts.join('')).not.toContain('メモのテスト');
  }, 180_000);
  it('PNG 一式は 3 枚で、どれにも見出しの文字色がある', async () => {
    const status = await exportAs('png');
    expect(status.files).toEqual(['書き出し/export-case_001.png', '書き出し/export-case_002.png', '書き出し/export-case_003.png']);
    for (const file of status.files!) expect(count(decodeRgba(readFileSync(join(project, file))), 4, rgb(TEXT))).toBeGreaterThan(300);
  }, 180_000);
  it('メモ付き PDF は、ページの画像のそばに話すメモを文字で持つ', async () => {
    const status = await exportAs('pdf-notes');
    const pdf = await readPdf(readFileSync(join(project, status.files![0]!)));
    expect(pdf.pages).toBeGreaterThanOrEqual(3);
    expect(pdf.texts[0]).toContain('メモのテスト');
  }, 180_000);
});
