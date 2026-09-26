import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import * as nodeChildProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  findTool, resolveToolForPty, managedRuntimeDir, knownToolDirs,
  isVersionAtLeast, parseVersion, checkToolVersion, clearToolCache, CANDIDATE_TIMEOUT_MS,
} from './aiToolBin';
import { AI_TOOLS } from './aiTools';

// findTool/checkToolVersion のキャッシュ効果テスト用（Minor 1）: 注入時は
// キャッシュを迂回する仕様になったため、既定経路（注入無し）でキャッシュが効くことを
// execFile の呼び出し回数で検証する。vi.spyOn は ESM の named export（Module
// namespace）を再定義できず失敗するため、vi.mock で実体をラップした vi.fn に差し替える
// （実装は素通しするので他の挙動は変わらない。実バイナリは起動しない — 詳細は各 it 内）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

function makeEditorDir(): string {
  return mkdtempSync(join(tmpdir(), 'sme-aitoolbin-'));
}

// findTool/checkToolVersion はプロセス内キャッシュ（TTL 5秒）を持つ。テスト間で
// 前のテストの which/exec 注入結果を誤って再利用しないよう、各テストの前後で消す。
/** vi.mock 直後の実体（actual.execFile）。差し替えたテストの後始末で戻す。 */
let realExecFile: typeof nodeChildProcess.execFile | undefined;

beforeEach(() => {
  clearToolCache();
  realExecFile ??= vi.mocked(nodeChildProcess.execFile).getMockImplementation() as typeof nodeChildProcess.execFile;
  vi.mocked(nodeChildProcess.execFile).mockImplementation(realExecFile);
  vi.mocked(nodeChildProcess.execFile).mockClear();
});

/** kill スパイだけ持つ最小の ChildProcess 互換フェイク。 */
function fakeChild(kill: () => boolean = () => true): ChildProcess {
  return { kill } as unknown as ChildProcess;
}
afterEach(() => clearToolCache());

