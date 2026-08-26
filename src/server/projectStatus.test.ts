import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MAX_STATUS_FILE_BYTES,
  autoStatusFromSteps,
  resolveStatus,
  readStatusFile,
  resolveProjectStatus,
  writeStatusStage,
  validateStatusRequest,
} from './projectStatus';
import { resolveProjectSteps } from './projectSteps';
import { DISPLAY_STATUSES } from '../shared/projectStage';
import type { ProjectSteps } from '../shared/types';

/** 工程ステッパーの判定結果を組み立てるテストヘルパー（既定は全工程未完了）。 */
function steps(partial: Partial<ProjectSteps>): ProjectSteps {
  return {
    transcribe: false,
    cut: false,
    telop: 'empty',
    audio: false,
    rendered: false,
    ...partial,
  };
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-09T12:00:00Z');

describe('autoStatusFromSteps（工程からの自動判定＝最初の未完了工程）', () => {
  it('out/video.mp4 あり → rendered（工程の完了状況によらず最優先）', () => {
    expect(autoStatusFromSteps(steps({ rendered: true }))).toBe('rendered');
  });

  it('どの工程にも未着手 → idle', () => {
    expect(autoStatusFromSteps(steps({}))).toBe('idle');
  });

  it('文字起こし未・ほかは着手済み → transcribe（最初の未完了工程）', () => {
    expect(autoStatusFromSteps(steps({ cut: true, telop: 'nonempty', audio: true }))).toBe(
      'transcribe',
    );
  });

  it('文字起こし済み・カット未 → cut', () => {
    expect(autoStatusFromSteps(steps({ transcribe: true }))).toBe('cut');
  });

  it('カットまで済み・テロップ空 → telop', () => {
    expect(autoStatusFromSteps(steps({ transcribe: true, cut: true }))).toBe('telop');
  });

  it('テロップが invalid（判定不能）は未完了扱い → telop', () => {
    expect(
      autoStatusFromSteps(steps({ transcribe: true, cut: true, telop: 'invalid' })),
    ).toBe('telop');
  });

  it('テロップまで済み・SE/BGM 未 → audio', () => {
    expect(
      autoStatusFromSteps(steps({ transcribe: true, cut: true, telop: 'nonempty' })),
    ).toBe('audio');
  });

  it('全工程済みでも未書き出しなら最後の編集工程 audio に留まる', () => {
    expect(
      autoStatusFromSteps(
        steps({ transcribe: true, cut: true, telop: 'nonempty', audio: true }),
      ),
    ).toBe('audio');
  });
});

describe('resolveStatus（純関数・優先順位）', () => {
  it('自動判定は autoStatusFromSteps に従う', () => {
    const r = resolveStatus({
      steps: steps({ transcribe: true }),
      stage: null,
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('cut');
  });

  it('手動 stage は自動判定より優先（rendered でも telop を表示）', () => {
    const r = resolveStatus({
      steps: steps({ rendered: true }),
      stage: 'telop',
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('telop');
    expect(r.stageManual).toBe(true);
  });

  it('手動 stage は idle より優先', () => {
    const r = resolveStatus({
      steps: steps({}),
      stage: 'audio',
      activity: null,
      now: NOW,
    });
    expect(r.status).toBe('audio');
  });

  it('activity は付加フィールドで返る（status は stage/自動判定のまま）', () => {
    const startedAt = new Date(NOW - 10 * 60 * 1000).toISOString();
    const r = resolveStatus({
      steps: steps({ transcribe: true }),
      stage: null,
      activity: { label: 'カット中', startedAt },
      now: NOW,
    });
    expect(r.status).toBe('cut');
    expect(r.activityLabel).toBe('カット中');
    expect(r.activityStartedAt).toBe(startedAt);
    expect(r.activityStale).toBe(false);
  });

  it('activity が 2 時間超経過 → stale', () => {
    const startedAt = new Date(NOW - 3 * HOUR).toISOString();
    const r = resolveStatus({
      steps: steps({ transcribe: true }),
      stage: null,
      activity: { label: 'テロップ挿入中', startedAt },
      now: NOW,
    });
    expect(r.activityStale).toBe(true);
  });

  it('activity の startedAt が壊れていても落ちず stale=false', () => {
    const r = resolveStatus({
      steps: steps({}),
      stage: null,
      activity: { label: '作業中', startedAt: 'not-a-date' },
      now: NOW,
    });
    expect(r.activityLabel).toBe('作業中');
    expect(r.activityStale).toBe(false);
  });

  it('activity なしなら activity 系フィールドは undefined', () => {
    const r = resolveStatus({ steps: steps({}), stage: null, activity: null, now: NOW });
    expect(r.activityLabel).toBeUndefined();
    expect(r.activityStartedAt).toBeUndefined();
    expect(r.activityStale).toBeUndefined();
  });

  it('stage 未設定（自動判定）では stageManual を立てない', () => {
    const r = resolveStatus({
      steps: steps({ transcribe: true }),
      stage: null,
      activity: null,
      now: NOW,
    });
    expect(r.stageManual).toBeUndefined();
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
        stage: 'telop',
        activity: { label: 'カット中', startedAt: '2026-07-09T10:00:00Z' },
      }),
    );
    expect(readStatusFile(dir)).toEqual({
      stage: 'telop',
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

  it('status.json の stage=cut を読める（全6値）', () => {
    writeStatus(JSON.stringify({ stage: 'cut' }));
    expect(readStatusFile(dir).stage).toBe('cut');
  });

  it('旧バージョンの stage（editing/review/published）は未知値として自動判定へ落ちる', () => {
    for (const legacy of ['editing', 'review', 'published']) {
      writeStatus(JSON.stringify({ stage: legacy }));
      expect(readStatusFile(dir).stage).toBe(null);
    }
  });

  it('サイズ上限を超える status.json は読まずフォールバックする', () => {
    writeStatus(' '.repeat(MAX_STATUS_FILE_BYTES + 1));
    expect(readStatusFile(dir)).toEqual({ stage: null, activity: null });
  });

  // FIFO は statSync().size が 0 でサイズ上限を素通りし、readFileSync が書き手を待って
  // 恒久ブロックする。scanProjects→resolveProjectStatus 経由で一覧 API と SSE が固まるため、
  // projectSteps / scanProjects と同じく通常ファイル以外は読まない。
  it.skipIf(process.platform === 'win32')(
    '通常ファイルでない status.json（FIFO）はハングせずフォールバックする',
    { timeout: 5_000 },
    () => {
      mkdirSync(join(dir, '.sme'), { recursive: true });
      execFileSync('mkfifo', [join(dir, '.sme', 'status.json')]);
      expect(readStatusFile(dir)).toEqual({ stage: null, activity: null });
    },
  );
});

describe('resolveProjectStatus（IO統合）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sme-projstatus-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 実 IO で工程を解決してからステータスを解決する（本番 scanProjects と同じ経路）。 */
  function resolve(): ReturnType<typeof resolveProjectStatus> {
    return resolveProjectStatus(dir, resolveProjectSteps(dir), NOW);
  }

  it('新規プロジェクト（データファイルなし） → idle・lastEditedAt undefined', () => {
    const r = resolve();
    expect(r.status).toBe('idle');
    expect(r.lastEditedAt).toBeUndefined();
  });

  it('cutData があれば「文字起こしが未」→ transcribe・lastEditedAt に mtime', () => {
    writeFileSync(join(dir, 'cutData.ts'), 'export const cutData = [];');
    const r = resolve();
    expect(r.status).toBe('transcribe');
    expect(typeof r.lastEditedAt).toBe('number');
  });

  it('中身のある transcript.json のみ → 次の未完了工程 cut', () => {
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ segments: [{ text: 'あ' }] }));
    expect(resolve().status).toBe('cut');
  });

  it('空の transcript.json（新規作成が置く雛形）は idle のまま', () => {
    // createProject は文字起こし前でも開けるよう空の transcript.json を必ず置く。
    // 存在だけで済判定にすると、作った瞬間に「カット」列へ並んでしまう。
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify({ engine: 'none', words: [], segments: [] }),
    );
    expect(resolve().status).toBe('idle');
  });

  it('out/video.mp4 があれば rendered', () => {
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'video.mp4'), 'x');
    expect(resolve().status).toBe('rendered');
  });

  it('空の telopData のみは着手とみなさない（idle）', () => {
    mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
    writeFileSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'), 'export const telopData = [];');
    const r = resolve();
    expect(r.status).toBe('idle');
    // telopData は lastEditedAt には算入する
    expect(typeof r.lastEditedAt).toBe('number');
  });

  it('旧 stage（review）が残った status.json は自動判定へ落ちる（後方互換）', () => {
    mkdirSync(join(dir, '.sme'), { recursive: true });
    writeFileSync(join(dir, '.sme', 'status.json'), JSON.stringify({ stage: 'review' }));
    const r = resolve();
    expect(r.status).toBe('idle');
    expect(r.stageManual).toBeUndefined();
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
    writeStatusStage(dir, 'telop');
    expect(existsSync(join(dir, '.sme', 'status.json'))).toBe(true);
    expect(readStatusFile(dir).stage).toBe('telop');
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
    writeStatusStage(dir, 'audio');
    const after = readStatusFile(dir);
    expect(after.stage).toBe('audio');
    expect(after.activity).toEqual({ label: 'カット中', startedAt: '2026-07-09T10:00:00Z' });
  });

  it('stage=null で自動判定に戻す（activity 保持）', () => {
    mkdirSync(join(dir, '.sme'), { recursive: true });
    writeFileSync(
      join(dir, '.sme', 'status.json'),
      JSON.stringify({ stage: 'telop', activity: { label: 'x', startedAt: '2026-07-09T10:00:00Z' } }),
    );
    writeStatusStage(dir, null);
    const raw = JSON.parse(readFileSync(join(dir, '.sme', 'status.json'), 'utf8'));
    expect(raw.stage).toBe(null);
    expect(raw.activity).toEqual({ label: 'x', startedAt: '2026-07-09T10:00:00Z' });
  });
});

