import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendCutFeedback, countUndistilledFeedback, loadCutRules, recordApprovedCutFeedback } from './cutStore';
import { recordApprovedTelopFeedback } from './telopStore';
import { recordApprovedSeFeedback } from './seStore';
import { cutFeedbackPath, cutRulesPath, distillStatePath } from './paths';
import type { CutFeedbackEntry } from './cutRules';
import type { TelopFeedbackEntry } from './telopRules';
import type { SeFeedbackEntry } from './seRules';

const telopEntry = (
  before: string,
  after: string,
  opts: { videoId?: string } = {},
): TelopFeedbackEntry => ({
  videoId: opts.videoId ?? 'v1',
  timestamp: '2026-07-16T00:00:00Z',
  kind: 'changed',
  before,
  after,
});

const seEntry = (
  seFile: string,
  contextText: string,
  opts: { videoId?: string } = {},
): SeFeedbackEntry => ({
  videoId: opts.videoId ?? 'v1',
  timestamp: '2026-07-16T00:00:00Z',
  kind: 'added',
  seFile,
  contextText,
});

const entry = (
  text: string,
  opts: { kind?: 'added-cut' | 'restored-cut'; videoId?: string; timestamp?: string } = {},
): CutFeedbackEntry => ({
  videoId: opts.videoId ?? 'v1',
  timestamp: opts.timestamp ?? '2026-07-03T00:00:00Z',
  kind: opts.kind ?? 'added-cut',
  startFrame: 0,
  endFrame: 10,
  text,
});

describe('cutStore', () => {
  beforeEach(() => { process.env.HARNESS_LEARNING_HOME = mkdtempSync(join(tmpdir(), 'sme-learn-')); });
  afterEach(() => { delete process.env.HARNESS_LEARNING_HOME; });

  it('recordApprovedCutFeedback は jsonl 追記と cut_rules.json 更新を行う（異なる動画で2回観測）', () => {
    recordApprovedCutFeedback([entry('えーと', { videoId: 'v1' })]);
    const rules = recordApprovedCutFeedback([entry('えーと', { videoId: 'v2' })]);
    expect(rules.rules).toEqual([{ text: 'えーと', action: 'cut' }]);
    expect(readFileSync(cutFeedbackPath(), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(readFileSync(cutRulesPath(), 'utf8')).rules).toHaveLength(1);
  });

  it('cut_rules.json が壊れていても空から再構築する', () => {
    recordApprovedCutFeedback([entry('えーと')]);
    writeFileSync(cutRulesPath(), '{broken');
    expect(loadCutRules().rules).toEqual([]);
  });

  it('countUndistilledFeedback は総行数から consumedLines を引く', () => {
    recordApprovedCutFeedback([entry('a', { videoId: 'v1' }), entry('b', { videoId: 'v1' }), entry('c', { videoId: 'v1' })]);
    expect(countUndistilledFeedback()).toBe(3);
    writeFileSync(distillStatePath(), JSON.stringify({ consumedLines: 2 }));
    expect(countUndistilledFeedback()).toBe(1);
  });

  it('旧形式 { consumedLines } は cut の消費分として読む（telop/se は 0 扱い）', () => {
    recordApprovedCutFeedback([entry('a', { videoId: 'v1' })]);
    recordApprovedTelopFeedback([telopEntry('X', 'Y', { videoId: 'v1' })]);
    writeFileSync(distillStatePath(), JSON.stringify({ consumedLines: 1 }));
    // cut: 1行-1消費=0 / telop: 1行-0消費=1 / se: 0
    expect(countUndistilledFeedback()).toBe(1);
  });

  it('countUndistilledFeedback は cut/telop/se の未消化件数を合算する', () => {
    recordApprovedCutFeedback([entry('a', { videoId: 'v1' })]);
    recordApprovedTelopFeedback([telopEntry('X', 'Y', { videoId: 'v1' }), telopEntry('P', 'Q', { videoId: 'v1' })]);
    recordApprovedSeFeedback([seEntry('a.mp3', '文脈', { videoId: 'v1' })]);
    expect(countUndistilledFeedback()).toBe(4);
    writeFileSync(
      distillStatePath(),
      JSON.stringify({ cutConsumedLines: 1, telopConsumedLines: 1, seConsumedLines: 0 }),
    );
    expect(countUndistilledFeedback()).toBe(2);
  });

  it('addedVideos/restoredVideos が欠けた旧形式の cut_rules.json も defensively 読み込める', () => {
    writeFileSync(
      cutRulesPath(),
      JSON.stringify({
        schemaVersion: 1,
        rules: [],
        conflicts: [],
        meta: { observations: { 'えー': { added: 1, restored: 0 } }, lastSeen: {} },
      }),
    );
    const loaded = loadCutRules();
    expect(loaded.meta.observations['えー']).toEqual({
      added: 1,
      restored: 0,
      addedVideos: [],
      restoredVideos: [],
    });
  });

  it('同一フィードバック（videoId/kind/startFrame/endFrame/text 一致）を二重記録しても jsonl は1行のまま', () => {
    appendCutFeedback([entry('えー', { videoId: 'v1', timestamp: 't1' })]);
    appendCutFeedback([entry('えー', { videoId: 'v1', timestamp: 't2' })]);
    const lines = readFileSync(cutFeedbackPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(countUndistilledFeedback()).toBe(1);
  });

  it('同一バッチ内に完全同一の entry が複数あっても jsonl は1行のまま', () => {
    appendCutFeedback([
      entry('えー', { videoId: 'v1', timestamp: 't1' }),
      entry('えー', { videoId: 'v1', timestamp: 't2' }),
    ]);
    const lines = readFileSync(cutFeedbackPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(countUndistilledFeedback()).toBe(1);
  });
});
