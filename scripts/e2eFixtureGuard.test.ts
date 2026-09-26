import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { disposableFixtureDirs, trackedFixtureDirs } from '../tests/globalSetup';

/**
 * e2e の globalSetup が「前回ランの残骸」を消すときに、**git 追跡下のフィクスチャまで
 * 消してしまわない**ことを固定する。
 *
 * 塞いだ穴（E-2）: 以前は残す対象が
 * `KEEP = ['sample-project','misaligned-project','golden','m3-transitions']` という
 * ハードコードの許可リストで、リストに無いディレクトリを無条件に rmSync していた。
 * つまり**将来 git 追跡下のフィクスチャを 1 つ足すと、e2e を回した瞬間に作業ツリーから
 * 黙って消える**（追加直後・コミット前なら復元できない）。許可リストの更新漏れは
 * 誰にも気づかれないまま壊れる＝検出できない穴なので、判断材料を「追跡下かどうか」
 * という git の事実に置き換えた。
 */

const FIXTURES_ROOT = resolve(import.meta.dirname, '../src/server/__fixtures__');

describe('e2e フィクスチャの掃除ガード', () => {
  it('git が追跡下と答えたディレクトリは、許可リストに無くても消さない', () => {
    // 「将来足された追跡下フィクスチャ」を模した名前。旧実装（ハードコード KEEP）では
    // 許可リストに無いので消す対象に入ってしまう。
    const entries = ['sample-project', 'brand-new-fixture', 'render-btn-tmp-1756-0'];
    const tracked = new Set(['sample-project', 'brand-new-fixture']);
    expect(disposableFixtureDirs(entries, tracked)).toEqual(['render-btn-tmp-1756-0']);
  });

  it('未追跡の残骸とドット始まりの扱いは変えない', () => {
    const entries = ['.fixture-snapshot', 'heavy-job-tmp-1-2', 'sample-project'];
    expect(disposableFixtureDirs(entries, new Set(['sample-project']))).toEqual([
      'heavy-job-tmp-1-2',
    ]);
  });

  it('追跡下が 0 件なら掃除を中止する（fail-closed・全消しへの退化を止める）', () => {
    // git 履歴の無いコピー（ZIP 展開等）で `git ls-files` が空を返すと、
    // 「残していい名前」が全滅し、この関数は sample-project まで削除対象として返してしまう。
    // 削除の判断材料が無くなったときは削除しない。
    expect(() => disposableFixtureDirs(['sample-project', 'tmp-1'], new Set())).toThrow(
      /追跡下フィクスチャが 0 件/,
    );
  });

  it('存在検査: git は実在する常設フィクスチャを追跡下として返す', () => {
    // 「追跡下が空集合」だと上の判定は全消しに退化する。空でないことを実測で確かめる
    // （空の集合はいつでも綺麗に見える）。
    const tracked = trackedFixtureDirs();
    expect(tracked.size).toBeGreaterThan(0);
    for (const name of ['sample-project', 'misaligned-project']) {
      expect(tracked.has(name), `${name} が追跡下として返らない`).toBe(true);
      expect(existsSync(join(FIXTURES_ROOT, name))).toBe(true);
    }
  });

  it('実リポジトリで、いま存在する追跡下ディレクトリは1つも消す対象にならない', () => {
    const tracked = trackedFixtureDirs();
    const entries = readdirSync(FIXTURES_ROOT).filter((n) =>
      statSync(join(FIXTURES_ROOT, n)).isDirectory(),
    );
    const doomed = disposableFixtureDirs(entries, tracked).filter((n) => tracked.has(n));
    expect(doomed, '追跡下のフィクスチャを消そうとしている').toEqual([]);
  });
});
