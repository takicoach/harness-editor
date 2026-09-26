import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
import { handleLearningDiff, handleLearningApprove, handleLearningStatus, validateApproveRequest } from './learningApi';
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

// 学習フォルダは HARNESS_LEARNING_HOME が最優先なので、両方の環境変数を同じ一時フォルダへ向ける
// （シェルに HARNESS_LEARNING_HOME があっても実際の学習フォルダへ書かない）。
beforeEach(() => {
  const home = tempDir('sme-learnapi-home-');
  vi.stubEnv('HARNESS_LEARNING_HOME', home);
  vi.stubEnv('SUPERMOVIE_LEARNING_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
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

    const home = process.env.SUPERMOVIE_LEARNING_HOME!;
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
    const home = process.env.SUPERMOVIE_LEARNING_HOME!;
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
    const home = process.env.SUPERMOVIE_LEARNING_HOME!;
    const rules = JSON.parse(readFileSync(join(home, 'se_rules.json'), 'utf8'));
    expect(rules.rules).toEqual([{ seFile: 'whoosh.mp3', contextText: 'ここで素振り', action: 'add' }]);
  });

  it('⑫recorded に承認した項目のカテゴリ別件数が返る', () => {
    const cutItem = (text: string) => ({
      kind: 'added-cut' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      text,
    });
    const telopItem = {
      kind: 'changed' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      before: '素振りする',
      after: '素振りをする',
    };
    const seItem = {
      kind: 'added' as const,
      startFrame: 100,
      startSec: 100 / 60,
      file: 'whoosh.mp3',
      nearbyText: 'ここで素振り',
    };
    const dir = tempDir('sme-learnapi-recorded-');
    const res = handleLearningApprove(
      dir,
      approveReq({
        cut: [cutItem('えー'), cutItem('あの'), cutItem('まあ')],
        words: [{ before: 'あ', after: 'い' }],
        telops: [telopItem],
        ses: [seItem, { ...seItem, file: 'pop.mp3' }],
      }),
    );
    expect(res.recorded).toEqual({ cut: 3, words: 1, telops: 1, ses: 2 });
  });

  it('⑬昇格が起きたときだけ promotedRules に内容が入る（カテゴリ＋表示テキスト）', () => {
    const cutItem = {
      kind: 'added-cut' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      text: 'えー',
    };
    const telopItem = {
      kind: 'changed' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      before: '素振りする',
      after: '素振りをする',
    };
    const seItem = {
      kind: 'added' as const,
      startFrame: 100,
      startSec: 100 / 60,
      file: 'whoosh.mp3',
      nearbyText: 'ここで素振り',
    };

    // 1 本目の動画: cut/telop/se はまだ閾値未満で昇格しない。語句だけは即時昇格する。
    const dir1 = tempDir('sme-learnapi-promo-a-');
    const res1 = handleLearningApprove(
      dir1,
      approveReq({ cut: [cutItem], words: [{ before: 'あ', after: 'い' }], telops: [telopItem], ses: [seItem] }),
    );
    expect(res1.promotedRules).toEqual([{ category: 'word', text: '「あ」を「い」に直します' }]);

    // 2 本目の動画（別 videoId）で同じ観測 → cut/telop/se が昇格する。
    const dir2 = tempDir('sme-learnapi-promo-b-');
    const res2 = handleLearningApprove(dir2, approveReq({ cut: [cutItem], telops: [telopItem], ses: [seItem] }));
    expect(res2.promotedRules).toEqual([
      { category: 'cut', text: '「えー」は自動でカットします' },
      { category: 'telop', text: '「素振りする」を「素振りをする」に直します' },
      { category: 'se', text: '「ここで素振り」の近くに whoosh.mp3 を入れます' },
    ]);
  });

  it('⑭昇格が起きなければ promotedRules は空配列', () => {
    const dir = tempDir('sme-learnapi-promo-none-');
    const res = handleLearningApprove(
      dir,
      approveReq({
        cut: [{ kind: 'added-cut', startFrame: 0, endFrame: 30, startSec: 0, endSec: 0.5, text: 'えー' }],
      }),
    );
    expect(res.promotedRules).toEqual([]);
    expect(res.recorded).toEqual({ cut: 1, words: 0, telops: 0, ses: 0 });
  });

  it('⑮すでに同じ語句ルールがあるときは再承認しても promotedRules に出さない', () => {
    saveStore(promoteWordRules(loadStore(), [{ before: 'あ', after: 'い' }], 'seed'));
    const dir = tempDir('sme-learnapi-promo-dup-');
    const res = handleLearningApprove(dir, approveReq({ words: [{ before: 'あ', after: 'い' }] }));
    expect(res.promotedRules).toEqual([]);
  });

  it('⑯競合して辞書に入らなかった語句は recorded.words に数えない（成功+スキップ ≦ 入力）', () => {
    saveStore(promoteWordRules(loadStore(), [{ before: 'あ', after: 'X' }], 'seed'));
    const dir = tempDir('sme-learnapi-recorded-conflict-');
    const words = [
      { before: 'あ', after: 'Y' }, // 既存の「あ→X」と競合 → スキップ
      { before: 'い', after: 'う' }, // 新規 → 記録
    ];
    const res = handleLearningApprove(dir, approveReq({ words }));
    expect(res.recorded?.words).toBe(1);
    expect(res.wordConflicts).toBe(1);
    // 不変条件: 学習した件数 + スキップした件数は、送った件数を超えない。
    expect((res.recorded?.words ?? 0) + res.wordConflicts).toBeLessThanOrEqual(words.length);
  });

  it('⑰無音区間のカット（プレースホルダ）はルール化も記録もしない', () => {
    const silent = {
      kind: 'added-cut' as const,
      startFrame: 0,
      endFrame: 30,
      startSec: 0,
      endSec: 0.5,
      text: '(無音)',
    };
    // 異なる動画で2回承認しても「(無音)」という文言のルールは作らない。
    const dir1 = tempDir('sme-learnapi-silent-a-');
    const res1 = handleLearningApprove(dir1, approveReq({ cut: [silent] }));
    const dir2 = tempDir('sme-learnapi-silent-b-');
    const res2 = handleLearningApprove(dir2, approveReq({ cut: [silent] }));

    expect(res1.promotedRules).toEqual([]);
    expect(res2.promotedRules).toEqual([]);
    expect(res2.cutRulesPromoted).toBe(0);
    // 学習データにも積まない（記録件数 0・jsonl も空）。
    expect(res2.recorded?.cut).toBe(0);
    const home = process.env.SUPERMOVIE_LEARNING_HOME!;
    expect(existsSync(join(home, 'cut_feedback.jsonl'))).toBe(false);
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

describe('handleLearningApprove の件数（設計書 D9: jsonl に新しく増えた行数）', () => {
  it('⑱同じ項目を再承認すると recorded は 0、弾かれた件数は alreadyRecorded に入る', () => {
    const body: LearningApproveRequest = {
      projectId: 'proj',
      words: [],
      cut: [{ kind: 'added-cut', startFrame: 0, endFrame: 30, startSec: 0, endSec: 0.5, text: 'えー' }],
      telops: [{ kind: 'changed', startFrame: 0, endFrame: 30, startSec: 0, endSec: 0.5, before: '素振りする', after: '素振りをする' }],
      ses: [{ kind: 'added', startFrame: 100, startSec: 100 / 60, file: 'whoosh.mp3', nearbyText: 'ここで素振り' }],
    };
    const dir = tempDir('sme-learnapi-dup-');
    const first = handleLearningApprove(dir, body);
    expect(first.recorded).toEqual({ cut: 1, words: 0, telops: 1, ses: 1 });
    expect(first.alreadyRecorded).toBe(0);
    const second = handleLearningApprove(dir, body);
    expect(second.recorded).toEqual({ cut: 0, words: 0, telops: 0, ses: 0 });
    expect(second.alreadyRecorded).toBe(3);
  });

  it('⑲新規と記録済みが混ざった要求では、カテゴリごとに新しく増えた行だけを数える', () => {
    const cut = (text: string) => ({ kind: 'added-cut' as const, startFrame: 0, endFrame: 30, startSec: 0, endSec: 0.5, text });
    const telop = (after: string) => ({ kind: 'changed' as const, startFrame: 0, endFrame: 30, startSec: 0, endSec: 0.5, before: '素振りする', after });
    const se = (file: string) => ({ kind: 'added' as const, startFrame: 100, startSec: 100 / 60, file, nearbyText: 'ここで素振り' });
    const dir = tempDir('sme-learnapi-mixed-');
    // 1 回目: 行数をカテゴリごとに違える（カット 2・テロップ 1・SE 3）。前後の行数を取り違えると 2 回目が赤になる。
    const first = handleLearningApprove(dir, {
      projectId: 'proj',
      words: [],
      cut: [cut('えー'), cut('あの')],
      telops: [telop('素振りをする')],
      ses: [se('a.mp3'), se('b.mp3'), se('c.mp3')],
    });
    expect(first.recorded).toEqual({ cut: 2, words: 0, telops: 1, ses: 3 });
    expect(first.alreadyRecorded).toBe(0);
    // 2 回目: カット 3 件中 1 件・テロップ 1 件中 1 件・SE 2 件中 1 件が記録済み。
    const second = handleLearningApprove(dir, {
      projectId: 'proj',
      words: [],
      cut: [cut('えー'), cut('まあ'), cut('その')],
      telops: [telop('素振りをする')],
      ses: [se('a.mp3'), se('d.mp3')],
    });
    expect(second.recorded).toEqual({ cut: 2, words: 0, telops: 0, ses: 1 });
    expect(second.alreadyRecorded).toBe(3);
  });

  it('⑳無音カットは記録もしないし、記録済みの件数にも数えない', () => {
    const silent = { kind: 'added-cut' as const, startFrame: 0, endFrame: 30, startSec: 0, endSec: 0.5, text: '(無音)' };
    const spoken = { kind: 'added-cut' as const, startFrame: 40, endFrame: 70, startSec: 40 / 60, endSec: 70 / 60, text: 'えー' };
    const body: LearningApproveRequest = { projectId: 'proj', words: [], cut: [silent, spoken] };
    const dir = tempDir('sme-learnapi-silent-count-');
    const first = handleLearningApprove(dir, body);
    expect(first.recorded?.cut).toBe(1);
    expect(first.alreadyRecorded).toBe(0);
    const second = handleLearningApprove(dir, body);
    expect(second.recorded?.cut).toBe(0);
    expect(second.alreadyRecorded).toBe(1);
  });
});

describe('validateApproveRequest の項目の中身（旧形式の経路にも効く）', () => {
  const base = { projectId: 'p', cut: [], words: [], telops: [], ses: [] };
  const cut = { kind: 'added-cut', startFrame: 0, endFrame: 30, startSec: 0, endSec: 1, text: 'えー' };
  const telop = { kind: 'changed', startFrame: 0, endFrame: 30, startSec: 0, endSec: 1, before: 'ゆる', after: 'ゆるい' };
  const se = { kind: 'added', startFrame: 0, startSec: 0, file: 'pop.mp3', nearbyText: '' };
  it('正しい形（全カテゴリ・上限ちょうどの長さ）は通す', () => {
    const body = { ...base, cut: [cut, { ...cut, kind: 'restored-cut' }], words: [{ before: 'あ', after: 'い' }],
      telops: [telop, { ...telop, kind: 'added', before: '' }, { ...telop, kind: 'removed', after: 'あ'.repeat(2000) }],
      ses: [se, { ...se, kind: 'removed' }] };
    expect(validateApproveRequest(body)).toBe(body);
  });
  it('正当な長いカット（区間の語をつないだ本文 10,000 字）は通す（他の項目の学習を巻き添えにしない）', () => {
    const body = { ...base, cut: [{ ...cut, endFrame: 30 * 60 * 10, endSec: 600, text: 'あ'.repeat(10_000) }], telops: [telop] };
    expect(validateApproveRequest(body)).toBe(body);
    // 上限ちょうどは通す（カットだけ上限が大きい。テロップなど他の文字列は 2000 字のまま＝下の表）。
    expect(() => validateApproveRequest({ ...base, cut: [{ ...cut, text: 'あ'.repeat(100_000) }] })).not.toThrow();
  });
  it.each<[string, Record<string, unknown>]>([
    ['cut の要素が null', { cut: [null] }],
    ['cut の kind が許容外', { cut: [{ ...cut, kind: 'changed' }] }],
    ['cut の text が文字列でない', { cut: [{ ...cut, text: 1 }] }],
    ['cut の text が上限（100,000 字）を超える', { cut: [{ ...cut, text: 'あ'.repeat(100_001) }] }],
    ['cut の startFrame が数でない', { cut: [{ ...cut, startFrame: '0' }] }],
    ['cut の endFrame が有限でない', { cut: [{ ...cut, endFrame: Number.POSITIVE_INFINITY }] }],
    ['cut の endSec が欠けている', { cut: [{ ...cut, endSec: undefined }] }],
    ['words の before が文字列でない', { words: [{ before: 1, after: 'い' }] }],
    ['telop の kind が許容外', { telops: [{ ...telop, kind: 'added-cut' }] }],
    ['telop の before が文字列でない', { telops: [{ ...telop, before: null }] }],
    ['telop の after が長すぎる', { telops: [{ ...telop, after: 'あ'.repeat(2001) }] }],
    ['telop の startSec が NaN', { telops: [{ ...telop, startSec: Number.NaN }] }],
    ['se の kind が許容外', { ses: [{ ...se, kind: 'changed' }] }],
    ['se の file が文字列でない', { ses: [{ ...se, file: {} }] }],
    ['se の nearbyText が長すぎる', { ses: [{ ...se, nearbyText: 'あ'.repeat(2001) }] }],
    ['se の startFrame が数でない', { ses: [{ ...se, startFrame: null }] }],
  ])('%s は 400', (_label, patch) => {
    expect(() => validateApproveRequest({ ...base, ...patch })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('handleLearningStatus', () => {
  it('未蒸留件数を返す', () => {
    expect(handleLearningStatus()).toEqual({ undistilledCount: 0 });
  });
});
