import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleApi } from './plugin';
import { HttpError, sendJson } from './http';

// 2026-09-25 学習ループの移植（設計書 D1）: 旧来の差分承認を再開した。承認は旧学習（jsonl 追記・ルール昇格・語句辞書）を
// 記録する。「編集の好み」は別の仕組みとして並び、その保存物（preference-*.json）はこの承認で書き換えない。
it('旧差分承認は旧学習を記録し、「編集の好み」の保存物（preference-*.json）は書き換えない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'editor-learning-gate-'));
  const learning = join(root, 'learning'); mkdirSync(learning);
  const preferenceFiles = {
    'preference-decisions.v1.json': JSON.stringify({ sentinel: 'decisions must remain byte-identical' }),
    'preference-workspace.v1.json': JSON.stringify({ sentinel: 'workspace must remain byte-identical' }),
  };
  for (const [name, text] of Object.entries(preferenceFiles)) writeFileSync(join(learning, name), text);
  cpSync(new URL('./__fixtures__/sample-project', import.meta.url), join(root, 'video'), { recursive: true });
  // 学習フォルダは HARNESS_LEARNING_HOME が最優先。旧名も同じ一時フォルダへ向け、実際の学習フォルダへ書かない。
  vi.stubEnv('HARNESS_LEARNING_HOME', learning);
  vi.stubEnv('SUPERMOVIE_LEARNING_HOME', learning);
  const server = createServer((req, res) => {
    void handleApi(req, res, new URL(req.url!, 'http://localhost'), root)
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/learning/approve`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'video', cut: [],
        words: [{ before: '素振りする', after: '素振りをする' }],
        telops: [{ kind: 'changed', startFrame: 30, endFrame: 150, startSec: 0.5, endSec: 2.5, before: 'ゆる素振り', after: 'ゆるい素振り' }], ses: [] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: { cut: 0, words: 1, telops: 1, ses: 0 }, alreadyRecorded: 0 });
    const lines = readFileSync(join(learning, 'telop_feedback.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([expect.objectContaining({ videoId: 'video', kind: 'changed', before: 'ゆる素振り', after: 'ゆるい素振り' })]);
    for (const [name, text] of Object.entries(preferenceFiles)) expect(readFileSync(join(learning, name), 'utf8')).toBe(text);
    expect(readdirSync(learning).filter((name) => name.startsWith('preference-')).sort()).toEqual(Object.keys(preferenceFiles).sort());
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
});

it('旧形式の承認でも項目の型が違えば 400 で、学習フォルダに何も書かない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'editor-learning-gate-'));
  const learning = join(root, 'learning'); mkdirSync(learning);
  cpSync(new URL('./__fixtures__/sample-project', import.meta.url), join(root, 'video'), { recursive: true });
  vi.stubEnv('HARNESS_LEARNING_HOME', learning);
  vi.stubEnv('SUPERMOVIE_LEARNING_HOME', learning);
  const server = createServer((req, res) => {
    void handleApi(req, res, new URL(req.url!, 'http://localhost'), root)
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/learning/approve`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const telop = { kind: 'changed', startFrame: 30, endFrame: 150, startSec: 0.5, endSec: 2.5, before: 'ゆる素振り', after: 'ゆるい素振り' };
    // 正しい項目と型の違う項目が混ざっていても、1件も書かずに全体を拒否する。
    for (const bad of [{ ...telop, after: 42 }, { ...telop, kind: 'rewritten' }, { ...telop, startFrame: '30' }]) {
      const response = await post({ projectId: 'video', cut: [], words: [], telops: [telop, bad], ses: [] });
      expect(response.status).toBe(400);
    }
    expect((await post({ projectId: 'video', cut: [{ kind: 'added-cut', startFrame: 0, endFrame: 30, startSec: 0, endSec: 1, text: ['配列'] }], words: [] })).status).toBe(400);
    expect(readdirSync(learning)).toEqual([]);
    // 存在検査: 同じ経路で正しい要求なら書く（上の 400 が経路の不通による空振りでないこと）。
    expect((await post({ projectId: 'video', cut: [], words: [], telops: [telop], ses: [] })).status).toBe(200);
    expect(readdirSync(learning)).toContain('telop_feedback.jsonl');
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
});
