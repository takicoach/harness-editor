import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSeFeedback, loadSeRules, recordApprovedSeFeedback } from './seStore';
import { seFeedbackPath, seRulesPath } from './paths';
import type { SeFeedbackEntry } from './seRules';

const entry = (
  seFile: string,
  contextText: string,
  opts: { kind?: 'added' | 'removed'; videoId?: string; timestamp?: string } = {},
): SeFeedbackEntry => ({
  videoId: opts.videoId ?? 'v1',
  timestamp: opts.timestamp ?? '2026-07-16T00:00:00Z',
  kind: opts.kind ?? 'added',
  seFile,
  contextText,
});

describe('seStore', () => {
  beforeEach(() => { process.env.SUPERMOVIE_LEARNING_HOME = mkdtempSync(join(tmpdir(), 'sme-learn-')); });
  afterEach(() => { delete process.env.SUPERMOVIE_LEARNING_HOME; });

  it('recordApprovedSeFeedback は jsonl 追記と se_rules.json 更新を行う（異なる動画で2回観測）', () => {
    recordApprovedSeFeedback([entry('whoosh.mp3', 'ここで素振り', { videoId: 'v1' })]);
    const rules = recordApprovedSeFeedback([entry('whoosh.mp3', 'ここで素振り', { videoId: 'v2' })]);
    expect(rules.rules).toEqual([{ seFile: 'whoosh.mp3', contextText: 'ここで素振り', action: 'add' }]);
    expect(readFileSync(seFeedbackPath(), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(readFileSync(seRulesPath(), 'utf8')).rules).toHaveLength(1);
  });

  it('se_rules.json が壊れていても空から再構築する', () => {
    recordApprovedSeFeedback([entry('a.mp3', '文脈')]);
    writeFileSync(seRulesPath(), '{broken');
    expect(loadSeRules().rules).toEqual([]);
  });

  it('同一フィードバックを二重記録しても jsonl は1行のまま', () => {
    appendSeFeedback([entry('a.mp3', '文脈', { videoId: 'v1', timestamp: 't1' })]);
    appendSeFeedback([entry('a.mp3', '文脈', { videoId: 'v1', timestamp: 't2' })]);
    const lines = readFileSync(seFeedbackPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});
