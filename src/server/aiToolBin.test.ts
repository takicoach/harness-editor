import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeChildProcess from 'node:child_process';
import {
  findTool, resolveToolForPty, managedRuntimeDir,
  isVersionAtLeast, parseVersion, checkToolVersion, clearToolCache,
} from './aiToolBin';
import { AI_TOOLS } from './aiTools';

// findTool/checkToolVersion のキャッシュ効果テスト用（Minor 1）: deps 注入時は
// キャッシュを迂回する仕様になったため、既定経路（deps 無し）でキャッシュが効くことを
// execFileSync の呼び出し回数で検証する。vi.spyOn は ESM の named export（Module
// namespace）を再定義できず失敗するため、vi.mock で実体をラップした vi.fn に差し替える
// （実装は素通しするので他の挙動は変わらない。実バイナリは起動しない — 詳細は各 it 内）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function makeEditorDir(): string {
  return mkdtempSync(join(tmpdir(), 'sme-aitoolbin-'));
}

// findTool/checkToolVersion はプロセス内キャッシュ（TTL 5秒）を持つ。テスト間で
// 前のテストの which/run 注入結果を誤って再利用しないよう、各テストの前後で消す。
beforeEach(() => {
  clearToolCache();
  vi.mocked(nodeChildProcess.execFileSync).mockClear();
});
afterEach(() => clearToolCache());

