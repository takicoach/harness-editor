import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 作業ツリー汚染ゲート（scripts/check-worktree-dirt.mjs）自身の回帰テスト。
 *
 * 塞いだ穴（E-2）: 判定が `git status` の**行集合の差**だけだったため、
 * スナップショット時点で既に差分として載っているパスへの**再書き込み**を検出できなかった
 * （行は「状態コード＋パス」しか持たず、内容が変わっても行は変わらない）。
 * これは H-2 の事故（撮影 spec がコミット済み png を上書きする）を、作業ツリーが
 * 少しでも汚れている状態では見逃す fail-open だった。
 *
 * 使い捨ての git リポジトリを立てて、ゲートを実プロセスとして走らせて検査する。
 */

const SCRIPT = resolve(import.meta.dirname, 'check-worktree-dirt.mjs');

let repo = '';

function git(...args: string[]): void {
  execFileSync('git', args, {
    cwd: repo,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@users.noreply.github.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@users.noreply.github.com',
    },
  });
}

function gate(
  mode: 'snapshot' | 'verify',
  extraEnv: Record<string, string> = {},
): { status: number; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, mode], {
    encoding: 'utf8',
    env: { ...process.env, AAA_UPDATE_EVIDENCE: '', HARNESS_DIRT_ROOT: repo, ...extraEnv },
  });
  return { status: r.status ?? -1, stderr: r.stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dirt-gate-'));
  git('init', '-q');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'shot.png'), 'v1');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('check-worktree-dirt', () => {
  it('何も変えなければ OK（既に汚れた作業ツリーでも）', () => {
    writeFileSync(join(repo, 'docs', 'shot.png'), 'edited-by-human');
    expect(gate('snapshot').status).toBe(0);
    expect(gate('verify').status).toBe(0);
  });

  it('新しい残骸を残したら失敗する', () => {
    expect(gate('snapshot').status).toBe(0);
    writeFileSync(join(repo, 'leftover.txt'), 'x');
    const r = gate('verify');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('leftover.txt');
  });

  it('スナップショット時点で既に差分だったファイルの上書きを検出する（fail-open の回帰）', () => {
    // 人が編集中で、既に `M docs/shot.png` として status に載っている状態。
    writeFileSync(join(repo, 'docs', 'shot.png'), 'edited-by-human');
    expect(gate('snapshot').status).toBe(0);
    // テストランがその上から別内容を書く（＝H-2 の事故そのもの）。status の行は変わらない。
    writeFileSync(join(repo, 'docs', 'shot.png'), 'overwritten-by-test');
    const r = gate('verify');
    expect(r.status, '行が同じなので素通りしている（内容ハッシュを見ていない）').toBe(1);
    expect(r.stderr).toContain('docs/shot.png');
  });

  it('未追跡ファイルの上書きも検出する', () => {
    writeFileSync(join(repo, 'untracked.png'), 'a');
    expect(gate('snapshot').status).toBe(0);
    writeFileSync(join(repo, 'untracked.png'), 'b');
    const r = gate('verify');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('untracked.png');
  });

  it('スナップショット時点で存在した未追跡ファイルの削除を検出する（片方向突合の回帰）', () => {
    // 人の作業中ファイル（未追跡）。ランがこれを消しても、消えたパスは after 側の
    // 行にもハッシュにも現れないため、after→before の片方向突合では素通りしていた。
    writeFileSync(join(repo, 'work-note.md'), 'メモ');
    expect(gate('snapshot').status).toBe(0);
    rmSync(join(repo, 'work-note.md'));
    const r = gate('verify');
    expect(r.status, '削除が素通りしている（before 側からの突合が無い）').toBe(1);
    expect(r.stderr).toContain('work-note.md');
  });

  // 証拠更新ラン（npm run shots:evidence）の限定除外。除外はこの1ディレクトリだけに閉じる。
  describe('AAA_UPDATE_EVIDENCE=1（証拠更新ラン）', () => {
    const evidence = 'docs/reports/aaa-screenshots/E-2/notes-light.png';

    it('証拠 png の更新は汚染としない（正規の再生成手順が赤にならない）', () => {
      mkdirSync(join(repo, 'docs/reports/aaa-screenshots/E-2'), { recursive: true });
      writeFileSync(join(repo, evidence), 'old');
      git('add', '-A');
      git('commit', '-q', '-m', 'evidence');
      expect(gate('snapshot').status).toBe(0);
      writeFileSync(join(repo, evidence), 'regenerated');
      expect(gate('verify', { AAA_UPDATE_EVIDENCE: '1' }).status).toBe(0);
    });

    it('通常ラン（env 無し）では同じ更新を汚染として落とす', () => {
      mkdirSync(join(repo, 'docs/reports/aaa-screenshots/E-2'), { recursive: true });
      writeFileSync(join(repo, evidence), 'old');
      git('add', '-A');
      git('commit', '-q', '-m', 'evidence');
      expect(gate('snapshot').status).toBe(0);
      writeFileSync(join(repo, evidence), 'regenerated');
      const r = gate('verify');
      expect(r.status, '通常ランで証拠 png を上書きしても素通りしている').toBe(1);
      expect(r.stderr).toContain('notes-light.png');
    });

    it('証拠ディレクトリの外は AAA_UPDATE_EVIDENCE=1 でも汚染として落とす', () => {
      expect(gate('snapshot').status).toBe(0);
      writeFileSync(join(repo, 'leftover.txt'), 'x');
      writeFileSync(join(repo, 'docs', 'shot.png'), 'overwritten');
      const r = gate('verify', { AAA_UPDATE_EVIDENCE: '1' });
      expect(r.status, '証拠更新ランが全域の免罪符になっている').toBe(1);
      expect(r.stderr).toContain('leftover.txt');
      expect(r.stderr).toContain('docs/shot.png');
    });
  });

  it('スナップショット無しで verify すると 2 で落ちる（黙って通さない）', () => {
    const r = gate('verify');
    expect(r.status).toBe(2);
  });
});
