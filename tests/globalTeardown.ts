import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * ランの後に作業ツリー汚染ゲートを実行する（globalSetup が取ったスナップショットとの差を見る）。
 *
 * E-2 で塞いだ穴: このゲートは `npm run test:e2e:isolated` にしか結線されておらず、
 * ゴールプロンプト §5 が指定する素の
 *   `npx playwright test --config playwright.isolated.config.ts`
 * では走らなかった。playwright 設定に結線して、どの起動経路でも必ず走らせる。
 *
 * ここで throw すると playwright は非ゼロ終了する（＝テストが全部緑でもランは赤）。
 * 「テストは通ったがリポジトリを汚した」を緑にしないための意図的な設計。
 */
const REPO = resolve(import.meta.dirname, '..');

export default function globalTeardown(): void {
  try {
    execFileSync(process.execPath, [join(REPO, 'scripts/check-worktree-dirt.mjs'), 'verify'], {
      cwd: REPO,
      stdio: 'inherit',
    });
  } catch {
    throw new Error(
      'e2e ランが作業ツリーを汚しました（上の check-worktree-dirt の出力を参照）。' +
        '成果物は .gitignore 対象へ、残骸は afterEach で片付けること。',
    );
  }
}
