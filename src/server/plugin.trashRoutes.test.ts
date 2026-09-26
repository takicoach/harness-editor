// src/server/plugin.trashRoutes.test.ts
/**
 * 削除・ゴミ箱まわりの HTTP ルート（DELETE /api/material・DELETE /api/project・/api/trash）の
 * 振る舞いテスト。文字列検査ではなく handleApi を実際に叩いて応答を確かめる
 * （トラバーサル拒否・405・409 の返り分けは経路の組み立て順に依存するため）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './plugin';
import { HttpError } from './http';
import { TRASH_DIR } from './trashStore';
import { PROJECT_JOB_MANAGERS } from './jobRegistries';
import { instructionInbox, PROJECT_NOT_FOUND_REPLY } from './instructionInbox';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

let root: string;
let proj: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sme-routes-'));
  proj = join(root, 'proj');
  cpSync(SAMPLE, proj, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, jsonBody?: unknown): Promise<Reply> {
  const url = new URL(`http://localhost${path}`);
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(text?: string) {
      body = text === undefined || text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    },
  } as unknown as ServerResponse;
  // readJsonBody は req を async iterable として読む。POST の本文はここで流し込む。
  const payload = jsonBody === undefined ? null : Buffer.from(JSON.stringify(jsonBody), 'utf8');
  const req = {
    method,
    headers: {},
    url: path,
    async *[Symbol.asyncIterator]() {
      if (payload !== null) yield payload;
    },
  } as unknown as IncomingMessage;
  try {
    await handleApi(req, res, url, root);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  return { status, body };
}

/**
 * 本文をストリームで返すルート（動画配信）用の呼び出し。`call` の res モックは
 * writeHead の status しか見ず pipe も受けられないので、Writable を用意して
 * ヘッダと本文バイトを実測する。
 */
async function callStream(
  path: string,
  range?: string,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(`http://localhost${path}`);
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  let status = 0;
  let headers: Record<string, string> = {};
  (sink as unknown as ServerResponse).writeHead = ((s: number, h?: Record<string, string>) => {
    status = s;
    headers = h ?? {};
    return sink as unknown as ServerResponse;
  }) as ServerResponse['writeHead'];
  const req = {
    method: 'GET',
    headers: range === undefined ? {} : { range },
    url: path,
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {},
  } as unknown as IncomingMessage;
  try {
    await handleApi(req, sink as unknown as ServerResponse, url, root);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, headers: {}, body: Buffer.alloc(0) };
    throw err;
  }
  await new Promise<void>((resolve) => sink.on('end', () => resolve()));
  return { status, headers, body: Buffer.concat(chunks) };
}

function trashNames(base: string): string[] {
  const dir = join(base, TRASH_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('trash-manifest')) : [];
}

