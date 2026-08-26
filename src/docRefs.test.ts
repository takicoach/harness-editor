/**
 * 同梱しない内部文書への「宙ぶらりん参照」を禁じる回帰テスト。
 *
 * このリポジトリは内製の設計書・レビュー記録（specs / plans / reviews）を同梱しない。
 * にもかかわらずコード内のコメントがそれらをパスで指していると、読んだ人は
 * **存在しない文書を探しに行く**（＝地図として嘘になる）。
 *
 * 規律は「参照を貼らず、規律そのものを書く」。
 *   ✗ 「spec: （同梱しない設計書のパス）」とだけ書く
 *   ○ 「項目の正本は helpTopics.ts。ここは描画だけを担い、文言を持たない。」
 *
 * 移植（別ブランチからの diff 適用）のたびに再発するため、機械で固定する。
 * 本ファイル自身は検査対象から外す — 下のアブレーション用の文字列は参照ではなく検体のため。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const SELF = resolve(import.meta.filename);
const SCAN_DIRS = ['src', 'docs', 'scripts'];
const SCAN_FILES = ['README.md', 'ARCHITECTURE.md'];
const EXT = /\.(ts|tsx|md|mjs)$/;

/**
 * 文書パスの参照を拾う。markdown リンク `[表示](パス)` を 1 トークンに潰さないよう、
 * 括弧・角括弧・引用符・空白を明示的に終端にする。
 */
const REF = /docs\/[^\s`)(\]["']+\.md/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'images' || e.name === 'img') continue;
      walk(p, out);
    } else if (EXT.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function scanTargets(): string[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) {
    const abs = join(REPO, d);
    if (existsSync(abs)) walk(abs, files);
  }
  for (const f of SCAN_FILES) {
    const abs = join(REPO, f);
    if (existsSync(abs)) files.push(abs);
  }
  return files.filter((f) => resolve(f) !== SELF);
}

/** 1 行から「実在しない文書パス」だけを抜く（本テストの述語そのもの）。 */
function danglingIn(line: string): string[] {
  return (line.match(REF) ?? []).filter((r) => !existsSync(join(REPO, r)));
}

describe('内部文書への参照', () => {
  it('コード・ドキュメントが指す文書パスはすべて実在する（同梱しない設計書を指さない）', () => {
    const dangling: string[] = [];
    for (const file of scanTargets()) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          for (const ref of danglingIn(line)) {
            dangling.push(`${file.slice(REPO.length + 1)}:${i + 1} → ${ref}`);
          }
        });
    }
    expect(dangling, `存在しない文書への参照が残っています:\n${dangling.join('\n')}`).toEqual([]);
  });

  it('述語そのものが機能する（実在しない参照を混ぜたら検出できる）', () => {
    // アブレーション: 検査が「常に空配列を返すだけ」ではないことを固定する。
    // 検体はリテラルで書かず組み立てる（このファイル自体を grep したときに拾わせない）。
    const fake = ['docs', 'specs', '2099-01-01-does-not-exist.md'].join('/');
    expect(danglingIn(`// spec: ${fake}`)).toEqual([fake]);
  });

  it('実在する文書への markdown リンクは誤検出しない', () => {
    const real = ['docs', 'claude-bridge-loop.md'].join('/');
    expect(existsSync(join(REPO, real)), '前提: 検体の文書が実在すること').toBe(true);
    expect(danglingIn(`[ブリッジ](${real}) を参照。`)).toEqual([]);
  });
});
