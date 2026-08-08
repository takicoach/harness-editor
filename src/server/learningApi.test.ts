import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLearningDiff, handleLearningApprove, handleLearningStatus } from './learningApi';
import { loadStore, saveStore, promoteWordRules } from '../learning';
import type { LearningApproveRequest } from '../shared/types';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const SAMPLE = join(__dirname, '__fixtures__', 'sample-project');

/** sample-project を一時ディレクトリへ複製して返す。 */
function copySampleProject(): string {
  const dir = tempDir('sme-learnapi-proj-');
  cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}

let prevLearningHome: string | undefined;
beforeEach(() => {
  prevLearningHome = process.env.HARNESS_LEARNING_HOME;
  process.env.HARNESS_LEARNING_HOME = tempDir('sme-learnapi-home-');
});
afterEach(() => {
  if (prevLearningHome === undefined) delete process.env.HARNESS_LEARNING_HOME;
  else process.env.HARNESS_LEARNING_HOME = prevLearningHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('handleLearningDiff', () => {
  it('①baseline ありで added/restored がテキスト付きで返る', () => {
    const dir = copySampleProject();
    // fps=60。cutData の残す区間を [0,50],[70,12000] にして final カット区間 = [50,70]。
    writeFileSync(
      join(dir, 'src', 'cutData.ts'),
      `export const cutData: {
  id: number; originalStart: number; originalEnd: number; playbackStart: number; playbackEnd: number;
}[] = [
  { id: 1, originalStart: 0, originalEnd: 50, playbackStart: 0, playbackEnd: 50 },
  { id: 2, originalStart: 70, originalEnd: 12000, playbackStart: 50, playbackEnd: 11930 },
];
`,
    );
    // baseline の自動カット区間を [100,130] にして restored = [100,130]。
    const baseline = JSON.parse(readFileSync(join(dir, 'cut-baseline.json'), 'utf8'));
    baseline.autoCutRegions = [{ start: 100, end: 130 }];
    writeFileSync(join(dir, 'cut-baseline.json'), JSON.stringify(baseline, null, 2));
    // 「えー」は frame 60..66（区間 [50,70] 内）、「あの」は frame 120..126（区間 [100,130] 内）。
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify({
        engine: 'mlx-whisper',
        language: 'ja',
        duration_ms: 200000,
        words: [
          { text: 'えー', start: 1000, end: 1100, confidence: 0.9 },
          { text: 'あの', start: 2000, end: 2100, confidence: 0.9 },
        ],
        segments: [
          { text: 'えー', start: 1000, end: 1100 },
          { text: 'あの', start: 2000, end: 2100 },
        ],
      }),
    );

    const res = handleLearningDiff(dir);
    expect(res.cut).not.toBeNull();
    const added = res.cut!.filter((c) => c.kind === 'added-cut');
    const restored = res.cut!.filter((c) => c.kind === 'restored-cut');
    expect(added).toEqual([
      { kind: 'added-cut', startFrame: 50, endFrame: 70, startSec: 50 / 60, endSec: 70 / 60, text: 'えー' },
    ]);
    expect(restored).toEqual([
      { kind: 'restored-cut', startFrame: 100, endFrame: 130, startSec: 100 / 60, endSec: 130 / 60, text: 'あの' },
    ]);
  });

  it('②baseline なしで cut: null（cut-baseline を再生成しない）', () => {
    const dir = copySampleProject();
    rmSync(join(dir, 'cut-baseline.json'), { force: true });
    const res = handleLearningDiff(dir);
    expect(res.cut).toBeNull();
    expect(res.words).toBeNull();
    // telops/ses の baseline なしケースは⑥⑧で個別に検証（本フィクスチャは他テスト向けに
    // .learning/baseline を同梱済みのため、ここでは telops/ses の値を断定しない）。
    expect(existsSync(join(dir, 'cut-baseline.json'))).toBe(false);
  });

  it('⑤telopData baseline ありでテキスト変更を検出する', () => {
    const dir = copySampleProject();
    const baselineDir = join(dir, '.learning', 'baseline', 'src', 'テロップテンプレート');
    mkdirSync(baselineDir, { recursive: true });
    cpSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'), join(baselineDir, 'telopData.ts'));
    // 現在のテロップ id:1 のテキストを書き換える。
    const current = readFileSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'), 'utf8').replace(
      'ゆる素振り',
      'ゆるゆる素振り',
    );
    writeFileSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'), current);

    const res = handleLearningDiff(dir);
    expect(res.telops).toContainEqual({
      kind: 'changed',
      startFrame: 30,
      endFrame: 150,
      startSec: 30 / 60,
      endSec: 150 / 60,
      before: 'ゆる素振り',
      after: 'ゆるゆる素振り',
    });
  });

  it('⑥telopData baseline なしで telops: null', () => {
    const dir = copySampleProject();
    // cut-baseline.json も消しておく: 残っていると cut 差分計算経路が loadProjectFromDir を呼び、
    // その副作用（TRACKED_FILES の自動ベースライン退避）で telopData baseline が今このタイミングで
    // 作られてしまい「baseline なし」の状況を再現できないため。
    rmSync(join(dir, 'cut-baseline.json'), { force: true });
    // sample-project フィクスチャは他テスト（loadProjectFiles.test.ts 等が SAMPLE を直接読む）向けに
    // .learning/baseline を同梱済みなので、本テストでは明示的に取り除く。
    rmSync(join(dir, '.learning'), { recursive: true, force: true });
    const res = handleLearningDiff(dir);
    expect(res.telops).toBeNull();
  });

  it('⑦seData baseline ありで追加/削除を検出する', () => {
    const dir = copySampleProject();
    const baselineDir = join(dir, '.learning', 'baseline', 'src', 'SoundEffects');
    mkdirSync(baselineDir, { recursive: true });
    cpSync(join(dir, 'src', 'SoundEffects', 'seData.ts'), join(baselineDir, 'seData.ts'));
    // 現在の seData に新しい SE を1件追加。
    writeFileSync(
      join(dir, 'src', 'SoundEffects', 'seData.ts'),
      `import type { SoundEffect } from './SEPlayer';

export const seData: SoundEffect[] = [
  { id: 1, startFrame: 30, file: 'beep.mp3', volume: 0.3 },
  { id: 2, startFrame: 200, file: 'whoosh.mp3' },
];
`,
    );

    const res = handleLearningDiff(dir);
    expect(res.ses).toContainEqual({
      kind: 'added',
      startFrame: 200,
      startSec: 200 / 60,
      file: 'whoosh.mp3',
      nearbyText: '長いアイアン2本ですね',
    });
  });

  it('⑧seData baseline なしで ses: null', () => {
    const dir = copySampleProject();
    rmSync(join(dir, 'cut-baseline.json'), { force: true }); // 理由は⑥と同じ
    rmSync(join(dir, '.learning'), { recursive: true, force: true }); // 理由は⑥と同じ
    const res = handleLearningDiff(dir);
    expect(res.ses).toBeNull();
  });
});

