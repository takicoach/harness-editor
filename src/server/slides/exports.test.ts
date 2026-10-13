import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureShot } from '../sequence/exportRunner';
import { slidesFixture } from '../../core/slides/fixtures';
import type { SlidesCapture } from './capture';
import { SlidesExports } from './exports';
import type { SlidesPdfInput, SlidesPdfRenderer } from './pdf';
import { createSlidesProject } from './projects';
import { SlidesRenderInputs } from './renderInputs';
import { SlidesService } from './service';
import { SlidesStore } from './store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'slides-exports-')); roots.push(root);
  const { id } = createSlidesProject(root, '講義'), directory = join(root, id), service = new SlidesService();
  new SlidesStore(directory).save({ expectedSavedRevision: 0, executionId: 'seed', document: { ...slidesFixture(), revision: 1 } });
  return { directory, service, folder: join(directory, '書き出し') };
}
function fakes() {
  const shots: CaptureShot[] = [], pdfs: SlidesPdfInput[] = [];
  const capture: SlidesCapture = async (_target, count, shot, onPage) => { shots.push(shot); for (let i = 0; i < count; i++) await onPage(i, Buffer.from(`${shot.format}-${i}`)); };
  const pdf: SlidesPdfRenderer = async input => { pdfs.push(input); return Buffer.from('%PDF-fake'); };
  return { shots, pdfs, exports: new SlidesExports(capture, pdf, new SlidesRenderInputs()) };
}
const start = (exports: SlidesExports, directory: string, service: SlidesService, executionId: string, format: 'png' | 'pdf' | 'pdf-notes') => {
  const state = service.open(directory);
  return exports.start({ directory, projectId: '講義', origin: 'http://127.0.0.1:1', state: () => service.open(directory),
    request: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId, format } });
};