describe('DELETE /api/material', () => {
  it('DELETE 以外は 405', async () => {
    const r = await call('GET', '/api/material?id=proj&kind=se&file=beep.mp3');
    expect(r.status).toBe(405);
  });

  it('.. を含むファイル名は 400（トラバーサル拒否）', async () => {
    const r = await call('DELETE', '/api/material?id=proj&kind=se&file=../../etc/passwd');
    expect(r.status).toBe(400);
    expect(trashNames(proj)).toEqual([]);
  });

  it('素材ライブラリに無いファイルは 400（任意の public 配下ファイルを消させない）', async () => {
    writeFileSync(join(proj, 'public', 'notes.txt'), 'SECRET', 'utf8');
    const r = await call('DELETE', '/api/material?id=proj&kind=se&file=notes.txt');
    expect(r.status).toBe(400);
    expect(readFileSync(join(proj, 'public', 'notes.txt'), 'utf8')).toBe('SECRET');
  });

  it('メイン動画は 400（プロジェクト削除でのみ消える）', async () => {
    const r = await call('DELETE', '/api/material?id=proj&kind=video&file=main.mp4');
    expect(r.status).toBe(400);
    expect(existsSync(join(proj, 'public', 'main.mp4'))).toBe(true);
  });

  it('使用中の素材は 409 in-use（件数つき）で削除しない', async () => {
    const r = await call('DELETE', '/api/material?id=proj&kind=se&file=beep.mp3');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'in-use', count: 1 });
    expect(existsSync(join(proj, 'public', 'se', 'beep.mp3'))).toBe(true);
  });

  it('force=1 なら使用中でもゴミ箱へ移し、サーバ走査の件数を応答に載せる', async () => {
    const r = await call('DELETE', '/api/material?id=proj&kind=se&file=beep.mp3&force=1');
    expect(r.status).toBe(200);
    expect(r.body['usedCount']).toBe(1);
    expect(existsSync(join(proj, 'public', 'se', 'beep.mp3'))).toBe(false);
    expect(trashNames(proj)).toHaveLength(1);
  });

  it('使用箇所を走査できないときは 409 scan-failed（未使用と誤認しない）', async () => {
    // seData.ts をディレクトリに差し替えて走査失敗を作る。
    rmSync(join(proj, 'src', 'SoundEffects', 'seData.ts'), { force: true });
    mkdirSync(join(proj, 'src', 'SoundEffects', 'seData.ts'), { recursive: true });
    const r = await call('DELETE', '/api/material?id=proj&kind=bgm&file=bgm.mp3');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'scan-failed' });
    expect(existsSync(join(proj, 'public', 'BGM', 'bgm.mp3'))).toBe(true);
  });

  /**
   * force は「**判明した**使用件数を承知のうえで削除する」という意思表示。
   * 走査が失敗した場合は件数が分からず、ユーザーは何も承知できていないので、
   * force=1 でも scan-failed を維持する（force を走査失敗の免罪符にしない）。
   */
  it('force=1 でも走査失敗なら 409 scan-failed（実体は残る）', async () => {
    // データファイルを**ディレクトリに差し替える**やり方では loadProjectFromDir が先に
    // 落ちて手前の 409 に吸われ、force 分岐まで届かない（＝検査にならない）。
    // 走査だけが失敗する条件は「正当な TS のまま走査の上限 2MB を超える」こと。
    const pad = '// ' + 'x'.repeat(2 * 1024 * 1024) + '\n';
    writeFileSync(
      join(proj, 'src', 'SoundEffects', 'seData.ts'),
      pad + 'export const seData = [];\n',
      'utf8',
    );
    const r = await call('DELETE', '/api/material?id=proj&kind=bgm&file=bgm.mp3&force=1');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'scan-failed' });
    expect(existsSync(join(proj, 'public', 'BGM', 'bgm.mp3'))).toBe(true);
    expect(trashNames(proj)).toHaveLength(0);
  });

  it('親ディレクトリが symlink の素材は 400 で外部実体が残る', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      writeFileSync(join(outside, 'real.mp3'), 'REAL', 'utf8');
      // 末端ではなく親ディレクトリ（public/BGM）を外部フォルダへの symlink にする。
      rmSync(join(proj, 'public', 'BGM'), { recursive: true, force: true });
      symlinkSync(outside, join(proj, 'public', 'BGM'));
      const r = await call('DELETE', '/api/material?id=proj&kind=bgm&file=real.mp3');
      expect(r.status).toBe(400);
      expect(readFileSync(join(outside, 'real.mp3'), 'utf8')).toBe('REAL');
      expect(trashNames(proj)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('symlink 越しのプロジェクト内パスも 400（実体を unlink しない）', async () => {
    symlinkSync(join(proj, 'public', 'se', 'beep.mp3'), join(proj, 'public', 'BGM', 'link.mp3'));
    const r = await call('DELETE', '/api/material?id=proj&kind=bgm&file=link.mp3');
    expect(r.status).toBe(400);
    expect(existsSync(join(proj, 'public', 'se', 'beep.mp3'))).toBe(true);
  });

  it('videoConfig.ts を読めないときは kind=video の削除を 409 で保留する', async () => {
    writeFileSync(join(proj, 'src', 'videoConfig.ts'), 'export const BROKEN = 1;', 'utf8');
    const r = await call('DELETE', '/api/material?id=proj&kind=video&file=sub/cam2.mp4');
    expect(r.status).toBe(409);
    expect(existsSync(join(proj, 'public', 'sub', 'cam2.mp4'))).toBe(true);
  });
});

