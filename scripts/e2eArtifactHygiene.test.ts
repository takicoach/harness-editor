import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  screenshotWithoutShotDir,
  stringLiterals,
  trackedOutputOffenders,
  type SpecSource,
} from './specHygiene';

/**
 * e2e の成果物衛生の回帰テスト。
 *
 * H-2 の実測: `tests/visual-audit.spec.ts` / `tests/visual-audit-ai.spec.ts` が
 * コミット済みの `docs/reports/aaa-screenshots/G-4/*.png` を毎回上書きしていたため、
 * フルスイート e2e を回すだけで `git status` に 78 件の modified が出た。
 * ここでは「spec が追跡ディレクトリへ直接書かない」ことを**静的に**固定する
 * （実ランでの検査は scripts/check-worktree-dirt.mjs が担当）。
 *
 * E-2 で強化: 検査が `'../docs/reports` の**リテラル前方一致**しか見ておらず、
 * `resolve(root, 'docs/reports')` や `join(root, 'docs', 'reports')` といった
 * 迂回経路を素通ししていた（＝検査があるのに退行を止められない）。
 * 判定は scripts/specHygiene.ts の純関数に移し、迂回形も含めて検査する。
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TESTS_DIR = join(REPO_ROOT, 'tests');

function specSources(): SpecSource[] {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => ({ file: `tests/${f}`, source: readFileSync(join(TESTS_DIR, f), 'utf8') }));
}

describe('e2e の成果物衛生', () => {
  // 本命の検査（実 spec 全体の走査）は、走査対象が 0 件でも
  // `expect([]).toEqual([])` で緑になる（＝検査が空振りしても気づけない fail-open）。
  // 兄弟の scripts/e2eFixtureGuard.test.ts と同じく、まず「対象が実在するか」を測る。
  it('走査対象の spec が実在する（検査が空振りしていない）', () => {
    const sources = specSources();
    expect(sources.length, 'spec が 1 件も見つかっていない（検査が空振り）').toBeGreaterThan(20);
    // 「スクショの出力先」検査は、撮る spec が 1 つも無ければ同じく空振りする。
    const shooters = sources.filter((s) => s.source.includes('screenshot('));
    expect(
      shooters.length,
      'screenshot を撮る spec が 1 件も無い（出力先の検査が空振り）',
    ).toBeGreaterThan(0);
  });

  it('spec は追跡ディレクトリを出力先として組み立てない', () => {
    const offenders = trackedOutputOffenders(specSources());
    expect(
      offenders,
      `spec が追跡ディレクトリを指している（tests/shotDir.ts 経由にする）:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('検査は前方一致の迂回（resolve / join / テンプレート）も捕まえる', () => {
    // ここが素通りしていたのが E-2 で塞いだ穴。3 形すべてを検出できることを固定する。
    const bypasses: SpecSource[] = [
      { file: 'a.spec.ts', source: `const OUT = resolve(REPO_ROOT, 'docs/reports/x');` },
      { file: 'b.spec.ts', source: `const OUT = join(root, 'docs', 'reports');` },
      { file: 'c.spec.ts', source: 'const OUT = `${base}/docs/guide`;' },
    ];
    expect(trackedOutputOffenders(bypasses).map((s) => s.split(' ->')[0])).toEqual([
      'a.spec.ts',
      'b.spec.ts',
      'c.spec.ts',
    ]);
  });

  it('証拠の場所を説明するコメントは違反にしない（文字列リテラルだけを見る）', () => {
    const commentOnly: SpecSource[] = [
      {
        file: 'd.spec.ts',
        source: `// 実測: docs/reports/aaa-screenshots/G-4/x.png は空だった\nconst OUT = shotDir('G-4');`,
      },
    ];
    expect(trackedOutputOffenders(commentOnly)).toEqual([]);
  });

  it('文字列リテラルの取り出しが正規表現リテラル中の引用符に引きずられない', () => {
    // 自前の字句解析は正規表現リテラルを知らず、`/['"]/` の `'` を文字列の開始と誤読して
    // その後ろの本物のリテラルを飲み込んでいた（＝検査が黙って無力化する fail-open）。
    const source = `const re = /['\"]/;\nconst OUT = resolve(root, 'docs/reports/x');`;
    expect(stringLiterals(source)).toContain('docs/reports/x');
    expect(trackedOutputOffenders([{ file: 'f.spec.ts', source }]).map((s) => s.split(' ->')[0])).toEqual([
      'f.spec.ts',
    ]);
  });

  it('文字列リテラルの取り出しがコメント内の引用符に引きずられない', () => {
    // コメント中の `'` を literal 開始と誤読すると、その後ろの本物のリテラルを丸ごと
    // 飲み込んで検査が無力化する（検出できない穴になる）。
    expect(stringLiterals(`// it's fine\nconst p = 'docs/reports';`)).toEqual(['docs/reports']);
    expect(stringLiterals(`const url = 'http://x/y'; // http://z`)).toEqual(['http://x/y']);
  });

  it('スクリーンショットを撮る spec は出力先を shotDir 経由で決める', () => {
    expect(screenshotWithoutShotDir(specSources())).toEqual([]);
    // 検査が実際に働くこと（存在検査）: shotDir を通さない spec は捕まる。
    expect(
      screenshotWithoutShotDir([
        { file: 'e.spec.ts', source: `await page.screenshot({ path: out + '/x.png' });` },
      ]),
    ).toEqual(['e.spec.ts']);
  });

  it('clip 併用の screenshot も検出する（入れ子オブジェクトで検査が止まらない）', () => {
    // 旧実装は `\{[^}]*path\s*:` で options を舐めており、`clip: { ... }` の内側の `}` で
    // 止まって path を見失っていた（構造ゲートが素通り）。clip 併用は実際にありうる書き方。
    expect(
      screenshotWithoutShotDir([
        {
          file: 'g.spec.ts',
          source: `await page.screenshot({ clip: { x: 0, y: 0 }, path: out + '/x.png' });`,
        },
      ]),
    ).toEqual(['g.spec.ts']);
  });

  it('通常ランのスクショ置き場は git の無視対象である', () => {
    // shotDir.ts の SCRATCH_ROOT。git check-ignore は無視されていれば exit 0。
    const probe = join(REPO_ROOT, '.aaa-shots', 'G-4', 'probe.png');
    const ignored = (() => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', probe], { cwd: REPO_ROOT });
        return true;
      } catch {
        return false;
      }
    })();
    expect(ignored, '.aaa-shots/ が .gitignore に入っていない').toBe(true);
  });

  it('公開版には内部の証拠更新用 npm script を含めない', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['shots:evidence']).toBeUndefined();
  });

  it('汚染ゲートは playwright 設定に結線されている（素の playwright コマンドでも走る）', () => {
    // E-2 で塞いだ穴: ゲートが npm run test:e2e:isolated にしか結線されておらず、
    // ゴールプロンプト §5 が指定する素の
    //   npx playwright test --config playwright.isolated.config.ts
    // では走らなかった（＝規定の実行経路で fail-open）。
    const config = readFileSync(join(REPO_ROOT, 'playwright.config.ts'), 'utf8');
    expect(config, 'globalTeardown が結線されていない').toContain(
      "globalTeardown: './tests/globalTeardown.ts'",
    );
    const setup = readFileSync(join(REPO_ROOT, 'tests/globalSetup.ts'), 'utf8');
    const teardown = readFileSync(join(REPO_ROOT, 'tests/globalTeardown.ts'), 'utf8');
    expect(setup, 'globalSetup が汚染スナップショットを取っていない').toContain(
      'check-worktree-dirt',
    );
    expect(teardown, 'globalTeardown が汚染検査を実行していない').toContain('check-worktree-dirt');
  });
});
