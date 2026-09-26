import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeImageProject, imageUploadBody } from './api';
import type { TransferProgress } from '../components/TaskProgress';

afterEach(() => vi.unstubAllGlobals());
const files = [new File(['first'], '1-表紙.png'), new File(['second!'], '2.jpg')];

describe('複数画像の作成（画面側・設計 M3b）', () => {
  it('本文は [4バイトの一覧の長さ][一覧の JSON][各画像の中身] の順', async () => {
    const bytes = Buffer.from(await imageUploadBody(files).arrayBuffer()), length = bytes.readUInt32BE(0);
    expect(JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'))).toEqual({ version: 1, files: [{ name: '1-表紙.png', size: 5 }, { name: '2.jpg', size: 7 }] });
    expect(bytes.subarray(4 + length).toString('utf8')).toBe('firstsecond!');
  });
  it('アップロードは /api/create-project-images へ、名前は URL に載せず本文の一覧に入れる', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'album' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createNativeImageProject('アルバム', files)).resolves.toEqual({ id: 'album' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/create-project-images?${new URLSearchParams({ name: 'アルバム', native: '1' })}`);
    expect(url).not.toContain(encodeURIComponent('1-表紙.png'));
    expect(init.method).toBe('POST'); expect(init.body).toBeInstanceOf(Blob);
  });
  it('進み具合を渡すと XHR で送り、送信量を報告する', async () => {
    let xhr: any;
    vi.stubGlobal('XMLHttpRequest', class { upload: any = {}; status = 200; response: any; open = vi.fn(); send = vi.fn(); constructor() { xhr = this; } });
    const updates: TransferProgress[] = [], promise = createNativeImageProject('album', files, (p) => updates.push(p));
    const sent = xhr.send.mock.calls[0][0] as Blob;
    expect(sent.size).toBe(Buffer.from(await imageUploadBody(files).arrayBuffer()).length);
    expect(updates[0]).toEqual({ phase: 'uploading', loaded: 0, total: sent.size });
    xhr.response = { id: 'album' }; xhr.onload(); await expect(promise).resolves.toEqual({ id: 'album' });
  });
  it('フォルダから選んだパスは /api/create-project-image-paths へ JSON で送り、失敗の理由をそのまま出す', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: '画像は1回に200枚・合計2GBまで作成できます' }), { status: 413 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createNativeImageProject('picked', ['/ssd/b.png', '/ssd/a.png'])).rejects.toThrow('合計2GB');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith('/api/create-project-image-paths?')).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ paths: ['/ssd/b.png', '/ssd/a.png'] });
  });
});
