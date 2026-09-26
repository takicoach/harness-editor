import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/** dev サーバーの SME_PROJECT_ROOT（playwright.config.ts が指すフィクスチャ root）。 */
export const FIXTURES_ROOT = join(import.meta.dirname, '..', 'src/server/__fixtures__');

/**
 * 一時プロジェクトの複製元。**実行中に誰も書き換えない** pristine スナップショット
 * （tests/globalSetup.ts が HEAD から作る）。
 *
 * 共有フィクスチャ `sample-project` をそのまま複製元にすると、smoke.spec.ts /
 * heavy-job-confirm.spec.ts の afterEach（`git checkout -- ` / `git clean -fdx`）と
 * 重なった複製が**壊れたコピー**になる（実測: コピーを開いたエディタが
 * 「[telopData.ts] telopData 配列が見つかりません」で止まる）。
 */
export const PRISTINE_SAMPLE_PROJECT = join(
  import.meta.dirname,
  '.fixture-snapshot/src/server/__fixtures__/sample-project',
);

/**
 * 共有フィクスチャ `sample-project` の専用コピーを作る。
 *
 * 共有フィクスチャを複数の spec が同時に触ると、次のような**他 spec を巻き込む**壊れ方をする
 * （いずれもフルスイート実行で実測済み）:
 * - 片方の afterEach の `git clean -fdx sample-project` が、もう片方が書いた
 *   `.sme/status.json` を消す（poll が undefined を見て赤）。
 * - 同じ projectId の書き出しジョブはサーバ側シングルトンなので、並列テストが
 *   互いの running/done を拾う。
 * - 書き出しの running → done エッジは、同じプロジェクトを開いている全タブで
 *   学習差分レビューの全画面モーダルを開き、他 spec のクリックを遮る。
 * 対象をずらせばこれらは原理的に起こらない。
 */
export function createTempProject(prefix: string): { id: string; dir: string } {
  const id = `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dir = join(FIXTURES_ROOT, id);
  if (!existsSync(PRISTINE_SAMPLE_PROJECT)) {
    // 黙って共有フィクスチャへフォールバックしない——それが直したかった競合そのもの。
    throw new Error(
      `pristine スナップショットがありません（globalSetup が走っていない）: ${PRISTINE_SAMPLE_PROJECT}`,
    );
  }
  cpSync(PRISTINE_SAMPLE_PROJECT, dir, { recursive: true });
  // sample-project の `.sme/`（他テストが書いた進捗・作業中フラグ）は引き継がない。
  // 引き継ぐと「まだ status.json が無いこと」を見る検査が他テストの残り香で落ちる。
  rmSync(join(dir, '.sme'), { recursive: true, force: true });
  return { id, dir };
}

/**
 * 一時プロジェクトを消し切る（残骸ゼロの保証）。
 *
 * フィクスチャ root は dev サーバーのプロジェクト root そのものなので、消し残しは
 * このランでは表面化せず**後続ランのホーム一覧を汚染する**（実測: 残骸 4 件で
 * 以後のフルスイートが 5 回中 2 回赤）。削除中にサーバーが `out/` や `.sme/` を
 * 作り直すと `ENOTEMPTY` になるため、fs 標準の再試行を使って消し切り、
 * それでも残ったら**その場で**失敗させる（後続へ持ち越さない）。
 */
export function removeTempProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  if (existsSync(dir)) {
    throw new Error(`一時プロジェクトを消し切れませんでした（残骸が後続ランを汚染します）: ${dir}`);
  }
}

/** エディタを起動して指定プロジェクト（既定は共有 sample-project）を開くまでの共通セットアップ。 */
export async function openEditor(page: Page, projectId = 'sample-project'): Promise<void> {
  await page.goto('/');
  // ホームはサイドバー非表示（UIリフレッシュ 2026-07-10）のため、カードから開く。
  const item = page.locator('.home-card', { hasText: projectId });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  // Remotion Player がマウントされるまで待つ
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
}

/**
 * 「テストごとに専用コピーを作り、終わったら消し切る」定型を spec ファイルへ登録し、
 * 現在のテストの projectId を返すゲッターを渡す。
 *
 * 共有 `sample-project` を**読むだけ**の spec でも、共有のままでは安全ではない:
 * smoke.spec.ts / heavy-job-confirm.spec.ts の afterEach が同じディレクトリへ
 * `git checkout -- <dir>` と `git clean -fdx <dir>` を掛けており、別 worker が
 * その最中にプロジェクトを開くと生成物（cutData.ts 等）が一瞬消えた状態を読む。
 * 実測: フルスイートで per-segment-layout.spec.ts の `openEditor` が
 * `.pv-stage .__remotion-player` を 20 秒待っても得られず赤（回ごとに別ファイルが当たる）。
 * 対象をずらせば原理的に起こらない。
 */
export function useTempProject(prefix: string): () => string {
  let current: { id: string; dir: string } = { id: '', dir: '' };
  test.beforeEach(() => {
    current = createTempProject(prefix);
  });
  test.afterEach(async ({ page }) => {
    // 先にページを閉じる。開いたままだと削除中のプロジェクトへ再取得が飛び、
    // サーバーが out/ を作り直して ENOTEMPTY になる（render-button.spec.ts と同じ規約）。
    await page.close();
    removeTempProject(current.dir);
  });
  return () => current.id;
}

/**
 * canvas 要素の getImageData を走査し、非透明（alpha>0）ピクセルの比率を返す（0..1）。
 * 「構造として存在する（DOM に canvas がある）」と「実際に何か描かれている」は別物なので、
 * 波形・図解等の「存在検査」に使う。空の canvas なら常に 0 を返す。
 */
export async function canvasOpaquePixelRatio(locator: Locator): Promise<number> {
  return locator.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext('2d');
    if (ctx === null || el.width === 0 || el.height === 0) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    let opaque = 0;
    const total = data.length / 4;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 0) opaque++;
    }
    return total === 0 ? 0 : opaque / total;
  });
}

/**
 * 書き出しジョブを「実際に登録が済むまで待ってから」破棄する。
 *
 * 書き出しの実行中表示は POST の応答を待たずに出る（楽観的 running）ので、テストが
 * 終わる時点でまだ**サーバにジョブが登録されていない**ことがある。その瞬間に投げた
 * DELETE は 404 で捨てられ、直後に登録されたジョブは誰にも止められないまま走り続けて
 * out/ を作り直す＝次のランに残骸を残す（H-1 で製品側（useRenderJob）を直したのと
 * 同型の競合が、テストの後片付け側に残っていた）。
 * 404 の間だけ短く送り直す（登録が済めば 200 か「ジョブ無し」で確定する）。
 */
export async function cancelRenderJob(
  request: APIRequestContext,
  projectId: string,
  budgetMs = 1000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const res = await request
      .delete(`/api/render?id=${encodeURIComponent(projectId)}`)
      .catch(() => null);
    if (res !== null && res.status() !== 404) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