describe('findTool', () => {
  it('which が返せばグローバルを優先する', () => {
    const dir = makeEditorDir();
    try {
      const loc = findTool(AI_TOOLS.claude, dir, { which: () => '/usr/local/bin/claude' });
      expect(loc).toEqual({ file: '/usr/local/bin/claude', args: [], source: 'global' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('which には各ツールの binName を渡す', () => {
    const dir = makeEditorDir();
    try {
      const asked: string[] = [];
      findTool(AI_TOOLS.codex, dir, { which: (b) => { asked.push(b); return null; } });
      expect(asked).toEqual(['codex']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('claude はグローバルが無ければ管理ディレクトリを見る', () => {
    const dir = makeEditorDir();
    try {
      const binDir = join(managedRuntimeDir(dir), 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      const loc = findTool(AI_TOOLS.claude, dir, { which: () => null });
      expect(loc?.source).toBe('managed');
      expect(loc?.file).toBe(bin);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('installPackage が null のツール（codex）は管理ディレクトリを探さない', () => {
    const dir = makeEditorDir();
    try {
      const binDir = join(managedRuntimeDir(dir), 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      expect(findTool(AI_TOOLS.codex, dir, { which: () => null })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('どちらも無ければ null', () => {
    const dir = makeEditorDir();
    try {
      expect(findTool(AI_TOOLS.claude, dir, { which: () => null })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('resolveToolForPty の差し替えゲート', () => {
  it('VITEST=1 なら .mjs 差し替えを node 実行形で受け付ける', () => {
    const dir = makeEditorDir();
    try {
      const fake = join(dir, 'fake.mjs');
      writeFileSync(fake, 'console.log("fake")\n');
      const loc = resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: fake, VITEST: '1' });
      expect(loc).toEqual({ file: process.execPath, args: [fake], source: 'test-override' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('codex は SME_CODEX_BIN を見る（SME_CLAUDE_BIN では差し替わらない）', () => {
    const dir = makeEditorDir();
    try {
      const fake = join(dir, 'fake-codex.mjs');
      writeFileSync(fake, '');
      expect(
        resolveToolForPty(AI_TOOLS.codex, dir, { SME_CODEX_BIN: fake, VITEST: '1' })?.source,
      ).toBe('test-override');
      expect(
        resolveToolForPty(AI_TOOLS.codex, dir, { SME_CLAUDE_BIN: fake, VITEST: '1' }, { which: () => null }),
      ).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('VITEST 外では tests/fixtures 配下のパスだけ受け付ける', () => {
    const dir = makeEditorDir();
    try {
      const fixDir = join(dir, 'tests', 'fixtures');
      mkdirSync(fixDir, { recursive: true });
      const inside = join(fixDir, 'fake.mjs');
      writeFileSync(inside, '');
      const outside = join(dir, 'evil.mjs');
      writeFileSync(outside, '');
      expect(resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: inside })?.source).toBe('test-override');
      expect(
        resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: outside }, { which: () => null }),
      ).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tests/fixtures と前方一致するだけの兄弟ディレクトリは拒否する', () => {
    const dir = makeEditorDir();
    try {
      const evilDir = join(dir, 'tests', 'fixtures-evil');
      mkdirSync(evilDir, { recursive: true });
      const evil = join(evilDir, 'fake.mjs');
      writeFileSync(evil, '');
      expect(
        resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: evil }, { which: () => null }),
      ).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // ここが今回塞ぐ穴: Boolean('0') は true なので旧実装ではゲートが開いてしまった。
  it.each([['0'], [''], ['false'], ['no']])(
    'VITEST=%j ではゲートを開かない（fixtures 外は拒否）',
    (vitestValue) => {
      const dir = makeEditorDir();
      try {
        const outside = join(dir, 'evil.mjs');
        writeFileSync(outside, '');
        expect(
          resolveToolForPty(
            AI_TOOLS.claude, dir,
            { SME_CLAUDE_BIN: outside, VITEST: vitestValue },
            { which: () => null },
          ),
        ).toBeNull();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it('VITEST=true でもゲートは開く（vitest の実際の値）', () => {
    const dir = makeEditorDir();
    try {
      const outside = join(dir, 'ok.mjs');
      writeFileSync(outside, '');
      expect(
        resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: outside, VITEST: 'true' })?.source,
      ).toBe('test-override');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('parseVersion', () => {
  it('codex --version の出力から版を取り出す', () => {
    expect(parseVersion('codex-cli 0.145.0')).toBe('0.145.0');
  });
  it('claude --version 形式も取り出す', () => {
    expect(parseVersion('2.1.220 (Claude Code)')).toBe('2.1.220');
  });
  it('版が見つからなければ null', () => {
    expect(parseVersion('command not found')).toBeNull();
  });
});

describe('isVersionAtLeast', () => {
  it.each([
    ['0.145.0', '0.145.0', true],
    ['0.145.1', '0.145.0', true],
    ['0.146.0', '0.145.0', true],
    ['1.0.0', '0.145.0', true],
    ['0.144.9', '0.145.0', false],
    ['0.99.0', '0.145.0', false],   // 数値比較（文字列比較なら誤って true になる）
    ['0.9.0', '0.145.0', false],
  ])('%s >= %s は %s', (actual, min, expected) => {
    expect(isVersionAtLeast(actual, min)).toBe(expected);
  });
});

describe('checkToolVersion', () => {
  const loc = { file: '/usr/local/bin/codex', args: [], source: 'global' as const };

  it('最低版を満たせば ok', () => {
    expect(checkToolVersion(AI_TOOLS.codex, loc, { run: () => 'codex-cli 0.145.0' })).toEqual({ ok: true });
  });

  it('下回れば found 付きで拒否する', () => {
    expect(checkToolVersion(AI_TOOLS.codex, loc, { run: () => 'codex-cli 0.140.0' }))
      .toEqual({ ok: false, found: '0.140.0' });
  });

  it('minVersion が null のツールは常に ok（--version を実行しない）', () => {
    let called = false;
    expect(checkToolVersion(AI_TOOLS.claude, loc, { run: () => { called = true; return ''; } }))
      .toEqual({ ok: true });
    expect(called).toBe(false);
  });

  it('--version が失敗しても throw せず ok にする（版が読めないだけで機能を止めない）', () => {
    expect(checkToolVersion(AI_TOOLS.codex, loc, { run: () => { throw new Error('boom'); } }))
      .toEqual({ ok: true });
  });
});

/**
 * GET /api/ai/tools は毎リクエストで Object.values(AI_TOOLS) の数だけ findTool/
 * checkToolVersion を呼ぶ。どちらも execFileSync の同期呼び出しを含み、Vite dev サーバーは
 * 単一スレッドなのでキャッシュ無しだと全リクエストが毎回ブロックされる（外部レビュー
 * Important 2）。ここではキャッシュが実際に効くこと・TTL/明示クリアで再実行されること・
 * editorDir が違えば混ざらないことを確認する。
 */
describe('findTool のキャッシュ', () => {
  // Minor 1: deps.which を注入するとキャッシュを迂回する仕様になった（テスト隔離を
  // beforeEach(clearToolCache) だけに依存させないため）。そのためここでは「注入なし」
  // （本番と同じ既定経路）でキャッシュが効くことを検証する。実バイナリを起動しないよう、
  // 存在しない binName を持つ偽アダプタを使う（which/where 自体は実行されるが対象が
  // 見つからず即 null を返すだけで安全）。呼び出し回数は defaultWhich が内部で呼ぶ
  // execFileSync をスパイして数える。
  const fakeTool = { ...AI_TOOLS.claude, binName: 'sme-nonexistent-bin-for-cache-test' };

  it('TTL 内の再呼び出しは which（execFileSync）を再実行しない', () => {
    const dir = makeEditorDir();
    const spy = vi.mocked(nodeChildProcess.execFileSync);
    try {
      findTool(fakeTool, dir);
      findTool(fakeTool, dir);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('editorDir が違えばキャッシュを共有しない', () => {
    const dirA = makeEditorDir();
    const dirB = makeEditorDir();
    const spy = vi.mocked(nodeChildProcess.execFileSync);
    try {
      findTool(fakeTool, dirA);
      findTool(fakeTool, dirB);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('clearToolCache() を呼ぶと次回は再実行する（導入完了直後の反映用）', () => {
    const dir = makeEditorDir();
    const spy = vi.mocked(nodeChildProcess.execFileSync);
    try {
      findTool(fakeTool, dir);
      clearToolCache();
      findTool(fakeTool, dir);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('TTL（5秒）が過ぎたら再実行する', () => {
    const dir = makeEditorDir();
    const spy = vi.mocked(nodeChildProcess.execFileSync);
    try {
      vi.useFakeTimers();
      findTool(fakeTool, dir);
      vi.advanceTimersByTime(5_001);
      findTool(fakeTool, dir);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deps.which を注入すると（テスト差し替え時）キャッシュを迂回し毎回呼ばれる（Minor 1）', () => {
    const dir = makeEditorDir();
    try {
      const which = vi.fn(() => null);
      findTool(AI_TOOLS.claude, dir, { which });
      findTool(AI_TOOLS.claude, dir, { which });
      expect(which).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkToolVersion のキャッシュ', () => {
  // Minor 1: deps.run を注入するとキャッシュを迂回する仕様になったため、ここでは
  // 「注入なし」（本番と同じ既定経路）でキャッシュが効くことを検証する。実バイナリを
  // 起動しないよう、存在しないファイルパスを loc.file に使う（execFileSync は ENOENT で
  // 失敗するだけ。checkToolVersion は失敗時 ok:true へ fail-open するため安全に完走する）。
  const loc = { file: '/nonexistent/sme-cache-test-codex-binary', args: [], source: 'global' as const };

  it('TTL 内の再呼び出しは run（execFileSync）を再実行しない', () => {
    const spy = vi.mocked(nodeChildProcess.execFileSync);
    checkToolVersion(AI_TOOLS.codex, loc);
    checkToolVersion(AI_TOOLS.codex, loc);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('loc（file/source）が違えばキャッシュを共有しない', () => {
    const spy = vi.mocked(nodeChildProcess.execFileSync);
    checkToolVersion(AI_TOOLS.codex, loc);
    checkToolVersion(AI_TOOLS.codex, { ...loc, file: '/nonexistent/sme-cache-test-codex-other' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('clearToolCache() を呼ぶと次回は再実行する', () => {
    const spy = vi.mocked(nodeChildProcess.execFileSync);
    checkToolVersion(AI_TOOLS.codex, loc);
    clearToolCache();
    checkToolVersion(AI_TOOLS.codex, loc);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('deps.run を注入すると（テスト差し替え時）キャッシュを迂回し毎回呼ばれる（Minor 1）', () => {
    const run = vi.fn(() => 'codex-cli 0.145.0');
    checkToolVersion(AI_TOOLS.codex, loc, { run });
    checkToolVersion(AI_TOOLS.codex, loc, { run });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
