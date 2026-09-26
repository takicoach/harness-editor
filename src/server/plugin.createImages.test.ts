import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from './plugin';
import { HttpError } from './http';
import { createSequenceImageProject, createSequenceProject } from './sequence/create';
import { imageUploadPrefix } from '../shared/imageUploadFrame';

vi.mock('./sequence/create', () => ({ createSequenceProject: vi.fn(), createSequenceImageProject: vi.fn() }));

const IMAGES = [{ name: '1.png', bytes: Buffer.from('first-image') }, { name: '2.jpg', bytes: Buffer.from('second-image') }];
const frame = (list = IMAGES) => Buffer.concat([Buffer.from(imageUploadPrefix(list.map((image) => ({ name: image.name, size: image.bytes.length })))), ...list.map((image) => image.bytes)]);
let base: string, root: string, ssd: string, previousRoots: string | undefined, bodyReads: number;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'native-create-images-api-'))); root = join(base, 'projects'); ssd = join(base, 'ssd');
  mkdirSync(root); mkdirSync(ssd); previousRoots = process.env.SME_BROWSE_ROOTS; process.env.SME_BROWSE_ROOTS = ssd; bodyReads = 0;
  vi.mocked(createSequenceImageProject).mockImplementation(async (_root, input) => {
    for (const [index, image] of input.images.entries()) if (input.images.length === IMAGES.length && image.sourcePath.includes('.sme-upload-tmp')) expect(readFileSync(image.sourcePath)).toEqual(IMAGES[index]!.bytes);
    return { id: input.name };
  });
});
afterEach(() => {
  if (previousRoots === undefined) delete process.env.SME_BROWSE_ROOTS; else process.env.SME_BROWSE_ROOTS = previousRoots;
  rmSync(base, { recursive: true, force: true }); vi.resetAllMocks();
});
function request(path: string, payload: Buffer, headers: Record<string, string> = {}, method = 'POST') {
  let status = 0, body: Record<string, unknown> = {};
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, writeHead(s: number) { status = s; return this; }, end(text?: string) { this.writableEnded = true; body = text ? JSON.parse(text) : {}; } }) as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { method, headers, url: path, aborted: false, async *[Symbol.asyncIterator]() { bodyReads++; for (let at = 0; at < payload.length; at += 5) yield payload.subarray(at, at + 5); } }) as unknown as IncomingMessage;
  const result = (async () => {
    try { await handleApi(req, res, new URL(`http://localhost${path}`), root); } catch (error) { if (error instanceof HttpError) return { status: error.status, body: { error: error.message } }; throw error; }
    expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0);
    return { status, body };
  })();
  return { req, res, result };
}
const stagingLeft = () => existsSync(join(root, '.sme-upload-tmp')) ? readdirSync(join(root, '.sme-upload-tmp')) : [];

describe('複数画像の作成 API（設計 M3b）', () => {
  it.each(['/api/create-project-images', '/api/create-project-image-paths'])('%s: native=1 以外は 410、GET は 405（本文を読まない）', async (endpoint) => {
    expect((await request(`${endpoint}?name=x`, frame()).result).status).toBe(410);
    expect((await request(`${endpoint}?native=1&name=x`, frame(), {}, 'GET').result).status).toBe(405);
    expect(bodyReads).toBe(0); expect(createSequenceImageProject).not.toHaveBeenCalled();
  });
  it('アップロード: 一時フォルダへ順に受けて1回で作成し、成功後に一時フォルダを消す', async () => {
    const { result } = request('/api/create-project-images?native=1&name=album', frame());
    expect(await result).toMatchObject({ status: 200, body: { id: 'album' } });
    expect(createSequenceImageProject).toHaveBeenCalledTimes(1);
    const [directory, input, signal] = vi.mocked(createSequenceImageProject).mock.calls[0]!;
    expect(directory).toBe(root); expect(input.images.map((image) => image.name)).toEqual(['1.png', '2.jpg']);
    expect(signal!.aborted).toBe(false);
    expect(stagingLeft()).toEqual([]);
  });
  it('作成が失敗しても一時フォルダを消す', async () => {
    vi.mocked(createSequenceImageProject).mockRejectedValueOnce(new HttpError(422, '「2.jpg」を画像として読み取れません。別の画像を選んでください'));
    expect((await request('/api/create-project-images?native=1&name=album', frame()).result).status).toBe(422);
    expect(stagingLeft()).toEqual([]);
  });
  it('本文が途中で切れたら（切断）作成せず 400、一時フォルダを消す', async () => {
    const full = frame();
    expect((await request('/api/create-project-images?native=1&name=album', full.subarray(0, full.length - 4)).result).status).toBe(400);
    expect(createSequenceImageProject).not.toHaveBeenCalled(); expect(stagingLeft()).toEqual([]);
  });
  it('接続が閉じたら作成へ中止を伝える', async () => {
    const pending = request('/api/create-project-images?native=1&name=album', frame());
    vi.mocked(createSequenceImageProject).mockImplementationOnce(async (_root, _input, signal) => { pending.res.emit('close'); expect(signal!.aborted).toBe(true); throw new HttpError(499, '中止'); });
    expect((await pending.result).status).toBe(499); expect(stagingLeft()).toEqual([]);
  });
  it('大きすぎる本文と重複する名前は、本文を読む前に断る', async () => {
    expect((await request('/api/create-project-images?native=1&name=big', frame(), { 'content-length': String(3 * 1024 ** 3) }).result).status).toBe(413);
    mkdirSync(join(root, 'existing'));
    expect((await request('/api/create-project-images?native=1&name=existing', frame()).result).status).toBe(409);
    expect(bodyReads).toBe(0); expect(createSequenceImageProject).not.toHaveBeenCalled();
  });
  it('フォルダから選んだ画像: 許可された場所のパスだけを、コピーで作成へ渡す', async () => {
    const paths = ['b.png', 'a.png'].map((name) => { const path = join(ssd, name); writeFileSync(path, name); return path; });
    const { result } = request('/api/create-project-image-paths?native=1&name=picked', Buffer.from(JSON.stringify({ paths })), { 'content-type': 'application/json' });
    expect(await result).toMatchObject({ status: 200, body: { id: 'picked' } });
    expect(vi.mocked(createSequenceImageProject).mock.calls[0]![1]).toEqual({ name: 'picked', images: [{ name: 'b.png', sourcePath: paths[0] }, { name: 'a.png', sourcePath: paths[1] }] });
    expect(createSequenceProject).not.toHaveBeenCalled();
  });
  it('フォルダから選んだ画像: 許可外のパスや画像以外は作成しない', async () => {
    const outside = join(base, 'outside.png'); writeFileSync(outside, 'x');
    const audio = join(ssd, 'talk.mp3'); writeFileSync(audio, 'x');
    const inside = join(ssd, 'a.png'); writeFileSync(inside, 'x');
    expect((await request('/api/create-project-image-paths?native=1&name=o', Buffer.from(JSON.stringify({ paths: [inside, outside] }))).result).status).toBe(403);
    expect((await request('/api/create-project-image-paths?native=1&name=m', Buffer.from(JSON.stringify({ paths: [inside, audio] }))).result).status).toBe(400);
    expect((await request('/api/create-project-image-paths?native=1&name=j', Buffer.from('{')).result).status).toBe(400);
    expect(createSequenceImageProject).not.toHaveBeenCalled();
  });
});
