import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceDocument } from '../../core/sequence/model';
import type { ScenePlan } from '../../core/sequence/scenePlan';
import type { ExportRunInput } from './exportRunner';
import type { SequenceSessionState } from './service';

// Count what /export/input and /export/asset cost per request: both read job.plan.
const counts = vi.hoisted(() => ({ plans: 0 }));
vi.mock('../../core/sequence/scenePlan', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/sequence/scenePlan')>();
  class CountedScenePlan extends actual.ScenePlan {
    constructor(...args: ConstructorParameters<typeof actual.ScenePlan>) { super(...args); counts.plans++; }
  }
  return { ...actual, ScenePlan: CountedScenePlan };
});
vi.mock('./exportRecords', async importOriginal => {
  const actual = await importOriginal<typeof import('./exportRecords')>();
  return { ...actual, readExportInput: vi.fn(actual.readExportInput) };
});
const { SequenceExports } = await import('./exports');
const { readExportInput, readExportRecord } = await import('./exportRecords');
const reads = () => vi.mocked(readExportInput).mock.calls.length;

async function complete(input: ExportRunInput) {
  await writeFile(join(input.directory, 'output.mp4'), Buffer.from('verified-output-fixture'));
  await writeFile(join(input.directory, 'verification.json'), JSON.stringify({ revision: input.status.revision, contentHash: input.status.contentHash, settings: input.settings, outputResolution: input.status.outputResolution }));
}
function state(): SequenceSessionState {
  const doc: SequenceDocument = { schemaVersion: 2, id: 'export', name: '書き出し', revision: 3, fps: { num: 30, den: 1 }, resolution: { width: 320, height: 180 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
  return { sessionId: 'session', document: doc, savedRevision: 3, savedContentHash: 'saved', dirty: false, canUndo: false, canRedo: false };
}
const request = (executionId: string) => ({ sessionId: 'session', expectedRevision: 3, executionId });
function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; }

it('serves the running export from the plan it started with, without rereading input.json or rebuilding the plan per request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-export-shared-plan-')), barrier = gate(), inputs: ExportRunInput[] = [];
  const jobs = new SequenceExports(async input => { inputs.push(input); await barrier.wait; await complete(input); });
  try {
    const started = jobs.start(directory, 'case', 'http://127.0.0.1', request('shared'), state);
    const runnerPlan: ScenePlan = inputs[0]!.plan, beforeReads = reads(), beforePlans = counts.plans;
    for (let i = 0; i < 50; i++) {
      // The route handlers do exactly this for every /export/input and /export/asset request.
      const job = jobs.job(directory, started.id);
      expect(job.plan).toBe(runnerPlan);
      expect(job.plan.document.assets).toEqual([]);
    }
    expect(reads() - beforeReads).toBe(0);
    expect(counts.plans - beforePlans).toBe(0);
    barrier.open(); await jobs.job(directory, started.id).completion;
    expect(jobs.job(directory, started.id).status.phase).toBe('complete');
  } finally { barrier.open(); await rm(directory, { recursive: true, force: true }); }
});

it('reads a finished export from disk again, after completion and after a restart, and drops the running plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-export-plan-after-')), barrier = gate(), inputs: ExportRunInput[] = [];
  const jobs = new SequenceExports(async input => { inputs.push(input); await barrier.wait; await complete(input); });
  try {
    const started = jobs.start(directory, 'case', 'http://127.0.0.1', request('after'), state);
    const held = jobs.job(directory, started.id), runnerPlan = inputs[0]!.plan;
    expect(held.plan).toBe(runnerPlan);
    barrier.open(); await held.completion;
    expect(held.status.phase).toBe('complete');
    let before = reads();
    expect(held.plan).not.toBe(runnerPlan); // The finished job no longer keeps the running plan.
    expect(held.plan.document).toEqual(runnerPlan.document);
    expect(reads() - before).toBe(2);
    before = reads();
    expect(jobs.job(directory, started.id).plan.document).toEqual(runnerPlan.document);
    expect(new SequenceExports().job(directory, started.id).plan.document).toEqual(runnerPlan.document);
    expect(reads() - before).toBe(2);
  } finally { barrier.open(); await rm(directory, { recursive: true, force: true }); }
});

it('drops the running plan when an export fails or is cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-export-plan-ended-')), inputs: ExportRunInput[] = [];
  const jobs = new SequenceExports(async input => {
    inputs.push(input);
    if (input.status.executionId === 'fails') throw new Error('描画に失敗しました');
    await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
  });
  try {
    const failed = jobs.start(directory, 'case', 'http://127.0.0.1', request('fails'), state), failedJob = jobs.job(directory, failed.id);
    await failedJob.completion;
    expect(failedJob.status).toMatchObject({ phase: 'failed', error: '描画に失敗しました' });
    expect(failedJob.plan).not.toBe(inputs[0]!.plan);
    const cancelled = jobs.start(directory, 'case', 'http://127.0.0.1', request('cancels'), state), cancelledJob = jobs.job(directory, cancelled.id);
    expect(cancelledJob.plan).toBe(inputs[1]!.plan);
    jobs.cancel(directory, cancelled.id); await cancelledJob.completion;
    expect(cancelledJob.status.phase).toBe('cancelled');
    expect(cancelledJob.plan).not.toBe(inputs[1]!.plan);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('drops the running plan even when the final record cannot be saved and the job stays tracked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-export-plan-storage-')), inputs: ExportRunInput[] = [];
  const jobs = new SequenceExports(async input => {
    inputs.push(input); await complete(input);
    await rm(join(input.directory, 'manifest.json')); await mkdir(join(input.directory, 'manifest.json'));
  });
  try {
    const started = jobs.start(directory, 'case', 'http://127.0.0.1', request('storage'), state), held = jobs.job(directory, started.id);
    await held.completion;
    const tracked = jobs.job(directory, started.id);
    expect(tracked).toBe(held); // Still in memory: the storage error keeps it.
    expect(tracked.status.error).toContain('記録を保存できません');
    expect(tracked.plan).not.toBe(inputs[0]!.plan);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('does not publish the output when the saved input changed while rendering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-export-plan-tamper-'));
  const jobs = new SequenceExports(async input => {
    await complete(input);
    // Another process rewrites the frozen input after rendering began.
    const file = join(input.directory, 'input.json'), document = JSON.parse(await readFile(file, 'utf8'));
    document.background = '#ffffff'; await writeFile(file, JSON.stringify(document));
  });
  try {
    const started = jobs.start(directory, 'case', 'http://127.0.0.1', request('tamper'), state), job = jobs.job(directory, started.id);
    await job.completion;
    expect(job.status).toMatchObject({ phase: 'failed', error: '書き出し開始時の入力が変更されています' });
    expect(job.status.downloadUrl).toBeUndefined();
    const saved = readExportRecord(directory, started.id);
    expect(saved.status.phase).toBe('failed'); expect(saved.output).toBeUndefined();
    expect(existsSync(join(directory, '.harness', 'last-export.json'))).toBe(false);
    await expect(jobs.download(directory, started.id)).rejects.toThrow(/完了していません/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