describe('validateStatusRequest', () => {
  it('正常な body を受理', () => {
    expect(validateStatusRequest({ id: 'p1', stage: 'telop' })).toEqual({ id: 'p1', stage: 'telop' });
    expect(validateStatusRequest({ id: 'p1', stage: null })).toEqual({ id: 'p1', stage: null });
  });
  it('id が無い → 400', () => {
    expect(() => validateStatusRequest({ stage: 'telop' })).toThrow();
  });
  it('stage が不正値 → 400', () => {
    expect(() => validateStatusRequest({ id: 'p1', stage: 'bogus' })).toThrow();
  });
  it('body が非オブジェクト → 400', () => {
    expect(() => validateStatusRequest(null)).toThrow();
  });
});

describe('validateStatusRequest（表示ステータス全値を受理）', () => {
  // 値の列挙は正本（shared/projectStage）から派生させる。ここに直書きすると
  // 正本へ工程を足した時にテストだけ取り残される。
  it.each(DISPLAY_STATUSES)(
    'stage=%s を受理する',
    (stage) => {
      expect(validateStatusRequest({ id: 'p', stage })).toEqual({ id: 'p', stage });
    },
  );
  it('stage=null を受理する', () => {
    expect(validateStatusRequest({ id: 'p', stage: null })).toEqual({ id: 'p', stage: null });
  });
  it('未知の stage は 400', () => {
    expect(() => validateStatusRequest({ id: 'p', stage: 'draft' })).toThrowError(/stage/);
  });
  it('廃止した旧 stage（review/published/editing）は 400', () => {
    for (const legacy of ['review', 'published', 'editing']) {
      expect(() => validateStatusRequest({ id: 'p', stage: legacy })).toThrowError(/stage/);
    }
  });
});
