import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { imageLayer, shapeLayer, textLayer, thumbnailFixture, videoFrameLayer } from '../../core/thumbnail/fixtures';
import type { ThumbnailDocument } from '../../core/thumbnail/model';
import type { CaptureShot } from '../sequence/exportRunner';
import type { ThumbnailCapture } from './capture';
import { thumbnailFileBase } from './cover';
import { publishThumbnail, ThumbnailExports, THUMBNAIL_MAX_BYTES, type ThumbnailExportRequest } from './exports';
import { ThumbnailRenderInputs } from './renderInputs';
import type { ThumbnailEvent, ThumbnailSessionState } from './service';

// rename だけを途中で失敗させられるようにする（公開途中の失敗で前のファイルが残ることを確かめる）。
const fault = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: (from: string, to: string) => fault.rename ? Promise.reject(new Error('置き換えに失敗')) : actual.rename(from, to) };
});
const directories: string[] = [];
afterEach(() => { fault.rename = false; for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function project(): string { const directory = mkdtempSync(join(tmpdir(), 'thumb-export-')); directories.push(directory); return directory; }
const stateOf = (document: ThumbnailDocument): ThumbnailSessionState => ({ sessionId: 's', document, savedRevision: document.revision, savedContentHash: 'h',
  canUndo: false, canRedo: false, dirty: false, pageHashes: {} });
const plain = (): ThumbnailDocument => { const document = thumbnailFixture(); document.pages[0]!.layers = [textLayer('t'), shapeLayer('s')]; return document; };
const request = (executionId: string, format: 'png' | 'jpeg' = 'png', expectedRevision = 0): ThumbnailExportRequest => ({ sessionId: 's', expectedRevision, executionId, pageId: 'page-a', format });
function fake(size: (shot: CaptureShot) => number) {
  const shots: CaptureShot[] = [];
  const capture: ThumbnailCapture = async (_target, plan, accept) => {
    let last: { bytes: Buffer; shot: CaptureShot } | undefined;
    for (const shot of plan) { shots.push(shot); const bytes = Buffer.alloc(size(shot), 1); last = { bytes, shot }; if (accept(bytes, shot)) return last; }
    return last!;
  };
  return { capture, shots };
}
function begin(exports: ThumbnailExports, directory: string, item: ThumbnailExportRequest, document = plain()) {
  return exports.start({ directory, projectId: 'p', origin: 'http://127.0.0.1:1', request: item, state: () => stateOf(document) });
}

describe('publishThumbnail の書き出し先', () => {
  it('フォルダーがリンクなら案件の外へ書かない', async () => {
    const directory = project(), outside = project();
    symlinkSync(outside, join(directory, 'サムネ'));
    await expect(publishThumbnail(join(directory, 'サムネ'), 'a', '.png', Buffer.from('x'))).rejects.toThrow('通常のフォルダー');
    expect(readdirSync(outside)).toEqual([]);
    const normal = join(directory, 'ok'); mkdirSync(normal);
    await expect(publishThumbnail(normal, 'a', '.png', Buffer.from('x'))).resolves.toBe('a.png');
  });
  it('同じ名前は上書きして 1 枚だけ残し、中身は新しい方になる', async () => {
    const folder = join(project(), 'サムネ');
    expect(await publishThumbnail(folder, 'サムネ_p', '.png', Buffer.from('old'))).toBe('サムネ_p.png');
    expect(await publishThumbnail(folder, 'サムネ_p', '.png', Buffer.from('new'))).toBe('サムネ_p.png');
    expect(readdirSync(folder)).toEqual(['サムネ_p.png']);
    expect(readFileSync(join(folder, 'サムネ_p.png'), 'utf8')).toBe('new');
  });
  it('PNG から JPEG に書き直すと、同じ名前の古い PNG を消す（逆も同じ）', async () => {
    const folder = join(project(), 'サムネ');
    await publishThumbnail(folder, 'サムネ_p', '.png', Buffer.from('png'));
    await publishThumbnail(folder, 'サムネ_p_案B', '.png', Buffer.from('other'));
    expect(await publishThumbnail(folder, 'サムネ_p', '.jpg', Buffer.from('jpg'))).toBe('サムネ_p.jpg');
    expect(readdirSync(folder).sort()).toEqual(['サムネ_p.jpg', 'サムネ_p_案B.png']);
    await publishThumbnail(folder, 'サムネ_p', '.png', Buffer.from('png2'));
    expect(readdirSync(folder).sort()).toEqual(['サムネ_p.png', 'サムネ_p_案B.png']);
  });
  it('置き換えの途中で失敗したら前のファイルと別の拡張子のファイルを残し、一時ファイルも残さない', async () => {
    const folder = join(project(), 'サムネ');
    await publishThumbnail(folder, 'サムネ_p', '.png', Buffer.from('before'));
    fault.rename = true;
    await expect(publishThumbnail(folder, 'サムネ_p', '.png', Buffer.from('after'))).rejects.toThrow('置き換えに失敗');
    await expect(publishThumbnail(folder, 'サムネ_p', '.jpg', Buffer.from('after'))).rejects.toThrow('置き換えに失敗');
    expect(readdirSync(folder)).toEqual(['サムネ_p.png']);
    expect(readFileSync(join(folder, 'サムネ_p.png'), 'utf8')).toBe('before');
  });
  it('同じ名前の場所にあるリンクは辿らずに置き換える（案件の外のファイルを書き換えない）', async () => {
    const folder = join(project(), 'サムネ'), outside = join(project(), 'outside.png');
    writeFileSync(outside, 'keep'); mkdirSync(folder); symlinkSync(outside, join(folder, 'サムネ_p.png'));
    await publishThumbnail(folder, 'サムネ_p', '.png', Buffer.from('new'));
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    expect(readFileSync(join(folder, 'サムネ_p.png'), 'utf8')).toBe('new');
  });
});
describe('thumbnailFileBase', () => {
  it('メインの案は <案件名> サムネ、それ以外は <案件名> サムネ <案の名前>', () => {
    expect(thumbnailFileBase('ゴルフ講座', '案A', true)).toBe('ゴルフ講座 サムネ');
    expect(thumbnailFileBase('ゴルフ講座', '案B', false)).toBe('ゴルフ講座 サムネ 案B');
  });
  it('禁止文字は置き換え、120 字に収める。長い案件名でもメインとそれ以外の名前は重ならない', () => {
    expect(thumbnailFileBase('a/b:c', 'x*y?', false)).toBe('a_b_c サムネ x_y_');
    const long = 'あ'.repeat(200), main = thumbnailFileBase(long, '案A', true), other = thumbnailFileBase(long, '案B', false);
    expect(main.length).toBeLessThanOrEqual(120);
    expect(other.length).toBeLessThanOrEqual(120);
    expect(other.startsWith(`${main} `)).toBe(true);
  });
});
describe('ThumbnailExports', () => {
  it('メインの案は <案件>/サムネ/<案件名> サムネ.png に書き、同じ名前は上書きして 1 枚だけ残す', async () => {
    let size = 1000;
    const directory = project(), events: ThumbnailEvent[] = [];
    const exports = new ThumbnailExports(fake(() => size).capture, new ThumbnailRenderInputs(), (_directory, event) => events.push(event));
    begin(exports, directory, request('e1'));
    expect(await exports.wait(directory, 'e1')).toMatchObject({ phase: 'complete', fileName: `サムネ/${basename(directory)} サムネ.png`, bytes: 1000, overLimit: false, main: true });
    size = 7;
    begin(exports, directory, request('e2'));
    expect((await exports.wait(directory, 'e2')).fileName).toBe(`サムネ/${basename(directory)} サムネ.png`);
    expect(readdirSync(join(directory, 'サムネ'))).toEqual([`${basename(directory)} サムネ.png`]);
    expect(readFileSync(join(directory, 'サムネ', `${basename(directory)} サムネ.png`))).toHaveLength(7);
    expect(events.filter(event => event.type === 'export' && event.executionId === 'e1').map(event => event.type === 'export' && event.phase)).toEqual(['checking', 'rendering', 'complete']);
  });
  it('メインでない案は <案件名> サムネ <案の名前>。メインは文書の mainPageId に従う', async () => {
    const directory = project(), exports = new ThumbnailExports(fake(() => 10).capture, new ThumbnailRenderInputs());
    const document = plain(); document.pages.push({ id: 'page-b', name: '案B', hueShift: 0, layers: [textLayer('b')] });
    begin(exports, directory, request('a'), document);
    expect(await exports.wait(directory, 'a')).toMatchObject({ fileName: `サムネ/${basename(directory)} サムネ.png`, main: true });
    begin(exports, directory, { ...request('b'), pageId: 'page-b' }, document);
    expect(await exports.wait(directory, 'b')).toMatchObject({ fileName: `サムネ/${basename(directory)} サムネ 案B.png`, main: false });
    document.mainPageId = 'page-b';
    begin(exports, directory, { ...request('b2'), pageId: 'page-b' }, document);
    expect(await exports.wait(directory, 'b2')).toMatchObject({ fileName: `サムネ/${basename(directory)} サムネ.png`, main: true });
  });
  it('PNG が 2MB を超えたら知らせ、JPEG は品質 90 から下げて 2MB に収める', async () => {
    const directory = project(), { capture, shots } = fake(shot => shot.format === 'png' || (shot.quality ?? 90) > 80 ? THUMBNAIL_MAX_BYTES + 1 : THUMBNAIL_MAX_BYTES - 1);
    const exports = new ThumbnailExports(capture, new ThumbnailRenderInputs());
    begin(exports, directory, request('png'));
    expect(await exports.wait(directory, 'png')).toMatchObject({ phase: 'complete', overLimit: true });
    begin(exports, directory, request('jpeg', 'jpeg'));
    const jpeg = await exports.wait(directory, 'jpeg');
    expect(jpeg).toMatchObject({ phase: 'complete', overLimit: false, quality: 80, bytes: THUMBNAIL_MAX_BYTES - 1 });
    expect(jpeg.fileName!.endsWith('.jpg')).toBe(true);
    expect(shots.slice(1).map(shot => shot.quality)).toEqual([90, 85, 80]);
  });
  it('同じ要求 ID の再送は記録を返し、中身が違えば断る', async () => {
    const directory = project(), { capture, shots } = fake(() => 10), exports = new ThumbnailExports(capture, new ThumbnailRenderInputs());
    begin(exports, directory, request('same'));
    await exports.wait(directory, 'same');
    expect(begin(exports, directory, request('same')).phase).toBe('complete');
    expect(shots).toHaveLength(1);
    expect(() => begin(exports, directory, request('same', 'jpeg'))).toThrow('同じ書き出しIDに異なる要求があります');
  });
  it('案件ごとに同時 1 件。取り消すと何も残さない', async () => {
    const directory = project();
    const blocking: ThumbnailCapture = target => new Promise((_resolve, reject) => target.signal.addEventListener('abort', () => reject(new Error('中止')), { once: true }));
    const exports = new ThumbnailExports(blocking, new ThumbnailRenderInputs());
    begin(exports, directory, request('run'));
    expect(() => begin(exports, directory, request('other'))).toThrow('別のサムネを書き出し中です');
    await new Promise(resolve => setTimeout(resolve, 20));
    exports.cancel(directory, 'run');
    expect(await exports.wait(directory, 'run')).toMatchObject({ phase: 'cancelled' });
    expect(existsSync(join(directory, 'サムネ'))).toBe(false);
  });
  it('書き出し先の名前にフォルダーがあれば、そのフォルダーも文書も変えずに止め、理由を出す（EISDIR）', async () => {
    const directory = project(), exports = new ThumbnailExports(fake(() => 10).capture, new ThumbnailRenderInputs());
    const blocker = join(directory, 'サムネ', `${basename(directory)} サムネ.png`);
    mkdirSync(blocker, { recursive: true }); writeFileSync(join(blocker, 'keep.txt'), 'keep');
    const document = plain(), before = JSON.stringify(document);
    begin(exports, directory, request('dir'), document);
    expect(await exports.wait(directory, 'dir')).toMatchObject({ phase: 'failed', error: `書き出し先に同じ名前のフォルダーがあります（${basename(directory)} サムネ.png）。フォルダーの名前を変えるか移してください` });
    expect(JSON.stringify(document)).toBe(before);
    expect(readFileSync(join(blocker, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(join(directory, 'サムネ'))).toEqual([`${basename(directory)} サムネ.png`]);
  });
  it('入力は版で固定し、版が違えば始めない', () => {
    const directory = project(), exports = new ThumbnailExports(fake(() => 1).capture, new ThumbnailRenderInputs());
    expect(() => begin(exports, directory, request('old', 'png', 3))).toThrow('編集内容が変わりました');
  });
  it('元の動画・画像が無ければ止めて理由を出す', async () => {
    const directory = project(), exports = new ThumbnailExports(fake(() => 1).capture, new ThumbnailRenderInputs());
    const video = thumbnailFixture(); video.pages[0]!.layers = [videoFrameLayer('f')];
    begin(exports, directory, request('video'), video);
    expect(await exports.wait(directory, 'video')).toMatchObject({ phase: 'failed', error: '元の動画が見つかりません（clip.mp4）' });
    const image = thumbnailFixture(); image.pages[0]!.layers = [imageLayer('i')];
    begin(exports, directory, request('image'), image);
    expect(await exports.wait(directory, 'image')).toMatchObject({ phase: 'failed', error: '画像が見つかりません（photo.png）' });
  });
  it('描画ページへの入力は撮影の間だけ登録する', async () => {
    const directory = project(), inputs = new ThumbnailRenderInputs();
    let seen = '';
    const capture: ThumbnailCapture = async (target, plan) => { seen = inputs.get(directory, target.jobId).id; return { bytes: Buffer.alloc(10), shot: plan[0]! }; };
    const exports = new ThumbnailExports(capture, inputs), status = begin(exports, directory, request('input'));
    await exports.wait(directory, 'input');
    expect(seen).toBe('thumbnail.page-a');
    expect(() => inputs.get(directory, status.jobId)).toThrow('描画する入力が見つかりません');
  });
});