describe('SlidesExports', () => {
  it('PNG 一式を <スライド名>_001.png … で書き出し、ページが減ったら超えた番号だけ消す', async () => {
    const { directory, service, folder } = setup(), { exports } = fakes();
    start(exports, directory, service, 'png-1', 'png');
    expect(await exports.wait(directory, 'png-1')).toMatchObject({ phase: 'complete', pages: 2, done: 2, files: ['書き出し/講義_001.png', '書き出し/講義_002.png'] });
    expect(readFileSync(join(folder, '講義_002.png'), 'utf8')).toBe('png-1');
    writeFileSync(join(folder, '講義_003.png'), 'old'); writeFileSync(join(folder, 'メモ.txt'), 'keep');
    const state = service.open(directory);
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'del', command: { type: 'delete-pages', pageIds: ['page-2'] } });
    start(exports, directory, service, 'png-2', 'png');
    expect((await exports.wait(directory, 'png-2')).files).toEqual(['書き出し/講義_001.png']);
    expect([existsSync(join(folder, '講義_002.png')), existsSync(join(folder, '講義_003.png')), existsSync(join(folder, 'メモ.txt'))]).toEqual([false, false, true]);
  });
  it('表示用 PDF はメモを含めず、メモ付き PDF はメモを渡す。PDF の画像は JPEG 品質 90 で撮る', async () => {
    const { directory, service, folder } = setup(), { exports, shots, pdfs } = fakes();
    const state = service.open(directory);
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'note', command: { type: 'set-notes', pageId: 'page-1', notes: 'こんにちは' } });
    start(exports, directory, service, 'pdf-1', 'pdf');
    expect((await exports.wait(directory, 'pdf-1')).files).toEqual(['書き出し/講義.pdf']);
    start(exports, directory, service, 'pdf-2', 'pdf-notes');
    expect((await exports.wait(directory, 'pdf-2')).files).toEqual(['書き出し/講義_メモ付き.pdf']);
    expect(shots).toEqual([{ format: 'jpeg', quality: 90 }, { format: 'jpeg', quality: 90 }]);
    expect(pdfs.map(input => [input.images.map(image => image.toString()), input.notes])).toEqual([[['jpeg-0', 'jpeg-1'], null], [['jpeg-0', 'jpeg-1'], ['こんにちは', '']]]);
    expect(readFileSync(join(folder, '講義.pdf'), 'utf8')).toBe('%PDF-fake');
  });
  it('PNG 一式は全部を書きそろえてから公開する。途中で失敗しても前の一式はそのままで、一時フォルダーも残らない', async () => {
    const { directory, service, folder } = setup();
    mkdirSync(folder); writeFileSync(join(folder, '講義_001.png'), 'old-1'); writeFileSync(join(folder, '講義_002.png'), 'old-2');
    // 2 ページ目が撮れなかった（途中の失敗）。
    const capture: SlidesCapture = async (_target, _count, _shot, onPage) => { await onPage(0, Buffer.from('new-1')); };
    const exports = new SlidesExports(capture, async () => Buffer.from('%PDF'), new SlidesRenderInputs());
    start(exports, directory, service, 'png-broken', 'png');
    expect(await exports.wait(directory, 'png-broken')).toMatchObject({ phase: 'failed' });
    expect(['講義_001.png', '講義_002.png'].map(name => readFileSync(join(folder, name), 'utf8'))).toEqual(['old-1', 'old-2']);
    expect(readdirSync(folder).sort()).toEqual(['講義_001.png', '講義_002.png']);
  });
  it('取消は公開の前まで効く。公開を始めた後の取消は「取り消せません」と返し、書き出しは最後まで終える', async () => {
    for (const cancelAt of [1, 2]) {
      const { directory, service, folder } = setup(), errors: string[] = [];
      mkdirSync(folder); writeFileSync(join(folder, '講義_001.png'), 'old-1');
      let composing = 0, exports: SlidesExports | undefined;
      const capture: SlidesCapture = async (_target, count, shot, onPage) => { for (let i = 0; i < count; i++) await onPage(i, Buffer.from(`${shot.format}-${i}`)); };
      // 1 回目の composing はまとめ始め（取り消せる）、2 回目は公開の始まり（取り消せない）。
      exports = new SlidesExports(capture, async () => Buffer.from('%PDF'), new SlidesRenderInputs(), (_directory, event) => {
        if (event.type !== 'export' || event.phase !== 'composing' || ++composing !== cancelAt) return;
        try { exports!.cancel(directory, `png-cancel-${cancelAt}`); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      });
      start(exports, directory, service, `png-cancel-${cancelAt}`, 'png');
      const status = await exports.wait(directory, `png-cancel-${cancelAt}`);
      if (cancelAt === 1) {
        expect([status.phase, errors]).toEqual(['cancelled', []]);
        expect(readdirSync(folder)).toEqual(['講義_001.png']);
        expect(readFileSync(join(folder, '講義_001.png'), 'utf8')).toBe('old-1');
      } else {
        expect(status.phase).toBe('complete');
        expect(errors).toEqual([expect.stringContaining('取り消せません')]);
        expect(readdirSync(folder).sort()).toEqual(['講義_001.png', '講義_002.png']);
        expect(readFileSync(join(folder, '講義_001.png'), 'utf8')).toBe('png-0');
      }
    }
  });
  it('実行中の書き出しの数を重い処理の枠に知らせる（activeCount）', async () => {
    const { directory, service } = setup();
    let finish = () => {}, markStarted = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const capture: SlidesCapture = async (_target, count, _shot, onPage) => {
      await new Promise<void>(resolve => { finish = resolve; markStarted(); });
      for (let i = 0; i < count; i++) await onPage(i, Buffer.from('x'));
    };
    const exports = new SlidesExports(capture, async () => Buffer.from('%PDF'), new SlidesRenderInputs());
    expect(exports.activeCount()).toBe(0);
    start(exports, directory, service, 'busy', 'png');
    await started;
    expect(exports.activeCount()).toBe(1);
    finish(); await exports.wait(directory, 'busy');
    expect(exports.activeCount()).toBe(0);
  });
  it('案件ごとに同時 1 件。版が変わっていたら断る。同じ実行 ID は同じ状態を返す。ページが無ければ断る', async () => {
    const { directory, service } = setup();
    let finish = () => {}, markStarted = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const capture: SlidesCapture = async (_target, count, _shot, onPage) => {
      await new Promise<void>(resolve => { finish = resolve; markStarted(); });
      for (let i = 0; i < count; i++) await onPage(i, Buffer.from('x'));
    };
    const exports = new SlidesExports(capture, async () => Buffer.from('%PDF'), new SlidesRenderInputs());
    const first = start(exports, directory, service, 'a', 'png');
    expect(() => start(exports, directory, service, 'b', 'png')).toThrow('別の書き出しを実行中です');
    expect(start(exports, directory, service, 'a', 'png').jobId).toBe(first.jobId);
    await started; finish(); await exports.wait(directory, 'a');
    const state = service.open(directory);
    expect(() => exports.start({ directory, projectId: '講義', origin: 'http://x', state: () => service.open(directory),
      request: { sessionId: state.sessionId, expectedRevision: state.document.revision + 5, executionId: 'c', format: 'png' } })).toThrow('編集内容が変わりました');
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'clear', command: { type: 'delete-pages', pageIds: ['page-1', 'page-2'] } });
    expect(() => start(exports, directory, service, 'd', 'png')).toThrow('ページがありません');
  });
});
