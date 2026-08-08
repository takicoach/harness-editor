import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveStatus,
  readStatusFile,
  resolveProjectStatus,
  writeStatusStage,
  validateStatusRequest,
} from './projectStatus';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-09T12:00:00Z');

describe('resolveStatus（純関数・優先順位）', () => {
  it('out/video.mp4 あり → rendered（自動判定）', () => {
    const r = resolveStatus({
      hasRenderedOutput: true,
      hasEditData: true,
      stage: null,
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('rendered');
  });

  it('編集ファイルあり・出力なし → editing', () => {
    const r = resolveStatus({
      hasRenderedOutput: false,
      hasEditData: true,
      stage: null,
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('editing');
  });

  it('どちらもなし → idle', () => {
    const r = resolveStatus({
      hasRenderedOutput: false,
      hasEditData: false,
      stage: null,
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('idle');
  });

  it('stage は自動判定より優先（rendered でも review を表示）', () => {
    const r = resolveStatus({
      hasRenderedOutput: true,
      hasEditData: true,
      stage: 'review',
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('review');
  });

  it('stage published は idle より優先', () => {
    const r = resolveStatus({
      hasRenderedOutput: false,
      hasEditData: false,
      stage: 'published',
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('published');
  });

  it('activity は付加フィールドで返る（status は stage/自動判定のまま）', () => {
    const startedAt = new Date(NOW - 10 * 60 * 1000).toISOString();
    const r = resolveStatus({
      hasRenderedOutput: false,
      hasEditData: true,
      stage: null,
      activity: { label: 'カット中', startedAt },
      now: NOW,
    });
    expect(r.status).toBe('editing');
    expect(r.activityLabel).toBe('カット中');
    expect(r.activityStartedAt).toBe(startedAt);
    expect(r.activityStale).toBe(false);
  });

  it('activity が 2 時間超経過 → stale', () => {
    const startedAt = new Date(NOW - 3 * HOUR).toISOString();
    const r = resolveStatus({
      hasRenderedOutput: false,
      hasEditData: true,
      stage: null,
      activity: { label: 'テロップ挿入中', startedAt },
      now: NOW,
    });
    expect(r.activityStale).toBe(true);
  });

  it('activity の startedAt が壊れていても落ちず stale=false', () => {
    const r = resolveStatus({
      hasRenderedOutput: false,
      hasEditData: false,
      stage: null,
      activity: { label: '作業中', startedAt: 'not-a-date' },
      now: NOW,
    });
    expect(r.activityLabel).toBe('作業中');
    expect(r.activityStale).toBe(false);
  });

  it('activity なしなら activity 系フィールドは undefined', () => {
    const r = resolveStatus({
      hasRenderedOutput: false,
      hasEditData: false,
      stage: null,
      activity: null,
      now: NOW,
    });
    expect(r.activityLabel).toBeUndefined();
    expect(r.activityStartedAt).toBeUndefined();
    expect(r.activityStale).toBeUndefined();
  });
});

describe('readStatusFile（.sme/status.json 読み取り）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sme-status-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeStatus(content: string): void {
    mkdirSync(join(dir, '.sme'), { recursive: true });
    writeFileSync(join(dir, '.sme', 'status.json'), content);
  }

  it('ファイルなし → { stage: null, activity: null }', () => {
    expect(readStatusFile(dir)).toEqual({ stage: null, activity: null });
  });

  it('正常な stage + activity を読む', () => {
    writeStatus(
      JSON.stringify({
        stage: 'review',
        activity: { label: 'カット中', startedAt: '2026-07-09T10:00:00Z' },
      }),
    );
    expect(readStatusFile(dir)).toEqual({
      stage: 'review',
      activity: { label: 'カット中', startedAt: '2026-07-09T10:00:00Z' },
    });
  });

  it('壊れた JSON → フォールバック（落ちない）', () => {
    writeStatus('{ this is not json');
    expect(readStatusFile(dir)).toEqual({ stage: null, activity: null });
  });

  it('未知フィールドは無視、stage の不正値は null 扱い', () => {
    writeStatus(JSON.stringify({ stage: 'bogus', foo: 123, activity: null }));
    expect(readStatusFile(dir)).toEqual({ stage: null, activity: null });
  });

  it('activity の label/startedAt が欠けていれば activity=null', () => {
    writeStatus(JSON.stringify({ stage: null, activity: { label: 'x' } }));
    expect(readStatusFile(dir)).toEqual({ stage: null, activity: null });
  });
});

describe('resolveProjectStatus（IO統合）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sme-projstatus-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('新規プロジェクト（データファイルなし） → idle・lastEditedAt undefined', () => {
    const r = resolveProjectStatus(dir, NOW);
    expect(r.status).toBe('idle');
    expect(r.lastEditedAt).toBeUndefined();
  });

  it('cutData があれば editing・lastEditedAt に mtime', () => {
    writeFileSync(join(dir, 'cutData.ts'), 'export const cutData = [];');
    const r = resolveProjectStatus(dir, NOW);
    expect(r.status).toBe('editing');
    expect(typeof r.lastEditedAt).toBe('number');
  });

  it('out/video.mp4 があれば rendered', () => {
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'video.mp4'), 'x');
    const r = resolveProjectStatus(dir, NOW);
    expect(r.status).toBe('rendered');
  });

  it('telopData のみは editing とみなさない（idle）', () => {
    mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
    writeFileSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'), 'export const telopData = [];');
    const r = resolveProjectStatus(dir, NOW);
    expect(r.status).toBe('idle');
    // telopData は lastEditedAt には算入する
    expect(typeof r.lastEditedAt).toBe('number');
  });
});

describe('writeStatusStage（stage のみ更新・activity 保持）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sme-writestage-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('.sme が無くても作成して書き込む', () => {
    writeStatusStage(dir, 'review');
    expect(existsSync(join(dir, '.sme', 'status.json'))).toBe(true);
    expect(readStatusFile(dir).stage).toBe('review');
  });

  it('既存 activity を保持したまま stage を更新', () => {
    mkdirSync(join(dir, '.sme'), { recursive: true });
    writeFileSync(
      join(dir, '.sme', 'status.json'),
      JSON.stringify({
        stage: null,
        activity: { label: 'カット中', startedAt: '2026-07-09T10:00:00Z' },
      }),
    );
    writeStatusStage(dir, 'published');
    const after = readStatusFile(dir);
    expect(after.stage).toBe('published');
    expect(after.activity).toEqual({ label: 'カット中', startedAt: '2026-07-09T10:00:00Z' });
  });

  it('stage=null で自動判定に戻す（activity 保持）', () => {
    mkdirSync(join(dir, '.sme'), { recursive: true });
    writeFileSync(
      join(dir, '.sme', 'status.json'),
      JSON.stringify({ stage: 'review', activity: { label: 'x', startedAt: '2026-07-09T10:00:00Z' } }),
    );
    writeStatusStage(dir, null);
    const raw = JSON.parse(readFileSync(join(dir, '.sme', 'status.json'), 'utf8'));
    expect(raw.stage).toBe(null);
    expect(raw.activity).toEqual({ label: 'x', startedAt: '2026-07-09T10:00:00Z' });
  });
});

describe('validateStatusRequest', () => {
  it('正常な body を受理', () => {
    expect(validateStatusRequest({ id: 'p1', stage: 'review' })).toEqual({ id: 'p1', stage: 'review' });
    expect(validateStatusRequest({ id: 'p1', stage: null })).toEqual({ id: 'p1', stage: null });
  });
  it('id が無い → 400', () => {
    expect(() => validateStatusRequest({ stage: 'review' })).toThrow();
  });
  it('stage が不正値 → 400', () => {
    expect(() => validateStatusRequest({ id: 'p1', stage: 'bogus' })).toThrow();
  });
  it('body が非オブジェクト → 400', () => {
    expect(() => validateStatusRequest(null)).toThrow();
  });
});
