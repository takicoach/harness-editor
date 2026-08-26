// src/server/plugin.createProjectFallback.test.ts
/**
 * POST /api/create-project の**実行段フォールバック**（レビュー I-3）。
 *
 * 自動リンク化は「判断」（planImport）だけでなく「実行」（assertBrowsablePath /
 * createProjectLinked）でも失敗しうる。実行段で落ちたときに 500 を返すと、
 * 数GBを受信し終えた取り込みが最後の 1 手で丸ごと無駄になる。受信済みの一時ファイルは
 * まだ消していない（削除は finally）ので、そのままコピーで作成して 200 を返す。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './plugin';
import { HttpError } from './http';
import { createProject, createProjectLinked } from './createProject';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

// 実体（テンプレート展開・ffprobe）は使わない。ここで固定したいのはルートの分岐だけ。
vi.mock('./createProject', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./createProject')>();
  return {
    ...actual,
    createProject: vi.fn(),
    createProjectLinked: vi.fn(),
  };
});

const VIDEO = 'video-bytes-0123456789';

let base: string;
let root: string;
let ssd: string;
let prevRoots: string | undefined;
let prevInstall: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sme-create-fb-')));
  root = join(base, 'projects');
  ssd = join(base, 'ssd');
  mkdirSync(root, { recursive: true });
  mkdirSync(ssd, { recursive: true });
  // 外付け側に同一実体を置く（＝planImport はリンクを選ぶ）。
  writeFileSync(join(ssd, 'take1.mp4'), VIDEO, 'utf8');
  prevRoots = process.env.SME_BROWSE_ROOTS;
  process.env.SME_BROWSE_ROOTS = ssd;
  prevInstall = process.env.SME_NO_BACKGROUND_INSTALL;
  process.env.SME_NO_BACKGROUND_INSTALL = '1';

  // コピー作成は「一時ファイルを実際に動かす」ところまで再現する
  // （catch の時点で一時ファイルが残っていなければコピーできない＝この分岐は成立しない）。
  vi.mocked(createProject).mockImplementation((r, input) => {
    const dir = join(r, input.name);
    cpSync(SAMPLE, dir, { recursive: true });
    renameSync(input.videoTmpPath, join(dir, 'public', 'main.mp4'));
    return { id: input.name };
  });
});

afterEach(() => {
  if (prevRoots === undefined) delete process.env.SME_BROWSE_ROOTS;
  else process.env.SME_BROWSE_ROOTS = prevRoots;
  if (prevInstall === undefined) delete process.env.SME_NO_BACKGROUND_INSTALL;
  else process.env.SME_NO_BACKGROUND_INSTALL = prevInstall;
  rmSync(base, { recursive: true, force: true });
  vi.resetAllMocks();
});

async function createProjectCall(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
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
  const req = {
    method: 'POST',
    headers: {},
    url: path,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(VIDEO, 'utf8');
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

describe('create-project の実行段フォールバック', () => {
  it('リンク作成が落ちてもコピーで作成して 200 を返す（取り込みを捨てない）', async () => {
    vi.mocked(createProjectLinked).mockImplementation(() => {
      throw new Error('symlink boom');
    });

    const r = await createProjectCall('/api/create-project?name=fb1&video=take1.mp4');

    expect(vi.mocked(createProjectLinked)).toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(r.body['id']).toBe('fb1');
    const imported = r.body['imported'] as { linked: boolean; reason: string; message: string };
    expect(imported.linked).toBe(false);
    expect(imported.reason).toBe('link-failed');
    expect(imported.message).toContain('コピー');
    // 受信済みの実体がコピーとして置かれている（＝一時ファイルは catch 時点で健在だった）。
    expect(readFileSync(join(root, 'fb1', 'public', 'main.mp4'), 'utf8')).toBe(VIDEO);
  });

  it('リンク作成が通れば従来どおりリンク取り込みで 200（フォールバックは保険）', async () => {
    vi.mocked(createProjectLinked).mockImplementation((r, input) => {
      mkdirSync(join(r, input.name), { recursive: true });
      return { id: input.name };
    });

    const r = await createProjectCall('/api/create-project?name=fb2&video=take1.mp4');

    expect(r.status).toBe(200);
    expect((r.body['imported'] as { linked: boolean }).linked).toBe(true);
    expect(vi.mocked(createProject)).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'fb2'))).toBe(true);
  });
});
