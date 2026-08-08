/**
 * 素材クランプの「配線」ガード。
 *
 * `retimeVideoInsert` の maxEnd は **任意引数**なので、呼び出し面のどれか 1 つで
 * 渡し忘れると、その経路だけクランプが silent OFF になる（ユニットテストは純関数を
 * 見ているだけなので全部緑のまま）。リサイズ経路は 3 つ（タイムライン端ドラッグ・
 * 矢印キー・インスペクタ数値入力）あり、増える可能性もあるため、
 * ソース上の全呼び出しが 5 引数であることをここで機械的に固定する。
 *
 * cssClassAudit.test.ts と同じく「ソースを走査して契約を守らせる」型のテスト。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../..');

/** src 配下の .ts/.tsx を再帰列挙（テストと ops 定義元は除く）。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * `retimeVideoInsert(` から対応する閉じ括弧までを取り出す（ネスト括弧対応）。
 * 文字列リテラル内の括弧は本用途では現れないため素朴なカウントで足りる。
 */
function callArgs(source: string, startIndex: number): string {
  let depth = 0;
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex + source.slice(startIndex).indexOf('(') + 1, i);
    }
  }
  throw new Error('unbalanced parens');
}

/** トップレベルのカンマで引数を分割する（ネストした呼び出しを1引数として数える）。 */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of args) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

describe('retimeVideoInsert の maxEnd 配線', () => {
  const callSites = sourceFiles(SRC)
    .filter((f) => !f.endsWith(join('edit', 'videoInsertOps.ts'))) // 定義元は除く
    .flatMap((file) => {
      const src = readFileSync(file, 'utf8');
      const sites: Array<{ file: string; args: string[] }> = [];
      let from = 0;
      for (;;) {
        const i = src.indexOf('retimeVideoInsert(', from);
        if (i === -1) break;
        sites.push({ file, args: splitTopLevel(callArgs(src, i)) });
        from = i + 1;
      }
      return sites;
    });

  it('リサイズ経路が 3 つぶん（計 6 呼び出し）以上見つかる（走査自体が空振りしていない）', () => {
    // 空配列に対して「全部が条件を満たす」と主張する vacuous pass を防ぐ。
    expect(callSites.length).toBeGreaterThanOrEqual(6);
  });

  it('すべての呼び出しが maxEnd（第 5 引数）を渡している', () => {
    const missing = callSites.filter((s) => s.args.length < 5).map((s) => s.file);
    expect(missing).toEqual([]);
  });

  it('maxEnd は videoInsertMaxEnd 由来の値を渡している（生の数値決め打ちにしない）', () => {
    const suspicious = callSites
      .filter((s) => !/videoInsertMaxEnd|EndLimit|endLimit/.test(s.args[4] ?? ''))
      .map((s) => `${s.file}: ${s.args[4]}`);
    expect(suspicious).toEqual([]);
  });

  /**
   * 上限は「**確定する** start」を基準に出す必要がある。左端を左へ伸ばすと尺が増え、
   * 消費するソース量も増えるため、旧 start を基準にするとデルタぶん緩い上限になり、
   * 素材の外へはみ出せてしまう。
   *
   * 「旧 start を禁止」では表現できない（start を動かさない経路＝インスペクタの終了時刻
   * 変更では `videoInsert.originalStart` が正しく“確定する start”）。よって不変条件は
   * **retimeVideoInsert へ渡す start と、上限計算へ渡す start が同じ式であること**。
   * レビュー実測で「旧 start 基準へ変異させても全テスト緑」だった穴をここで塞ぐ。
   */
  it('上限計算の start が retimeVideoInsert へ渡す start と同じ式になっている', () => {
    const mismatched = callSites
      .map((s) => {
        const start = (s.args[2] ?? '').trim();
        const limitExpr = (s.args[4] ?? '').trim();
        // videoInsertEndLimit(vi, X) / videoInsertEndLimitById(id, X) / endLimit(X) の X を取る。
        const open = limitExpr.indexOf('(');
        if (open === -1) return null;
        const inner = limitExpr.slice(open + 1, limitExpr.lastIndexOf(')'));
        const limitStart = (splitTopLevel(inner).at(-1) ?? '').trim();
        return limitStart === start ? null : `${s.file}: retime start=${start} / limit start=${limitStart}`;
      })
      .filter((x): x is string => x !== null);
    expect(mismatched).toEqual([]);
  });
});
