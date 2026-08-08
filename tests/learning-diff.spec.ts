import { test, expect } from '@playwright/test';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// 学習ループ Phase B（差分承認ループ）の e2e。
//
// 方針:
// - 書き出しは実レンダリングせず、GET /api/learning/diff を直接叩いて added-cut を検証する。
// - パネル表示（render running→done エッジで open）は DiffReviewPanel.test.ts /
//   useLearningDiff.test.ts のユニットで担保済みのため、本 e2e は
//   「読込（＝baseline 退避）→ カット追加保存 → diff → approve → ストア生成」という
//   サーバ横断の実経路を検証する。
// - フルラン並列時に sample-project を他 spec（render-button/smoke 等）と取り合うと
//   保存衝突フレークを増幅するため、専用コピー `learning-diff-tmp` へ隔離して叩く。
//   コピーは beforeEach で作り afterEach で削除（git checkout による復元は不要）。
// - グローバルストアは playwright.config.ts の webServer env で
//   HARNESS_LEARNING_HOME=tests/.learning-home に隔離済み（実ユーザー home を汚さない）。
//   ⚠️ :2109 に手動 dev サーバが残っていると reuseExistingServer がそれを拾い、
//   env が効かず本物の ~/.supermovie-learning へ書く。実行前に kill すること。

const FIXTURES_ROOT = resolve(import.meta.dirname, '../src/server/__fixtures__');
const SAMPLE_DIR = resolve(FIXTURES_ROOT, 'sample-project');
const LEARNING_HOME = resolve(import.meta.dirname, '.learning-home');

// --repeat-each やリトライで同 spec が並列に走っても衝突しないよう、
// プロジェクト ID は実行インスタンスごとに一意にする（prefix は .gitignore 済み）。
let projectId = '';
let projectDir = '';

// 注意: LEARNING_HOME（グローバルストア）は webServer 単一プロセスの共有先なので
// テスト内で rmSync しない（並列インスタンスの書込を消すと flaky）。
// 検証は一意な videoId=projectId で自分の書込だけをフィルタして行う。

test.beforeEach(() => {
  projectId = `learning-diff-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  projectDir = resolve(FIXTURES_ROOT, projectId);
  cpSync(SAMPLE_DIR, projectDir, { recursive: true });
});

test.afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test('カット追加→保存→diff で added-cut 1件→approve でストアに feedback/rules が生成される', async ({
  request,
}) => {
  // ── 1. プロジェクト読込（GET /api/project = loadProjectFromDir がベースラインを退避する実経路）。
  const loadRes = await request.get(`/api/project?id=${projectId}`);
  expect(loadRes.ok()).toBeTruthy();
  const loaded = await loadRes.json();

  // ベースライン未取得ならスキップされる cut フィールドが配列で返ること＝baseline あり。
  const baselineDiff = await request.get(`/api/learning/diff?id=${projectId}`);
  expect(baselineDiff.ok()).toBeTruthy();
  const baselineBody = await baselineDiff.json();
  expect(baselineBody.cut).not.toBeNull(); // baseline があるので配列（この時点では差分ゼロ）。
  expect(baselineBody.cut).toHaveLength(0);

  // ── 2. カット区間を1つ追加して保存する（サーバの実保存経路: 指紋一致→cutData.ts 書換）。
  const project = loaded.project;
  project.cutRegions = [...project.cutRegions, { start: 3000, end: 3500 }];

  const saveRes = await request.put(`/api/project?id=${projectId}`, {
    data: { project, fingerprint: loaded.save.fingerprint },
  });
  expect(saveRes.ok()).toBeTruthy();

  // ── 3. diff を直接叩き、added-cut が1件返る。
  const diffRes = await request.get(`/api/learning/diff?id=${projectId}`);
  expect(diffRes.ok()).toBeTruthy();
  const diff = await diffRes.json();
  const added = (diff.cut ?? []).filter(
    (c: { kind: string }) => c.kind === 'added-cut',
  );
  expect(added).toHaveLength(1); // 追加した1件だけが added-cut として立つ。
  expect(added[0]).toMatchObject({ kind: 'added-cut', startFrame: 3000, endFrame: 3500 });

  // ── 4. approve → グローバルストアに cut_feedback.jsonl / cut_rules.json が生成される。
  const approveRes = await request.post('/api/learning/approve', {
    data: { projectId: projectId, cut: added, words: [] },
  });
  expect(approveRes.ok()).toBeTruthy();

  const feedbackPath = resolve(LEARNING_HOME, 'cut_feedback.jsonl');
  const rulesPath = resolve(LEARNING_HOME, 'cut_rules.json');
  expect(existsSync(feedbackPath)).toBeTruthy();
  expect(existsSync(rulesPath)).toBeTruthy();

  // 並列インスタンスの書込と混在し得るため、自分の videoId の行だけをフィルタして検証する。
  const myLines = readFileSync(feedbackPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { videoId: string })
    .filter((e) => e.videoId === projectId);
  expect(myLines).toHaveLength(1);
  expect(myLines[0]).toMatchObject({ videoId: projectId, kind: 'added-cut', startFrame: 3000, endFrame: 3500 });

  // cut_rules.json は JSON として妥当（集計結果）。
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  expect(rules).toBeTruthy();
});