describe('handleLearningApprove', () => {
  function approveReq(over: Partial<LearningApproveRequest>): LearningApproveRequest {
    return { projectId: 'proj', cut: [], words: [], ...over };
  }

  it('③approve で cut_feedback.jsonl / typo_dict.json が更新され件数が返る（distinct videoId 基準で昇格）', () => {
    const cutItem = (text: string) => ({
      kind: 'added-cut' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      text,
    });
    // videoId は basename(dir) から決まるため、同一動画の重複承認では加算されない
    // （I-1: 再書き出し・再承認による二重計上防止）。異なる動画で観測させる。
    const dir1 = tempDir('sme-learnapi-approve-a-');
    const res1 = handleLearningApprove(dir1, approveReq({
      cut: [cutItem('えー')],
      words: [{ before: 'あ', after: 'い' }],
    }));
    const dir2 = tempDir('sme-learnapi-approve-b-');
    const res2 = handleLearningApprove(dir2, approveReq({ cut: [cutItem('えー')] }));

    const home = process.env.HARNESS_LEARNING_HOME!;
    const feedback = readFileSync(join(home, 'cut_feedback.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(feedback).toHaveLength(2);
    const typoDict = JSON.parse(readFileSync(join(home, 'typo_dict.json'), 'utf8'));
    expect(typoDict.replace['あ']).toBe('い');

    // 「えー」を dir1/dir2 の異なる動画で1回ずつ観測 → 2回目で cut ルール昇格。単語は1回目で1件昇格。
    expect(res1.cutRulesPromoted).toBe(0);
    expect(res2.cutRulesPromoted).toBe(1);
    expect(res1.wordsPromoted).toBe(1);
    expect(res1.wordConflicts).toBe(0);
  });

  it('既存 feedback がある状態で approve → 累積でなく差分件数が返る', () => {
    const cutItem = (text: string) => ({
      kind: 'added-cut' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      text,
    });
    // 「えー」を dir A1/A2（異なる動画）で1回ずつ観測 → 2回目で cut ルール昇格（累積 rules=1）。
    const dirA1 = tempDir('sme-learnapi-approve3a-');
    handleLearningApprove(dirA1, approveReq({ cut: [cutItem('えー')] }));
    const dirA2 = tempDir('sme-learnapi-approve3b-');
    handleLearningApprove(dirA2, approveReq({ cut: [cutItem('えー')] }));
    // 「あの」を dir B1/B2（異なる動画）で1回ずつ観測 → 新たに1件昇格。累積は2だが差分の1を返すべき。
    const dirB1 = tempDir('sme-learnapi-approve3c-');
    handleLearningApprove(dirB1, approveReq({ cut: [cutItem('あの')] }));
    const dirB2 = tempDir('sme-learnapi-approve3d-');
    const res = handleLearningApprove(dirB2, approveReq({ cut: [cutItem('あの')] }));
    expect(res.cutRulesPromoted).toBe(1);
    expect(res.cutConflicts).toBe(0);
  });

  it('④approve の words 競合は昇格されず wordConflicts に計上', () => {
    const dir = tempDir('sme-learnapi-approve2-');
    // ストアに「あ→X」を先に登録しておく。
    saveStore(promoteWordRules(loadStore(), [{ before: 'あ', after: 'X' }], 'seed'));

    const res = handleLearningApprove(dir, approveReq({
      words: [{ before: 'あ', after: 'Y' }],
    }));

    expect(res.wordsPromoted).toBe(0);
    expect(res.wordConflicts).toBe(1);
    // 既存の「あ→X」は上書きされない。
    const store = loadStore();
    expect(store.typoDict.replace['あ']).toBe('X');
  });

  it('⑨approve で telop_feedback.jsonl / telop_rules.json が異なる動画で2回観測後に昇格する', () => {
    const telopItem = {
      kind: 'changed' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      before: '素振りする',
      after: '素振りをする',
    };
    const dir1 = tempDir('sme-learnapi-telop-a-');
    const res1 = handleLearningApprove(dir1, approveReq({ telops: [telopItem] }));
    const dir2 = tempDir('sme-learnapi-telop-b-');
    const res2 = handleLearningApprove(dir2, approveReq({ telops: [telopItem] }));

    expect(res1.telopRulesPromoted).toBe(0);
    expect(res2.telopRulesPromoted).toBe(1);
    const home = process.env.HARNESS_LEARNING_HOME!;
    const feedback = readFileSync(join(home, 'telop_feedback.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(feedback).toHaveLength(2);
    const rules = JSON.parse(readFileSync(join(home, 'telop_rules.json'), 'utf8'));
    expect(rules.rules).toEqual([{ before: '素振りする', after: '素振りをする' }]);
  });

  it('⑩approve で se_feedback.jsonl / se_rules.json が異なる動画で2回観測後に昇格する', () => {
    const seItem = { kind: 'added' as const, startFrame: 100, startSec: 100 / 60, file: 'whoosh.mp3', nearbyText: 'ここで素振り' };
    const dir1 = tempDir('sme-learnapi-se-a-');
    const res1 = handleLearningApprove(dir1, approveReq({ ses: [seItem] }));
    const dir2 = tempDir('sme-learnapi-se-b-');
    const res2 = handleLearningApprove(dir2, approveReq({ ses: [seItem] }));

    expect(res1.seRulesPromoted).toBe(0);
    expect(res2.seRulesPromoted).toBe(1);
    const home = process.env.HARNESS_LEARNING_HOME!;
    const rules = JSON.parse(readFileSync(join(home, 'se_rules.json'), 'utf8'));
    expect(rules.rules).toEqual([{ seFile: 'whoosh.mp3', contextText: 'ここで素振り', action: 'add' }]);
  });

  it('⑪telops/ses 未指定（後方互換）でもクラッシュせず 0 件扱い', () => {
    const dir = tempDir('sme-learnapi-back-compat-');
    const res = handleLearningApprove(dir, { projectId: 'proj', cut: [], words: [] });
    expect(res.telopRulesPromoted).toBe(0);
    expect(res.telopConflicts).toBe(0);
    expect(res.seRulesPromoted).toBe(0);
    expect(res.seConflicts).toBe(0);
  });
});

describe('handleLearningStatus', () => {
  it('未蒸留件数を返す', () => {
    expect(handleLearningStatus()).toEqual({ undistilledCount: 0 });
  });
});
