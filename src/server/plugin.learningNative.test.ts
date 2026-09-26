import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApi } from './plugin';
import { HttpError, sendJson } from './http';
import { createImportedProject, standardEdit, standardFinish, type ImportedProjectFixture } from './learning/__fixtures__/importedProject';
import { SILENT_CUT_TEXT } from './learning/nativeLearningRules';
import type { LearningApproveRequest, LearningApproveResponse, LearningDiffResponse } from '../shared/types';

const HARVEST_V2 = process.env['HARVEST_V2_PATH']
  ?? resolve(process.cwd(), '../harness-editor-packs/brain/src/skills-package/skills/learn/scripts/harvest_v2.mjs');
// harvest_v2 が無い環境では照合を飛ばすが、HARNESS_REQUIRE_HARVEST_V2=1 のときは飛ばさずに失敗させる
// （nativeLearningHarvestParity.test.ts と同じ。計画の検証ではこれを付けて回し、沈黙した skip を許さない）。
if (!existsSync(HARVEST_V2) && process.env['HARNESS_REQUIRE_HARVEST_V2'] === '1') throw new Error(`harvest_v2.mjs がありません: ${HARVEST_V2}`);

let fixture: ImportedProjectFixture;
let learning = '';
let server: Server;
let origin = '';
beforeEach(async () => {
  fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
  learning = mkdtempSync(join(tmpdir(), 'harness-native-approve-home-'));
  // 学習フォルダは HARNESS_LEARNING_HOME が最優先。旧名も同じ一時フォルダへ向け、実際の学習フォルダへ書かない。
  vi.stubEnv('HARNESS_LEARNING_HOME', learning);
  vi.stubEnv('SUPERMOVIE_LEARNING_HOME', learning);
  server = createServer((req, res) => {
    void handleApi(req, res, new URL(req.url!, 'http://localhost'), fixture.root)
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  vi.unstubAllEnvs(); fixture.cleanup(); rmSync(learning, { recursive: true, force: true });
});

const getDiff = async (query: string) => fetch(`${origin}/api/learning/diff?${query}`);
const approve = async (body: unknown) => fetch(`${origin}/api/learning/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function candidates(): Promise<LearningDiffResponse> {
  const response = await getDiff(`id=case-a&job=${fixture.jobId}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<LearningDiffResponse>;
}
function telopOnly(diff: LearningDiffResponse): LearningApproveRequest {
  return { projectId: 'case-a', cut: [], words: [], telops: diff.telops!.filter((t) => t.kind === 'changed'), ses: [], ...diff.candidateKey! };
}
const jsonlLines = (name: string) => (existsSync(join(learning, name)) ? readFileSync(join(learning, name), 'utf8').trim().split('\n').filter(Boolean) : []);

describe('GET /api/learning/diff（新形式）', () => {
  it('job が無ければ 400、あれば書き出した文書との差分と照合キーを返す', async () => {
    expect((await getDiff('id=case-a')).status).toBe(400);
    const diff = await candidates();
    expect(diff.telops?.map((t) => t.kind)).toEqual(['changed', 'removed', 'added']);
    expect(diff.candidateKey).toEqual({ jobId: fixture.jobId, documentId: 'doc-a', contentHash: fixture.contentHash });
  });
  it('書き出しジョブが見つからなければ 404（パネルは出さず通知に残す側の失敗）', async () => {
    expect((await getDiff(`id=case-a&job=${'f'.repeat(32)}`)).status).toBe(404);
  });
});

describe('POST /api/learning/approve（新形式）', () => {
  it('照合キーが無い・一致しない・候補に無い項目を含む要求は 400 で、何も書かない', async () => {
    const diff = await candidates();
    const valid = telopOnly(diff);
    const { jobId: _jobId, ...withoutJob } = valid;
    expect((await approve(withoutJob)).status).toBe(400);
    expect((await approve({ ...valid, contentHash: 'a'.repeat(64) })).status).toBe(400);
    expect((await approve({ ...valid, telops: [{ ...valid.telops![0]!, after: '勝手に書き換えた本文' }] })).status).toBe(400);
    expect((await approve({ ...valid, words: [{ before: 'あ', after: 'い' }] })).status).toBe(400);
    expect(readdirSync(learning)).toEqual([]);
  });

  it('承認すると jsonl に1行・台帳に1件。2回目は記録済みとして 0 件（alreadyRecorded 1）', async () => {
    const diff = await candidates();
    const first = await approve(telopOnly(diff));
    expect(first.status).toBe(200);
    expect(await first.json() as LearningApproveResponse).toMatchObject({ recorded: { cut: 0, words: 0, telops: 1, ses: 0 }, alreadyRecorded: 0 });
    expect(jsonlLines('telop_feedback.jsonl').map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ videoId: 'case-a', kind: 'changed', before: 'ゆる素振り', after: 'ゆるい素振り' })]);
    const ledger = JSON.parse(readFileSync(join(learning, 'harvest_v2_state.json'), 'utf8'));
    expect(ledger).toEqual({ version: 1, projects: { 'doc-a': { videoId: 'case-a', projectDir: fixture.dir, harvestedAt: expect.any(String),
      documentRevision: 3, counts: { cut: {}, telop: { changed: 1 }, se: {} }, source: 'editor-panel' } } });
    const second = await approve(telopOnly(diff));
    expect(await second.json() as LearningApproveResponse).toMatchObject({ recorded: { telops: 0 }, alreadyRecorded: 1 });
    expect(jsonlLines('telop_feedback.jsonl')).toHaveLength(1);
  });

  it('0件の承認は何も書かない（台帳にも書かない）', async () => {
    const diff = await candidates();
    const response = await approve({ ...telopOnly(diff), telops: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: { cut: 0, words: 0, telops: 0, ses: 0 } });
    expect(readdirSync(learning)).toEqual([]);
  });

  it('無音カットだけの承認は学習の記録が無いので、取り出し済み台帳にも書かない', async () => {
    fixture.cleanup();
    fixture = await createImportedProject({ edit: (project) => { project.cutRegions = [...project.cutRegions, { start: 250, end: 270 }]; } });
    const diff = await candidates();
    // 存在検査: 候補は無音カット1件だけ（照合を通る本物の候補を承認している）。
    expect(diff.cut).toEqual([expect.objectContaining({ kind: 'added-cut', text: SILENT_CUT_TEXT })]);
    expect([...(diff.telops ?? []), ...(diff.ses ?? [])]).toEqual([]);
    const response = await approve({ projectId: 'case-a', cut: diff.cut, words: [], telops: [], ses: [], ...diff.candidateKey! });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: { cut: 0, words: 0, telops: 0, ses: 0 }, alreadyRecorded: 0 });
    expect(existsSync(join(learning, 'harvest_v2_state.json'))).toBe(false);
  });

  it('同じ要求の中で重複した項目は1件として数える（台帳の counts も alreadyRecorded も膨らまない）', async () => {
    const diff = await candidates();
    const valid = telopOnly(diff);
    const response = await approve({ ...valid, telops: [...valid.telops!, ...valid.telops!] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: { telops: 1 }, alreadyRecorded: 0 });
    expect(jsonlLines('telop_feedback.jsonl')).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(learning, 'harvest_v2_state.json'), 'utf8'));
    expect(ledger.projects['doc-a'].counts).toEqual({ cut: {}, telop: { changed: 1 }, se: {} });
  });

  it('台帳が壊れていても学習は成功のまま、ledgerError で理由を返す', async () => {
    writeFileSync(join(learning, 'harvest_v2_state.json'), '{broken');
    const response = await approve(telopOnly(await candidates()));
    expect(response.status).toBe(200);
    const body = await response.json() as LearningApproveResponse;
    expect(body.recorded?.telops).toBe(1);
    expect(body.ledgerError).toEqual(expect.any(String));
    expect(readFileSync(join(learning, 'harvest_v2_state.json'), 'utf8')).toBe('{broken');
  });

  it.skipIf(!existsSync(HARVEST_V2))('承認した案件は harvest_v2 が already-harvested で止まる（二重記録しない）', async () => {
    expect((await approve(telopOnly(await candidates()))).status).toBe(200);
    const output = JSON.parse(execFileSync(process.execPath, [HARVEST_V2, fixture.dir, '--learning-home', learning, '--dry-run'], { encoding: 'utf8' }));
    expect(output.status).toBe('already-harvested');
  });
});
