import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendTelopFeedback, loadTelopRules, recordApprovedTelopFeedback } from './telopStore';
import { telopFeedbackPath, telopRulesPath } from './paths';
import type { TelopFeedbackEntry } from './telopRules';

const entry = (
  before: string,
  after: string,
  opts: { kind?: TelopFeedbackEntry['kind']; videoId?: string; timestamp?: string } = {},
): TelopFeedbackEntry => ({
  videoId: opts.videoId ?? 'v1',
  timestamp: opts.timestamp ?? '2026-07-16T00:00:00Z',
  kind: opts.kind ?? 'changed',
  before,
  after,
});

describe('telopStore', () => {
  beforeEach(() => { process.env.HARNESS_LEARNING_HOME = mkdtempSync(join(tmpdir(), 'sme-learn-')); });
  afterEach(() => { delete process.env.HARNESS_LEARNING_HOME; });

  it('recordApprovedTelopFeedback は jsonl 追記と telop_rules.json 更新を行う（異なる動画で2回観測）', () => {
    recordApprovedTelopFeedback([entry('素振りする', '素振りをする', { videoId: 'v1' })]);
    const rules = recordApprovedTelopFeedback([entry('素振りする', '素振りをする', { videoId: 'v2' })]);
    expect(rules.rules).toEqual([{ before: '素振りする', after: '素振りをする' }]);
    expect(readFileSync(telopFeedbackPath(), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(readFileSync(telopRulesPath(), 'utf8')).rules).toHaveLength(1);
  });

  it('telop_rules.json が壊れていても空から再構築する', () => {
    recordApprovedTelopFeedback([entry('A', 'B')]);
    writeFileSync(telopRulesPath(), '{broken');
    expect(loadTelopRules().rules).toEqual([]);
  });

  it('同一フィードバック（videoId/kind/before/after 一致）を二重記録しても jsonl は1行のまま', () => {
    appendTelopFeedback([entry('A', 'B', { videoId: 'v1', timestamp: 't1' })]);
    appendTelopFeedback([entry('A', 'B', { videoId: 'v1', timestamp: 't2' })]);
    const lines = readFileSync(telopFeedbackPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});
