// src/server/plugin.convertBurnedInRoute.test.ts
/**
 * B-4 (3/3): POST /api/convert-burned-in が markSelfWrite を呼ぶことを固定する。
 *
 * 呼ばなければ、変換直後に chokidar が検知する自分自身の書き込み（cutData.ts 生成）が
 * 「外部での書き換え」として誤検知され、同一プロジェクト内に留まったユーザーへ
 * ExternalChangeBanner が誤表示される（変換直後の外部変更バナー誤表示）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './plugin';
import { HttpError } from './http';
import { isSelfWriting, clearSelfWrite } from './selfWrite';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');
const SAMPLE_VC = readFileSync(join(SAMPLE, 'src', 'videoConfig.ts'), 'utf8');

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sme-convert-burned-route-')));
  root = join(base, 'projects');
  mkdirSync(join(root, 'proj', 'src'), { recursive: true });
  // cutData.ts の無い「焼き込み」プロジェクトを最小構成で用意する（convertBurnedInProject の対象）。
  writeFileSync(join(root, 'proj', 'src', 'videoConfig.ts'), SAMPLE_VC, 'utf8');
});
afterEach(() => {
  clearSelfWrite('proj');
  rmSync(base, { recursive: true, force: true });
});

async function call(method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
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
    method,
    headers: {},
    url: path,
    async *[Symbol.asyncIterator]() {
      /* 本文なし */
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

describe('POST /api/convert-burned-in', () => {
  it('変換直後、そのプロジェクトは自己書込ウィンドウ内になる（外部変更バナーの誤表示を防ぐ）', async () => {
    expect(isSelfWriting('proj')).toBe(false);
    const res = await call('POST', '/api/convert-burned-in?id=proj');
    expect(res.status).toBe(200);
    // markSelfWrite が呼ばれていれば、直後は必ず自己書込ウィンドウ内。
    expect(isSelfWriting('proj')).toBe(true);
  });
});