describe('DELETE /api/project', () => {
  it('ハーネス形式の案件でないディレクトリは 400', async () => {
    mkdirSync(join(root, 'plain'), { recursive: true });
    writeFileSync(join(root, 'plain', 'a.txt'), 'A', 'utf8');
    const r = await call('DELETE', '/api/project?id=plain');
    expect(r.status).toBe(400);
    expect(existsSync(join(root, 'plain', 'a.txt'))).toBe(true);
  });

  it('ルート自身（id=.）は 400 で消さない', async () => {
    const r = await call('DELETE', '/api/project?id=.');
    expect(r.status).toBe(400);
    expect(existsSync(proj)).toBe(true);
  });

  it('正常時はルートのゴミ箱へ移す', async () => {
    const r = await call('DELETE', '/api/project?id=proj');
    expect(r.status).toBe(200);
    expect(existsSync(proj)).toBe(false);
    expect(trashNames(root)).toHaveLength(1);
  });

  /**
   * busy 判定の「結線」テスト（再レビュー I-2）。
   * `findBusyJobs` 自体の述語は projectBusy.test.ts が持つ。ここで確かめるのは
   * 「plugin.ts が実際にその登録簿を全部渡しているか」＝結線漏れの検出で、
   * 種別を 1 つ足したのに DELETE 経路へ繋ぎ忘れる事故（jobRegistries.ts の正本化で
   * 構造的に防いでいる登録簿＋別経路の aiInstruction）を 1 件でループ検証する。
   */
  it('実行中のジョブ・AI 指示があれば 409 busy でディスクに残る（登録簿 7 種）', async () => {
    const arm: Record<string, () => void> = {
      ...Object.fromEntries(
        Object.entries(PROJECT_JOB_MANAGERS).map(([name, manager]) => [
          name,
          () => {
            vi.spyOn(manager, 'get').mockImplementation((projectId: string) =>
              projectId === 'proj' ? ({ phase: 'rendering' } as never) : undefined,
            );
          },
        ]),
      ),
      aiInstruction: () => {
        vi.spyOn(instructionInbox, 'hasProcessing').mockImplementation((id) => id === 'proj');
      },
    };
    expect(Object.keys(arm)).toEqual([
      'render', 'transcribe', 'nativeTranscribe', 'nativeRender', 'denoise', 'normalize', 'previewProxy', 'aiInstruction',
    ]);

    for (const [name, makeBusy] of Object.entries(arm)) {
      makeBusy();
      try {
        const r = await call('DELETE', '/api/project?id=proj');
        expect(r.status, name).toBe(409);
        expect(r.body['error'], name).toBe('busy');
        expect(r.body['jobs'], name).toEqual([name]);
        expect(existsSync(proj), name).toBe(true);
        expect(trashNames(root), name).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    }
  });

  /**
   * 再レビュー I-1: pending は削除を止めない（誰も取っていない）代わりに、
   * 削除が通った瞬間に同一プロセス内で失効させる。失効させないと、直後の poll が
   * 消えたパス宛の指示を processing にして配送してしまい（エージェントが不在の
   * ディレクトリで作業を始める）、その stale な processing が hasProcessing を真に
   * するため復元後の削除まで弾かれ続ける。
   */
  it('pending の AI 指示は削除成功で失効し、消えたパスへ配送されない（再レビュー I-1）', async () => {
    const rec = instructionInbox.enqueue({
      projectId: 'proj',
      projectDir: proj,
      text: 'テロップを直して',
      context: { frame: 0, timeSec: 0, selection: null },
    });
    expect(rec.status).toBe('pending');

    const r = await call('DELETE', '/api/project?id=proj');
    expect(r.status).toBe(200);

    expect(instructionInbox.takeNext({ projectId: 'proj' })).toBeNull();
    const after = instructionInbox.list('proj').find((x) => x.id === rec.id);
    expect(after?.status).toBe('failed');
    // 起動時復元（attachPersistence）と同じ文言に揃える。
    expect(after?.reply).toBe(PROJECT_NOT_FOUND_REPLY);
    expect(instructionInbox.hasProcessing('proj')).toBe(false);
  });
});

describe('/api/trash/restore・/api/trash/empty（バッチG: 部分反映と契約の明示）', () => {
  async function trashOne(): Promise<string> {
    const r = await call('DELETE', '/api/material?id=proj&kind=bgm&file=bgm.mp3');
    return (r.body['entry'] as { id: string }).id;
  }

  it('復元の応答に素材ライブラリのパッチが載る（全体 reload を不要にする）', async () => {
    const entryId = await trashOne();
    const r = await call('POST', '/api/trash/restore', { id: 'proj', entryId });
    expect(r.status).toBe(200);
    expect(r.body['bgmLibrary']).toEqual(['bgm.mp3']);
    expect(r.body['seLibrary']).toEqual(['beep.mp3']);
    expect(typeof r.body['assetVersions']).toBe('object');
  });

  it('完全削除の応答にも素材ライブラリのパッチが載る', async () => {
    const entryId = await trashOne();
    const r = await call('POST', '/api/trash/empty', { id: 'proj', entryId });
    expect(r.status).toBe(200);
    expect(r.body['removed']).toBe(1);
    expect(r.body['bgmLibrary']).toEqual([]);
  });

  it('ルート（id なし）の応答にライブラリパッチは載らない', async () => {
    await call('DELETE', '/api/project?id=proj');
    const list = await call('GET', '/api/trash');
    const entryId = (list.body['entries'] as Array<{ id: string }>)[0]!.id;
    const r = await call('POST', '/api/trash/restore', { entryId });
    expect(r.status).toBe(200);
    expect(r.body['seLibrary']).toBeUndefined();
  });

  it('空にするは all:true を必須にする（entryId 省略だけで全消ししない）', async () => {
    await trashOne();
    const r = await call('POST', '/api/trash/empty', { id: 'proj' });
    expect(r.status).toBe(400);
    expect(trashNames(proj)).toHaveLength(1);
  });

  it('all:true なら全件削除する', async () => {
    await trashOne();
    await call('DELETE', '/api/material?id=proj&kind=video&file=sub/cam2.mp4');
    const r = await call('POST', '/api/trash/empty', { id: 'proj', all: true });
    expect(r.status).toBe(200);
    expect(r.body['removed']).toBe(2);
    expect(trashNames(proj)).toEqual([]);
  });

  it('entryId が空文字でも全消ししない', async () => {
    await trashOne();
    const r = await call('POST', '/api/trash/empty', { id: 'proj', entryId: '' });
    expect(r.status).toBe(400);
    expect(trashNames(proj)).toHaveLength(1);
  });
});

describe('/api/trash', () => {
  it('GET 以外は 405', async () => {
    const r = await call('POST', '/api/trash?id=proj');
    expect(r.status).toBe(405);
  });

  /**
   * ゴミ箱カードのサムネイル配信。パス解決の全条件は trashVideo.test.ts が持つ。
   * ここで固定するのは「HTTP 層がクライアントの入力をそのまま使わない」結線。
   */
  describe('/api/trash/video', () => {
    it('entryId が UUID でなければ 400（ネストパスも含む）', async () => {
      await call('DELETE', '/api/project?id=proj');
      for (const bad of ['e1', '..%2F..%2Fetc%2Fpasswd', 'proj%2Fpublic%2Fmain.mp4']) {
        const r = await call('GET', `/api/trash/video?entryId=${bad}`);
        expect(r.status, bad).toBe(400);
      }
    });

    it('entryId 未指定は 400', async () => {
      const r = await call('GET', '/api/trash/video');
      expect(r.status).toBe(400);
    });

    it('GET 以外は 405', async () => {
      const r = await call('POST', '/api/trash/video?entryId=11111111-2222-3333-4444-555555555555');
      expect(r.status).toBe(405);
    });

    /**
     * サムネイルは `<video>` が metadata → 代表フレームへシークして作るため、
     * 実運用の初手は必ず Range リクエストになる。ルートが 206 と Content-Range を
     * 返すこと（＝serveVideo に range ヘッダが渡っていること）を結線として固定する。
     */
    it('Range 付きリクエストに 206 と Content-Range で答える（M-2）', async () => {
      const size = statSync(join(proj, 'public', 'main.mp4')).size;
      await call('DELETE', '/api/project?id=proj');
      const list = await call('GET', '/api/trash');
      const entryId = (list.body['entries'] as Array<{ id: string }>)[0]!.id;
      const r = await callStream(`/api/trash/video?entryId=${entryId}`, 'bytes=0-1');
      expect(r.status).toBe(206);
      expect(r.headers['Content-Range']).toBe(`bytes 0-1/${size}`);
      expect(r.headers['Content-Length']).toBe('2');
      expect(r.body).toHaveLength(2);
    });

    it('Range 無しなら 200 で全体を返す', async () => {
      const size = statSync(join(proj, 'public', 'main.mp4')).size;
      await call('DELETE', '/api/project?id=proj');
      const list = await call('GET', '/api/trash');
      const entryId = (list.body['entries'] as Array<{ id: string }>)[0]!.id;
      const r = await callStream(`/api/trash/video?entryId=${entryId}`);
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(size);
    });

    it('動画の無い tombstone は 404（プレースホルダへ落とす）', async () => {
      rmSync(join(proj, 'public', 'main.mp4'), { force: true });
      await call('DELETE', '/api/project?id=proj');
      const list = await call('GET', '/api/trash');
      const entryId = (list.body['entries'] as Array<{ id: string }>)[0]!.id;
      const r = await call('GET', `/api/trash/video?entryId=${entryId}`);
      expect(r.status).toBe(404);
    });
  });

  it('削除した素材が一覧に出る', async () => {
    await call('DELETE', '/api/material?id=proj&kind=se&file=beep.mp3&force=1');
    const r = await call('GET', '/api/trash?id=proj');
    expect(r.status).toBe(200);
    const entries = r.body['entries'] as Array<{ name: string; kind: string }>;
    expect(entries.map((e) => e.name)).toEqual(['beep.mp3']);
    expect(entries[0]!.kind).toBe('se');
  });
});
