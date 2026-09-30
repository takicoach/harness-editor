import { describe, it, expect, vi, afterEach } from 'vitest';
import { dropPaths, terminalDropText, terminalPathWord, uploadTerminalAttachment } from './terminalDrop';

afterEach(() => { vi.unstubAllGlobals(); });

describe('terminalPathWord', () => {
  it('ターミナルアプリと同じく、空白や括弧をバックスラッシュで逃がす（日本語はそのまま）', () => {
    expect(terminalPathWord('/Users/x/Desktop/スイング 画像(1).png')).toBe('/Users/x/Desktop/スイング\\ 画像\\(1\\).png');
    expect(terminalPathWord("/tmp/it's & $HOME;`x`")).toBe("/tmp/it\\'s\\ \\&\\ \\$HOME\\;\\`x\\`");
    expect(terminalPathWord('/tmp/plain-file_1.mov')).toBe('/tmp/plain-file_1.mov');
  });
  it('Windows のパスは空白を含む時だけ二重引用符で囲む', () => {
    expect(terminalPathWord('C:\\Media\\My Videos\\a.mp4')).toBe('"C:\\Media\\My Videos\\a.mp4"');
    expect(terminalPathWord('C:\\clips\\a.mp4')).toBe('C:\\clips\\a.mp4');
  });
  it('改行を含むパスは貼った瞬間に送信されるため受け付けない', () => {
    expect(() => terminalPathWord('/tmp/a\nrm -rf x')).toThrow('改行');
  });
});

describe('terminalDropText', () => {
  it('複数ファイルは空白区切り・末尾に空白 1 つ', () => {
    expect(terminalDropText(['/a/b.png', '/c d/e.mov'])).toBe('/a/b.png /c\\ d/e.mov ');
  });
});

describe('dropPaths', () => {
  const file = (name: string) => new File(['x'], name);
  it('実パスが取れるファイル（デスクトップ版）は送らずにそのパスを使う', async () => {
    const upload = vi.fn(async () => '/tmp/uploaded');
    const paths = await dropPaths([file('a.png')], upload, () => '/Users/x/a.png');
    expect(paths).toEqual(['/Users/x/a.png']);
    expect(upload).not.toHaveBeenCalled();
  });
  it('実パスが取れない（ブラウザ版）時だけ送り、落とした順を保つ', async () => {
    const upload = vi.fn(async (f: File) => `/tmp/drops/${f.name}`);
    const paths = await dropPaths([file('a.png'), file('b.png')], upload, (f) => f.name === 'b.png' ? '/real/b.png' : '');
    expect(paths).toEqual(['/tmp/drops/a.png', '/real/b.png']);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('uploadTerminalAttachment', () => {
  it('ファイル名を付けて中身を送り、返ってきた保存先を返す', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ path: '/tmp/x/動画.mov' }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const f = new File(['abc'], '動画.mov');
    await expect(uploadTerminalAttachment(f)).resolves.toBe('/tmp/x/動画.mov');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/pty/attachment?${new URLSearchParams({ name: '動画.mov' })}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(f);
  });
  it('サーバーの失敗理由をそのまま伝える', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 413, json: async () => ({ error: 'アップロードが上限を超えました' }) }) as unknown as Response));
    await expect(uploadTerminalAttachment(new File(['a'], 'a.mov'))).rejects.toThrow('アップロードが上限を超えました');
  });
});