describe('findTool', () => {
  it('which が返せば PATH を優先する', async () => {
    const dir = makeEditorDir();
    try {
      const shim = join(dir, 'claude'); writeFileSync(shim, '#!/bin/sh\n'); chmodSync(shim, 0o755);
      const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, which: async () => shim, knownDirs: [], loginShell: async () => null });
      expect(loc).toEqual({ file: shim, args: [], path: shim, source: 'path' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('which には各ツールの binName を渡す', async () => {
    const dir = makeEditorDir();
    try {
      const asked: string[] = [];
      await findTool(AI_TOOLS.codex, { editorDir: dir, which: async (b) => { asked.push(b); return null; }, loginShell: async () => null });
      expect(asked).toEqual(['codex']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('claude は PATH に無ければ管理ディレクトリを見る', async () => {
    const dir = makeEditorDir();
    try {
      const binDir = join(managedRuntimeDir(dir), 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, which: async () => null, knownDirs: [], loginShell: async () => null });
      expect(loc?.source).toBe('managed');
      expect(loc?.file).toBe(bin);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('installPackage が null のツール（codex）は管理ディレクトリを探さない', async () => {
    const dir = makeEditorDir();
    try {
      const binDir = join(managedRuntimeDir(dir), 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      expect(await findTool(AI_TOOLS.codex, { editorDir: dir, which: async () => null, knownDirs: [], loginShell: async () => null })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('どこにも無ければ null', async () => {
    const dir = makeEditorDir();
    try {
      expect(await findTool(AI_TOOLS.claude, { editorDir: dir, which: async () => null, knownDirs: [], loginShell: async () => null })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('findTool の探索順（非同期）', () => {
  it('PATH を既知の置き場より優先する（ユーザーが普段使う版を掴む）', async () => {
    // PATH 段も accept()（実在・実行可能）を通るため、which の返り値は実在する実行ファイルにする。
    const dir = makeEditorDir(), known = join(dir, 'known'), onPath = join(dir, 'path');
    mkdirSync(known, { recursive: true }); mkdirSync(onPath, { recursive: true });
    const shim = join(known, 'claude'); writeFileSync(shim, '#!/bin/sh\n'); chmodSync(shim, 0o755);
    const preferred = join(onPath, 'claude'); writeFileSync(preferred, '#!/bin/sh\n'); chmodSync(preferred, 0o755);
    const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, knownDirs: [known], which: async () => preferred, loginShell: async () => null });
    expect(loc).toMatchObject({ source: 'path', file: preferred });
  });
  it('PATH に無ければ既知の置き場の実行可能ファイルを採る', async () => {
    const dir = makeEditorDir(), known = join(dir, 'known');
    mkdirSync(known, { recursive: true });
    const shim = join(known, 'claude'); writeFileSync(shim, '#!/bin/sh\n'); chmodSync(shim, 0o755);
    const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, knownDirs: [known], which: async () => null, loginShell: async () => null });
    expect(loc).toMatchObject({ source: 'known-dir', file: shim, path: shim });
  });
  it('PATH に ~/.local/bin が無くても既知の置き場から claude を見つける（2026-09-16 の再現）', async () => {
    // ランチャー経由でない起動（Finder/ダブルクリック）だと PATH に ~/.local/bin が無く
    // 「Codex しか見えない」の実測原因になった。既知の置き場（knownDirs）が
    // ~/.local/bin 相当でも which=null のとき見つかることを固定する。
    const dir = makeEditorDir(), known = join(dir, '.local', 'bin');
    mkdirSync(known, { recursive: true });
    const shim = join(known, 'claude'); writeFileSync(shim, '#!/bin/sh\n'); chmodSync(shim, 0o755);
    const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, knownDirs: [known], which: async () => null, loginShell: async () => null });
    expect(loc?.file).toBe(shim);
    expect(loc?.source).toBe('known-dir');
  });
  it('実行できないファイルは飛ばす', async () => {
    const dir = makeEditorDir(), known = join(dir, 'known');
    mkdirSync(known, { recursive: true });
    const shim = join(known, 'claude'); writeFileSync(shim, 'x'); chmodSync(shim, 0o644);
    expect(await findTool(AI_TOOLS.claude, { editorDir: dir, knownDirs: [known], which: async () => null, loginShell: async () => null })).toBeNull();
  });
  it('最後の手段としてログインシェルに聞く', async () => {
    const dir = makeEditorDir();
    const shim = join(dir, 'claude'); writeFileSync(shim, '#!/bin/sh\n'); chmodSync(shim, 0o755);
    const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, knownDirs: [], which: async () => null, loginShell: async () => shim });
    expect(loc).toMatchObject({ source: 'login-shell' });
  });
  it('同時に呼ばれても探索は 1 回だけ（in-flight 共有）', async () => {
    const dir = makeEditorDir();
    clearToolCache();
    let calls = 0;
    const which = async (): Promise<string | null> => { calls++; await new Promise(done => setTimeout(done, 10)); return null; };
    const opts = { editorDir: dir, which, knownDirs: [], loginShell: async () => null };
    await Promise.all([findTool(AI_TOOLS.claude, opts), findTool(AI_TOOLS.claude, opts)]);
    expect(calls).toBe(1);
  });
});

describe('resolveToolForPty の差し替えゲート', () => {
  it('VITEST=1 なら .mjs 差し替えを node 実行形で受け付ける', async () => {
    const dir = makeEditorDir();
    try {
      const fake = join(dir, 'fake.mjs');
      writeFileSync(fake, 'console.log("fake")\n');
      const loc = await resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: fake, VITEST: '1' });
      expect(loc).toEqual({ file: process.execPath, args: [fake], path: fake, source: 'test-override' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('codex は SME_CODEX_BIN を見る（SME_CLAUDE_BIN では差し替わらない）', async () => {
    const dir = makeEditorDir();
    try {
      const fake = join(dir, 'fake-codex.mjs');
      writeFileSync(fake, '');
      expect(
        (await resolveToolForPty(AI_TOOLS.codex, dir, { SME_CODEX_BIN: fake, VITEST: '1' }))?.source,
      ).toBe('test-override');
      expect(
        await resolveToolForPty(AI_TOOLS.codex, dir, { SME_CLAUDE_BIN: fake, VITEST: '1' }, { which: async () => null, knownDirs: [], loginShell: async () => null }),
      ).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('VITEST 外では tests/fixtures 配下のパスだけ受け付ける', async () => {
    const dir = makeEditorDir();
    try {
      const fixDir = join(dir, 'tests', 'fixtures');
      mkdirSync(fixDir, { recursive: true });
      const inside = join(fixDir, 'fake.mjs');
      writeFileSync(inside, '');
      const outside = join(dir, 'evil.mjs');
      writeFileSync(outside, '');
      expect((await resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: inside }))?.source).toBe('test-override');
      expect(
        await resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: outside }, { which: async () => null, knownDirs: [], loginShell: async () => null }),
      ).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tests/fixtures と前方一致するだけの兄弟ディレクトリは拒否する', async () => {
    const dir = makeEditorDir();
    try {
      const evilDir = join(dir, 'tests', 'fixtures-evil');
      mkdirSync(evilDir, { recursive: true });
      const evil = join(evilDir, 'fake.mjs');
      writeFileSync(evil, '');
      expect(
        await resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: evil }, { which: async () => null, knownDirs: [], loginShell: async () => null }),
      ).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // ここが今回塞ぐ穴: Boolean('0') は true なので旧実装ではゲートが開いてしまった。
  it.each([['0'], [''], ['false'], ['no']])(
    'VITEST=%j ではゲートを開かない（fixtures 外は拒否）',
    async (vitestValue) => {
      const dir = makeEditorDir();
      try {
        const outside = join(dir, 'evil.mjs');
        writeFileSync(outside, '');
        expect(
          await resolveToolForPty(
            AI_TOOLS.claude, dir,
            { SME_CLAUDE_BIN: outside, VITEST: vitestValue },
            { which: async () => null, knownDirs: [], loginShell: async () => null },
          ),
        ).toBeNull();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it('VITEST=true でもゲートは開く（vitest の実際の値）', async () => {
    const dir = makeEditorDir();
    try {
      const outside = join(dir, 'ok.mjs');
      writeFileSync(outside, '');
      expect(
        (await resolveToolForPty(AI_TOOLS.claude, dir, { SME_CLAUDE_BIN: outside, VITEST: 'true' }))?.source,
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
  const loc = { file: '/usr/local/bin/codex', args: [], path: '/usr/local/bin/codex', source: 'path' as const };

  it('最低版を満たせば ok', async () => {
    expect(await checkToolVersion(AI_TOOLS.codex, loc, { exec: async () => 'codex-cli 0.145.0' })).toEqual({ ok: true });
  });

  it('下回れば found 付きで拒否する', async () => {
    expect(await checkToolVersion(AI_TOOLS.codex, loc, { exec: async () => 'codex-cli 0.140.0' }))
      .toEqual({ ok: false, found: '0.140.0' });
  });

  it('minVersion が null のツールは常に ok（--version を実行しない）', async () => {
    let called = false;
    expect(await checkToolVersion(AI_TOOLS.claude, loc, { exec: async () => { called = true; return ''; } }))
      .toEqual({ ok: true });
    expect(called).toBe(false);
  });

  it('--version が失敗したら unverified（成功扱いにしない）', async () => {
    expect(await checkToolVersion(AI_TOOLS.codex, loc, { exec: async () => { throw new Error('boom'); } }))
      .toEqual({ ok: 'unverified' });
  });
});

// T24 Minor: bypassCache の分岐は deps.exec を注入すると通らない（exec が先に効く）。
// 実行ファイルを一時フォルダに置いて既定経路を通し、分岐そのものを直接確かめる。
describe('checkToolVersion の bypassCache', () => {
  it('キャッシュ済みでも --version を叩き直し、その結果でキャッシュを塗り替えない', async () => {
    const dir = makeEditorDir();
    try {
      const script = join(dir, 'codex'), version = join(dir, 'version.txt');
      writeFileSync(script, `#!/bin/sh\ncat ${JSON.stringify(version)}\n`);
      chmodSync(script, 0o755);
      writeFileSync(version, 'codex-cli 0.145.0\n');
      const loc = { file: script, args: [], path: script, source: 'path' as const };
      expect(await checkToolVersion(AI_TOOLS.codex, loc)).toEqual({ ok: true });
      writeFileSync(version, 'codex-cli 0.140.0\n');
      // 既定経路は TTL 内なのでキャッシュをそのまま返す（＝叩き直さない）。
      expect(await checkToolVersion(AI_TOOLS.codex, loc)).toEqual({ ok: true });
      // 「再確認」はキャッシュを素通しして毎回叩き直す。
      expect(await checkToolVersion(AI_TOOLS.codex, loc, { bypassCache: true })).toEqual({ ok: false, found: '0.140.0' });
      // 迂回した結果でキャッシュは塗り替えない（次の既定経路は元の値のまま）。
      expect(await checkToolVersion(AI_TOOLS.codex, loc)).toEqual({ ok: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkToolVersion の 4 状態', () => {
  it('--version が失敗したら unverified（成功扱いにしない）', async () => {
    const loc = { file: '/usr/local/bin/codex', args: [], path: '/usr/local/bin/codex', source: 'path' as const };
    expect(await checkToolVersion(AI_TOOLS.codex, loc, { exec: async () => { throw new Error('boom'); } })).toEqual({ ok: 'unverified' });
  });
  it('版が読めないときも unverified', async () => {
    const loc = { file: '/usr/local/bin/codex', args: [], path: '/usr/local/bin/codex', source: 'path' as const };
    expect(await checkToolVersion(AI_TOOLS.codex, loc, { exec: async () => 'codex-cli (unknown build)' })).toEqual({ ok: 'unverified' });
  });
  it('古い版は found つきで落とす', async () => {
    const loc = { file: '/usr/local/bin/codex', args: [], path: '/usr/local/bin/codex', source: 'path' as const };
    expect(await checkToolVersion(AI_TOOLS.codex, loc, { exec: async () => 'codex-cli 0.140.0' })).toEqual({ ok: false, found: '0.140.0' });
  });
});

describe('knownToolDirs', () => {
  it('~/.local/bin と ~/.claude/local を含む', () => {
    const dirs = knownToolDirs({ HOME: '/home/t' } as NodeJS.ProcessEnv);
    expect(dirs).toContain('/home/t/.local/bin');
    expect(dirs).toContain('/home/t/.claude/local');
  });

  // C2: HOME/USERPROFILE（win32 は APPDATA も）が無い環境で home 由来の候補を組むと
  // '.local/bin' のような**相対パス**になり、起動時の cwd 次第で意図しない実行ファイルを
  // 拾いうる。相対候補は 1 つも出してはいけない。
  it('HOME が無ければ home 由来の相対候補を出さない', () => {
    const dirs = knownToolDirs({} as NodeJS.ProcessEnv);
    expect(dirs.every((d) => d !== '' && isAbsolute(d))).toBe(true);
    expect(dirs.some((d) => d.includes('undefined'))).toBe(false);
  });

  it('HOME が空文字でも相対候補を出さない', () => {
    const dirs = knownToolDirs({ HOME: '', USERPROFILE: '', APPDATA: '' } as NodeJS.ProcessEnv);
    expect(dirs.every((d) => isAbsolute(d))).toBe(true);
  });
});

/**
 * GET /api/ai/tools は毎リクエストで Object.values(AI_TOOLS) の数だけ findTool/
 * checkToolVersion を呼ぶ。どちらも子プロセスの起動を含む。ここではキャッシュが実際に
 * 効くこと・TTL/明示クリアで再実行されること・editorDir が違えば混ざらないことを確認する。
 *
 * Important 7: 以前はここだけ「注入無し」で回していたため、既定の探索経路が**実際の
 * ログインシェル（zsh -lc）を起動**していた（1 テスト数秒）。注入したまま
 * 呼び出し回数を数える形にして、テストからは外部プロセスを一切起動しない。
 * キャッシュ迂回は注入の有無ではなく明示フラグ `bypassCache` で行う。
 */
describe('findTool のキャッシュ', () => {
  /** 外部プロセスを起動しない探索スタブ（どこにも見つからない）。 */
  function stub() {
    return { which: vi.fn(async (): Promise<string | null> => null), knownDirs: [] as string[], loginShell: vi.fn(async (): Promise<string | null> => null) };
  }

  it('TTL 内の再呼び出しは探索し直さない', async () => {
    const dir = makeEditorDir();
    const s = stub();
    try {
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s });
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s });
      expect(s.which).toHaveBeenCalledTimes(1);
      expect(s.loginShell).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('editorDir が違えばキャッシュを共有しない', async () => {
    const dirA = makeEditorDir();
    const dirB = makeEditorDir();
    const s = stub();
    try {
      await findTool(AI_TOOLS.claude, { editorDir: dirA, ...s });
      await findTool(AI_TOOLS.claude, { editorDir: dirB, ...s });
      expect(s.which).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('clearToolCache() を呼ぶと次回は再実行する（導入完了直後の反映用）', async () => {
    const dir = makeEditorDir();
    const s = stub();
    try {
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s });
      clearToolCache();
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s });
      expect(s.which).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('TTL（5秒）が過ぎたら再実行する', async () => {
    const dir = makeEditorDir();
    const s = stub();
    vi.useFakeTimers();
    try {
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s });
      vi.advanceTimersByTime(5_001);
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s });
      expect(s.which).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Important 7: 注入の有無ではなく明示フラグでキャッシュを切る。
  it('bypassCache: true はキャッシュを読み書きしない', async () => {
    const dir = makeEditorDir();
    const s = stub();
    try {
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s, bypassCache: true });
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s, bypassCache: true });
      expect(s.which).toHaveBeenCalledTimes(2);
      // bypassCache の結果はキャッシュに載らないので、通常呼び出しも探索し直す。
      await findTool(AI_TOOLS.claude, { editorDir: dir, ...s });
      expect(s.which).toHaveBeenCalledTimes(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Important 4: 探索の走行中に clearToolCache() が入ったら、その探索の結果は
  // 「クリア前の世界」の観測なのでキャッシュに載せてはいけない（導入完了直後に
  // 古い not-found が 5 秒間居座る）。
  it('探索中に clearToolCache() されたら完了しても結果をキャッシュしない', async () => {
    const dir = makeEditorDir();
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const which = vi.fn(async (): Promise<string | null> => { await gate; return null; });
    const opts = { editorDir: dir, which, knownDirs: [] as string[], loginShell: async (): Promise<string | null> => null };
    try {
      const pending = findTool(AI_TOOLS.claude, opts);
      await Promise.resolve();
      clearToolCache();
      release();
      await pending;
      await findTool(AI_TOOLS.claude, opts);
      expect(which).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkToolVersion のキャッシュ', () => {
  // deps.exec を注入するとキャッシュを迂回する仕様。ここでは「注入なし」（本番と同じ
  // 既定経路）でキャッシュが効くことを検証する。実バイナリを起動しないよう、存在しない
  // ファイルパスを loc.file に使う（execFile は ENOENT で失敗するだけ。checkToolVersion は
  // 失敗時 unverified に落ちるため安全に完走する）。
  const loc = { file: '/nonexistent/sme-cache-test-codex-binary', args: [], path: '/nonexistent/sme-cache-test-codex-binary', source: 'path' as const };

  it('TTL 内の再呼び出しは execFile を再実行しない', async () => {
    const spy = vi.mocked(nodeChildProcess.execFile);
    await checkToolVersion(AI_TOOLS.codex, loc);
    await checkToolVersion(AI_TOOLS.codex, loc);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('loc（file/source）が違えばキャッシュを共有しない', async () => {
    const spy = vi.mocked(nodeChildProcess.execFile);
    await checkToolVersion(AI_TOOLS.codex, loc);
    await checkToolVersion(AI_TOOLS.codex, { ...loc, file: '/nonexistent/sme-cache-test-codex-other', path: '/nonexistent/sme-cache-test-codex-other' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('clearToolCache() を呼ぶと次回は再実行する', async () => {
    const spy = vi.mocked(nodeChildProcess.execFile);
    await checkToolVersion(AI_TOOLS.codex, loc);
    clearToolCache();
    await checkToolVersion(AI_TOOLS.codex, loc);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('deps.exec を注入すると（テスト差し替え時）キャッシュを迂回し毎回呼ばれる', async () => {
    const exec = vi.fn(async () => 'codex-cli 0.145.0');
    await checkToolVersion(AI_TOOLS.codex, loc, { exec });
    await checkToolVersion(AI_TOOLS.codex, loc, { exec });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  // Important 5: findTool と同じ in-flight 共有。GET /api/ai/tools が同時に 2 本来ると
  // 同じ実行ファイルに対して --version が 2 回起動していた。
  it('同時に呼ばれても --version は 1 回だけ（in-flight 共有）', async () => {
    const spy = vi.mocked(nodeChildProcess.execFile);
    await Promise.all([
      checkToolVersion(AI_TOOLS.codex, loc),
      checkToolVersion(AI_TOOLS.codex, loc),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Critical 1: ログインシェルへ渡すのは「コマンド文字列に埋め込んだ binName」ではなく
 * 位置引数。binName は AI_TOOLS 由来だが、外部プロセスの起動経路に文字列補間を残さない。
 */
describe('findTool の外部プロセス起動（注入経路）', () => {
  it('記号を含む binName では探索そのものを行わない（外部プロセスを起動しない）', async () => {
    const dir = makeEditorDir();
    const spy = vi.mocked(nodeChildProcess.execFile);
    const evil = { ...AI_TOOLS.claude, binName: 'claude; touch /tmp/sme-pwned' };
    try {
      expect(await findTool(evil, { editorDir: dir })).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([['claude with space'], ['claude$(id)'], ['../../bin/sh'], [''], ['..']])(
    '不正な binName %j は探索せず null',
    async (binName) => {
      const dir = makeEditorDir();
      const spy = vi.mocked(nodeChildProcess.execFile);
      try {
        expect(await findTool({ ...AI_TOOLS.claude, binName }, { editorDir: dir })).toBeNull();
        expect(spy).not.toHaveBeenCalled();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it.skipIf(process.platform === 'win32')('ログインシェルには binName を位置引数で渡す', async () => {
    const dir = makeEditorDir();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const spy = vi.mocked(nodeChildProcess.execFile);
    spy.mockImplementation(((file: string, args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      calls.push({ file, args });
      queueMicrotask(() => cb(null, '', ''));
      return fakeChild();
    }) as unknown as typeof nodeChildProcess.execFile);
    try {
      await findTool({ ...AI_TOOLS.claude, binName: 'sme-nonexistent-bin' }, { editorDir: dir, knownDirs: [], bypassCache: true });
      const shell = calls.find((c) => c.args[0] === '-lc');
      expect(shell?.args).toEqual(['-lc', 'command -v -- "$1"', 'sme-find-tool', 'sme-nonexistent-bin']);
      expect(shell?.file.endsWith('zsh')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * Important 3: PATH 段（which/where）の結果も候補にすぎない。実在・実行可能を確かめずに
 * 採用すると、存在しないパスを spawn して pty が即死する。
 */
describe('findTool の候補検証', () => {
  it('which が実在しないパスを返したら採らない', async () => {
    const dir = makeEditorDir();
    try {
      const loc = await findTool(AI_TOOLS.claude, {
        editorDir: dir,
        which: async () => '/nonexistent/sme-not-there/claude',
        knownDirs: [], loginShell: async () => null,
      });
      expect(loc).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('which の結果が実行不可なら次の段へ進む', async () => {
    const dir = makeEditorDir(), known = join(dir, 'known');
    mkdirSync(known, { recursive: true });
    const notExec = join(dir, 'claude'); writeFileSync(notExec, 'x'); chmodSync(notExec, 0o644);
    const shim = join(known, 'claude'); writeFileSync(shim, '#!/bin/sh\n'); chmodSync(shim, 0o755);
    try {
      const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, which: async () => notExec, knownDirs: [known], loginShell: async () => null });
      expect(loc).toMatchObject({ source: 'known-dir', file: shim });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // T24 Minor: which/knownDirs/loginShell が相対パスを返しても候補にしない
  // （resolve() が cwd 基準で絶対化してしまい、意図しない場所を「見つけた」と誤採用しうる）。
  it('which が相対パスを返したら採らない（isAbsolute 確認）', async () => {
    const dir = makeEditorDir(), known = join(dir, 'known');
    mkdirSync(known, { recursive: true });
    const shim = join(known, 'claude'); writeFileSync(shim, '#!/bin/sh\n'); chmodSync(shim, 0o755);
    try {
      const loc = await findTool(AI_TOOLS.claude, {
        editorDir: dir, which: async () => 'claude', knownDirs: [known], loginShell: async () => null,
      });
      // PATH 段の相対パスは棄却され、既知の置き場（絶対パス）まで進む。
      expect(loc).toMatchObject({ source: 'known-dir', file: shim });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // T24 Minor: 実行ビットの立ったディレクトリ（トラバース可能なだけ）を実行ファイル扱いしない。
  it('実行可能ビットの立ったディレクトリは候補にしない（isFile 確認）', async () => {
    const dir = makeEditorDir(), known = join(dir, 'known');
    mkdirSync(known, { recursive: true });
    const dirAsBin = join(known, 'claude'); mkdirSync(dirAsBin); // ディレクトリは既定で x ビットあり
    try {
      const loc = await findTool(AI_TOOLS.claude, { editorDir: dir, which: async () => null, knownDirs: [known], loginShell: async () => null });
      expect(loc).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * Important 6: 1 候補あたりの時間上限。ログインシェルは起動設定（nvm 等）まで実行するため
 * 返ってこないことがある。上限で打ち切り、子プロセスは kill する。
 */
describe('findTool の時間上限', () => {
  it('候補が返らなくても CANDIDATE_TIMEOUT_MS で打ち切る', async () => {
    const dir = makeEditorDir();
    vi.useFakeTimers();
    try {
      const slow = (): Promise<string | null> => new Promise((done) => { setTimeout(() => done('/never/used'), 10_000); });
      const pending = findTool(AI_TOOLS.claude, {
        editorDir: dir, which: async () => null, knownDirs: [], loginShell: slow, bypassCache: true,
      });
      await vi.advanceTimersByTimeAsync(CANDIDATE_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('時間上限に達したら子プロセスを kill する', async () => {
    const dir = makeEditorDir();
    const kill = vi.fn(() => true);
    const spy = vi.mocked(nodeChildProcess.execFile);
    // コールバックを永久に呼ばない execFile。run() 側の上限だけが解決手段になる。
    spy.mockImplementation(((): unknown => fakeChild(kill)) as unknown as typeof nodeChildProcess.execFile);
    vi.useFakeTimers();
    try {
      const pending = findTool(AI_TOOLS.claude, {
        editorDir: dir, knownDirs: [], loginShell: async () => null, bypassCache: true,
      });
      await vi.advanceTimersByTimeAsync(CANDIDATE_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeNull();
      // T24 Minor: SIGTERM（無引数の kill()）は子が trap/無視できるため SIGKILL で送る。
      expect(kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findTool の検出失敗ログ（T24 Minor）', () => {
  it('全段で見つからなければ warn する（「未導入」と「探索が壊れている」を後からログで区別できるようにする）', async () => {
    const dir = makeEditorDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loc = await findTool(AI_TOOLS.claude, {
        editorDir: dir, which: async () => null, knownDirs: [], loginShell: async () => null,
      });
      expect(loc).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('見つかりませんでした'));
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findTool の in-flight（T24 Minor: finally のガード）', () => {
  it('世代が進んだ後、古い in-flight の finally が新しい in-flight を巻き添えで消さない', async () => {
    const dir = makeEditorDir();
    let resolveOld: (v: string | null) => void = () => {};
    const oldWhich = (): Promise<string | null> => new Promise((res) => { resolveOld = res; });
    const oldOpts = { editorDir: dir, which: oldWhich, knownDirs: [], loginShell: async () => null };
    // (1) 古い探索を開始（in-flight に登録される）。
    const oldPending = findTool(AI_TOOLS.claude, oldOpts);

    // (2) 導入完了などで clearToolCache() が走る（in-flight ごと世代を進めて消す）。
    clearToolCache();

    // (3) 同じキーで新しい探索を開始（新しい in-flight が登録される）。
    let newWhichCalls = 0;
    let resolveNew: (v: string | null) => void = () => {};
    const newWhich = (): Promise<string | null> => { newWhichCalls++; return new Promise((res) => { resolveNew = res; }); };
    const newOpts = { editorDir: dir, which: newWhich, knownDirs: [], loginShell: async () => null };
    const newPending1 = findTool(AI_TOOLS.claude, newOpts);

    // (4) 古い探索がここで完了する。バグがあれば、この finally が inFlight から
    //     「新しい」in-flight のエントリを（自分のものと誤認して）消してしまう。
    resolveOld(null);
    await oldPending;

    // (5) 同じキーで再度呼んだとき、新しい in-flight にまだ相乗りできるはず
    //     （二重に which() が呼ばれない）。
    const newPending2 = findTool(AI_TOOLS.claude, newOpts);
    resolveNew(null);
    await Promise.all([newPending1, newPending2]);
    expect(newWhichCalls).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });
});

 describe('desktop managed AI directory', () => {
  it('keeps optional CLI installs outside the application bundle', () => {
    vi.stubEnv('HARNESS_MANAGED_AI_DIR', '/Users/x/Library/Application Support/Harness Editor/ai-tools');
    try { expect(managedRuntimeDir('/Applications/Harness Editor.app/Contents/Resources/runtime')).toBe('/Users/x/Library/Application Support/Harness Editor/ai-tools'); }
    finally { vi.unstubAllEnvs(); }
  });
});
