import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import {
  createPtySessionManager,
  ensureNodePtySpawnHelperExecutable,
  sanitizeEnv,
  isSaneProjectRoot,
} from './ptySession';
import { AI_TOOLS } from './aiTools';
import { codexRuntimeDir } from './codexHome';


/**
 * **タイムアウトは明示する**（M3 B-5・T5 レビュー I-4）。
 * このファイルは**実 pty プロセス**を起動する（node-pty + 実シェル）ため、
 * 既定の 5 秒だと他ファイルの負荷で押し出されて赤くなる（T5 の `test:gate` 1 回目で実際に発生）。
 * 「遅いから伸ばす」ではなく「何秒までなら正常か」を数値で置く。
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * このファイルは複数箇所で tool: 'codex' の実 ensure/switchTool を走らせる
 * （AI_TOOLS.codex.prepare が deps 注入不可の実アダプタ経由で呼ばれる）。
 * prepareCodexHome は os.homedir() を見るため、素のままだと隔離 home が
 * 実ホーム（~/.supermovie/...）に作られ、実ユーザーの ~/.codex/auth.json への
 * symlink まで張ってしまう（実際に一度事故らせて発覚した）。ファイル全体を
 * 覆う beforeAll/afterAll で HOME/USERPROFILE を偽ホームへ差し替え、
 * このファイルのどのテストが codex を実行しても実ホームに触れないようにする。
 */
const PTY_HOME_KEY = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
let ptyFakeHome: string;
let ptyOriginalHome: string | undefined;
beforeAll(() => {
  ptyFakeHome = mkdtempSync(join(tmpdir(), 'sme-pty-fakehome-'));
  ptyOriginalHome = process.env[PTY_HOME_KEY];
  process.env[PTY_HOME_KEY] = ptyFakeHome;
});
afterAll(() => {
  if (ptyOriginalHome === undefined) {
    delete process.env[PTY_HOME_KEY];
  } else {
    process.env[PTY_HOME_KEY] = ptyOriginalHome;
  }
  rmSync(ptyFakeHome, { recursive: true, force: true });
});

describe('sanitizeEnv', () => {
  it('ツールごとの課金系変数を除去し、除去リストを返す', () => {
    const { env, removed } = sanitizeEnv(
      { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_USE_BEDROCK: '1' },
      AI_TOOLS.claude.billingEnvKeys,
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(removed.sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']);
  });

  it('codex では OpenAI 系を除去し、Anthropic 系は触らない', () => {
    const { env, removed } = sanitizeEnv(
      { OPENAI_API_KEY: 'sk-o', CODEX_API_KEY: 'ck', ANTHROPIC_API_KEY: 'sk-a' },
      AI_TOOLS.codex.billingEnvKeys,
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-a');
    expect(removed.sort()).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY']);
  });

  it('CODEX_ACCESS_TOKEN（サブスク認証）は除去しない', () => {
    const { env } = sanitizeEnv(
      { CODEX_ACCESS_TOKEN: 'tok' },
      AI_TOOLS.codex.billingEnvKeys,
    );
    expect(env.CODEX_ACCESS_TOKEN).toBe('tok');
  });

  it('SME_ALLOW_API_KEY=1 なら除去しない', () => {
    const { env, removed } = sanitizeEnv(
      { ANTHROPIC_API_KEY: 'sk-x', SME_ALLOW_API_KEY: '1' },
      AI_TOOLS.claude.billingEnvKeys,
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
    expect(removed).toEqual([]);
  });
});

describe('isSaneProjectRoot', () => {
  it('ホーム直下とドライブルートを拒否する', () => {
    expect(isSaneProjectRoot(homedir())).toBe(false);
    expect(isSaneProjectRoot(parse(process.cwd()).root)).toBe(false);
    expect(isSaneProjectRoot(join(homedir(), 'Movies', 'projects'))).toBe(true);
  });
});

describe('PtySessionManager（偽 claude で実 spawn）', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('spawn → 入出力往復 → scrollback 蓄積 → kill', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-claude.mjs');
    // エコーし続ける偽 claude（stdin を stdout に返す）
    writeFileSync(fake, 'process.stdin.setRawMode?.(true);process.stdin.pipe(process.stdout);');
    const mgr = createPtySessionManager();
    const chunks: string[] = [];
    mgr.onData((c) => chunks.push(c));
    const r = await mgr.ensure({
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fake },
    });
    expect(r.ok).toBe(true);
    mgr.write('hello\r');
    await new Promise((res) => setTimeout(res, 800));
    expect(chunks.join('')).toContain('hello');
    expect(mgr.scrollback()).toContain('hello');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
    expect(mgr.state()).toBe('exited');
  });

  it('spawn する PATH に採用パスの親と node の bin が前置される（T26）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-path-'));
    mkdirSync(join(dir, 'projects-root'));
    // .mjs 差し替え（他テストと同じ流儀）は node 経由で起動されるため、採用ファイル
    // （loc.file）自体が常に process.execPath になり「node の bin」と「採用パスの親」が
    // 区別できない。ここでは実行ファイルとして直接 spawn される非 .js/.mjs な偽 claude
    // （シバン付きシェルスクリプト）を使い、resolveToolForPty の test-override 分岐で
    // loc.file がこのスクリプト自身になるようにする（aiToolBin.test.ts の shim と同じ形）。
    const fixtureBin = join(dir, 'fake-claude');
    writeFileSync(fixtureBin, '#!/bin/sh\nprintf "%s" "$PATH"\n');
    chmodSync(fixtureBin, 0o755);
    const mgr = createPtySessionManager();
    const chunks: string[] = [];
    mgr.onData((c) => chunks.push(c));
    const r = await mgr.ensure({
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, PATH: '/usr/bin', SME_CLAUDE_BIN: fixtureBin },
    });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 500));
    const path = chunks.join('').split(':');
    expect(path[0]).toBe(dirname(fixtureBin));
    expect(path[1]).toBe(dirname(process.execPath));
    expect(path).toContain('/usr/bin');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it.each(['claude', 'codex'] as const)('%s の待機文を1回の貼付けと、その外側のEnterで送信する', async (tool) => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-waiting-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'paste-reader.mjs');
    // Raw PTY receiver: preserve UTF-8 and chunk boundaries, and decode a complete
    // paste event before accepting a separate submit key. The actual CLI acceptance
    // is recorded in audit 303/ai-terminal-live-03 (a plain burst stalled Codex).
    writeFileSync(fake, `
      process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdout.write('READY\\n');
      process.stdin.on('data', data => {
        buffer += data;
        const start = '\\x1b[200~', end = '\\x1b[201~';
        const finish = buffer.indexOf(end);
        if (buffer.startsWith(start) && finish >= 0 && buffer.slice(finish + end.length) === '\\r') {
          process.stdout.write('SUBMITTED:' + JSON.stringify(buffer.slice(start.length, finish)) + '\\n');
          buffer = '';
        }
      });
    `);
    const mgr = createPtySessionManager();
    try {
      expect((await mgr.ensure({ editorDir: dir, projectRoot: join(dir, 'projects-root'), tool,
        env: { ...process.env, SME_CLAUDE_BIN: fake, SME_CODEX_BIN: fake } })).ok).toBe(true);
      await vi.waitFor(() => expect(mgr.scrollback()).toContain('READY'), { timeout: 5000 });
      expect(mgr.startWaiting()).toEqual({ ok: true });
      await vi.waitFor(() => expect(mgr.scrollback()).toContain('SUBMITTED:' + JSON.stringify(AI_TOOLS[tool].waitingPrompt)), { timeout: 5000 });
      expect(mgr.scrollback().match(/SUBMITTED:/g)).toHaveLength(1);
    } finally {
      const running = mgr.state() === 'running';
      mgr.killAll();
      if (running) await vi.waitFor(() => expect(mgr.state()).toBe('exited'), { timeout: 5000 });
    }
  });

  it('自然終了→再起動（スイッチ経由でない ensure 再呼び出し）でも旧セッションの scrollback を引き継がない', async () => {
    // 根本原因（AAA G-1・claude-terminal.spec.ts:43 のフレーク）: ring は switchTool()
    // だけがクリアしており、pty が自然終了して ensure() を再度呼ぶ「再起動」経路
    // （AiTerminal.tsx の exited → restart ボタン）ではクリアされていなかった。
    // その結果、新セッションの scrollback に旧セッションの出力（他テストの入力痕跡を
    // 含む）が混入し、e2e が新セッションの実際の起動完了より前に旧データだけで
    // 待機アサーションを満たしてしまい、フルスイート負荷下でのみ後続の入力操作が
    // レースして落ちていた。
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-restart-'));
    mkdirSync(join(dir, 'projects-root'));
    const fakeA = join(dir, 'fake-a.mjs');
    // stdin に "exit" が来たら自死する（fake-claude.mjs と同じ設計）。
    writeFileSync(
      fakeA,
      [
        "process.stdout.write('READY-A\\n');",
        "let buf = '';",
        'process.stdin.on("data", (b) => {',
        '  process.stdout.write(b);',
        '  buf = (buf + b.toString()).slice(-32);',
        '  if (buf.includes("exit")) process.exit(0);',
        '});',
      ].join('\n'),
    );
    const fakeB = join(dir, 'fake-b.mjs');
    writeFileSync(fakeB, "process.stdout.write('READY-B\\n');process.stdin.pipe(process.stdout);");

    const mgr = createPtySessionManager();
    const optsA = {
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fakeA },
    };
    const rA = await mgr.ensure(optsA);
    expect(rA.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(mgr.scrollback()).toContain('READY-A');

    // 自然終了させる（SIGTERM/kill ではなく、テスト対象そのものの「exit 検出」経路）。
    mgr.write('exit\r');
    await new Promise((res) => setTimeout(res, 500));
    expect(mgr.state()).toBe('exited');

    // 再起動: switchTool ではなく ensure を再度呼ぶ（AiTerminal の restart ボタンと同じ経路）。
    const optsB = {
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fakeB },
    };
    const rB = await mgr.ensure(optsB);
    expect(rB.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 300));

    expect(mgr.scrollback()).toContain('READY-B');
    expect(mgr.scrollback()).not.toContain('READY-A');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('projectRoot がホーム直下なら spawn を拒否する', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-'));
    const mgr = createPtySessionManager();
    const r = await mgr.ensure({ editorDir: dir, projectRoot: homedir(), env: process.env });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('プロジェクト置き場');
  });

  it('killAll 直後に待たず ensure を呼んでも新セッションが生き続ける（stale onExit ガード）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-claude.mjs');
    writeFileSync(fake, 'process.stdin.setRawMode?.(true);process.stdin.pipe(process.stdout);');
    const mgr = createPtySessionManager();
    const chunks: string[] = [];
    mgr.onData((c) => chunks.push(c));
    const opts = {
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fake },
    };

    const r1 = await mgr.ensure(opts);
    expect(r1.ok).toBe(true);

    // 待たずに kill → 即再 ensure（旧プロセスの onExit はまだ発火していない）。
    mgr.killAll();
    const r2 = await mgr.ensure(opts);
    expect(r2.ok).toBe(true);

    // 旧プロセスの exit イベントを消化させる。
    await new Promise((res) => setTimeout(res, 1000));

    // 旧 onExit が新セッションの pty 参照を消していないこと。
    expect(mgr.state()).toBe('running');

    chunks.length = 0;
    mgr.write('x\r');
    await new Promise((res) => setTimeout(res, 500));
    expect(chunks.join('')).toContain('x');

    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('多世代 respawn で古い世代の遅延 exit が新しい確定を上書きしない（世代カウンタ）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-'));
    mkdirSync(join(dir, 'projects-root'));
    const fakeA = join(dir, 'fake-claude-a.mjs');
    const fakeB = join(dir, 'fake-claude-b.mjs');
    // A: kill（node-pty既定は SIGHUP）を受けても 800ms 生き延びてから exit 9 する（遅延 exit）。
    writeFileSync(
      fakeA,
      "process.on('SIGHUP', () => setTimeout(() => process.exit(9), 800)); setInterval(() => {}, 1000);",
    );
    // B: 300ms 後に自然終了で exit 7 する（先に確定させたい世代）。
    writeFileSync(fakeB, 'setTimeout(() => process.exit(7), 300);');

    const mgr = createPtySessionManager();
    const exitCodes: number[] = [];
    mgr.onExit((code) => exitCodes.push(code));

    const optsA = {
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fakeA },
    };
    const rA = await mgr.ensure(optsA);
    expect(rA.ok).toBe(true);
    expect(mgr.state()).toBe('running');

    // A の SIGHUP ハンドラ登録を待つ（無ければ SIGHUP の既定動作＝即死してしまい、
    // 狙いの「800ms 遅延 exit」レースが再現しない）。
    await new Promise((res) => setTimeout(res, 100));

    mgr.killAll(); // A は 800ms 後に exit 9 で死ぬ予約が入った状態（onExit はまだ発火していない）

    const optsB = {
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fakeB },
    };
    const rB = await mgr.ensure(optsB); // 待たず即座に新世代へ
    expect(rB.ok).toBe(true);

    // B の exit 7（300ms）が先に確定 → その後 A の遅延 exit 9（800ms）が届く。
    await new Promise((res) => setTimeout(res, 1500));

    expect(mgr.state()).toBe('exited');
    expect(mgr.lastExitCode()).toBe(7);
    expect(exitCodes).toEqual([7]);
  });
});

describe('ensure のツール一致（表示と実体のずれを作らない）', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeTool(): { dir: string; fake: string } {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-tool-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake.mjs');
    writeFileSync(fake, 'process.stdin.setRawMode?.(true);process.stdin.pipe(process.stdout);');
    return { dir, fake };
  }

  it('claude 起動中に codex を ensure すると tool-mismatch で拒否する', async () => {
    const { fake } = fakeTool();
    const mgr = createPtySessionManager();
    const env = { ...process.env, SME_CLAUDE_BIN: fake, SME_CODEX_BIN: fake };
    const base = { editorDir: dir, projectRoot: join(dir, 'projects-root'), env };

    expect((await mgr.ensure({ ...base, tool: 'claude' })).ok).toBe(true);
    expect(mgr.currentTool()).toBe('claude');

    const r = await mgr.ensure({ ...base, tool: 'codex' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('tool-mismatch');
      expect(r.actualTool).toBe('claude');
    }
    expect(mgr.currentTool()).toBe('claude');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('同じツールの再 ensure は成功する（リロード・再接続の常用経路）', async () => {
    const { fake } = fakeTool();
    const mgr = createPtySessionManager();
    const base = {
      editorDir: dir, projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fake },
    };
    expect((await mgr.ensure({ ...base, tool: 'claude' })).ok).toBe(true);
    const first = mgr.sessionId();
    expect((await mgr.ensure({ ...base, tool: 'claude' })).ok).toBe(true);
    expect(mgr.sessionId()).toBe(first); // 再 spawn していない
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('別ツールの ensure を並行させても spawn は 1 回だけ', async () => {
    const { fake } = fakeTool();
    const mgr = createPtySessionManager();
    const base = {
      editorDir: dir, projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fake, SME_CODEX_BIN: fake },
    };
    const [a, b] = await Promise.all([
      mgr.ensure({ ...base, tool: 'claude' }),
      mgr.ensure({ ...base, tool: 'codex' }),
    ]);
    // 先着が成功し、後着は tool-mismatch で落ちる（どちらが先かは競争なので順不同）。
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(mgr.currentTool()).not.toBeNull();
    expect(['claude', 'codex']).toContain(mgr.currentTool());
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('sessionId は spawn ごとに変わる', async () => {
    const { fake } = fakeTool();
    const mgr = createPtySessionManager();
    const base = {
      editorDir: dir, projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fake },
    };
    await mgr.ensure({ ...base, tool: 'claude' });
    const id1 = mgr.sessionId();
    mgr.killAll();
    await mgr.ensure({ ...base, tool: 'claude' });
    const id2 = mgr.sessionId();
    expect(id1).not.toBeNull();
    expect(id2).not.toBe(id1);
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });
});

describe('OSC 色応答（pty 経路）', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('偽ツールが背景色を尋ねたら、テーマの背景色が返る', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-osc-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-osc.mjs');
    // 起動直後に OSC 11 を問い合わせ、返ってきた応答をそのまま標準出力へ書き戻す。
    writeFileSync(
      fake,
      'process.stdin.setRawMode?.(true);' +
        'process.stdout.write("\\x1b]11;?\\x07");' +
        'process.stdin.on("data", (b) => process.stdout.write("GOT:" + JSON.stringify(b.toString())));',
    );
    const mgr = createPtySessionManager();
    const chunks: string[] = [];
    mgr.onData((c) => chunks.push(c));
    const r = await mgr.ensure({
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fake },
      tool: 'claude',
      theme: 'light',
    });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 900));
    // light の背景 #ffffff が rgb:ffff/ffff/ffff で返っている。
    expect(chunks.join('')).toContain('rgb:ffff/ffff/ffff');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });
});

describe('ensure() の node-pty 動的 import 失敗（I-3）', () => {
  afterEach(() => {
    vi.doUnmock('node-pty');
    vi.resetModules();
  });

  it('node-pty のロードに失敗しても throw せず { ok: false } を返す（dev サーバーを道連れにしない）', async () => {
    vi.resetModules();
    vi.doMock('node-pty', () => {
      throw new Error('native module load failed (simulated)');
    });
    // モック適用後に改めて import し直す（トップレベルの型 import は erased されるため
    // 実体のロードには影響しない・spawn の動的 import だけがこのモックに当たる）。
    const { createPtySessionManager: createFreshManager } = await import('./ptySession');
    const mgr = createFreshManager();
    const dir = mkdtempSync(join(tmpdir(), 'sme-pty-loadfail-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-claude.mjs');
    writeFileSync(fake, 'process.stdin.setRawMode?.(true);process.stdin.pipe(process.stdout);');
    try {
      const r = await mgr.ensure({
        editorDir: dir,
        projectRoot: join(dir, 'projects-root'),
        env: { ...process.env, SME_CLAUDE_BIN: fake },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('ターミナル機能の読み込みに失敗しました');
      expect(mgr.state()).toBe('idle'); // spawn まで到達していない
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('macOS node-pty spawn-helper の実行権限', () => {
  it('ZIP展開等で実行ビットが落ちていても spawn 前に復旧する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-node-pty-helper-'));
    const nativeDir = join(dir, 'prebuilds', 'darwin-arm64');
    const helper = join(nativeDir, 'spawn-helper');
    try {
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(nativeDir, 'pty.node'), 'dummy');
      writeFileSync(helper, 'dummy');
      chmodSync(helper, 0o644);

      const result = ensureNodePtySpawnHelperExecutable(dir, {
        platform: 'darwin',
        arch: 'arm64',
      });

      expect(result).toEqual({ ok: true, repaired: true, helperPath: helper });
      expect(statSync(helper).mode & 0o111).toBe(0o111);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('switchTool（原子的なツール切替）', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setupTwoFakes(): { base: { editorDir: string; projectRoot: string; env: NodeJS.ProcessEnv } } {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-switch-'));
    mkdirSync(join(dir, 'projects-root'));
    const a = join(dir, 'fake-a.mjs');
    const b = join(dir, 'fake-b.mjs');
    writeFileSync(a, 'process.stdout.write("AAA");setInterval(()=>{},1000);');
    writeFileSync(b, 'process.stdout.write("BBB");setInterval(()=>{},1000);');
    return {
      base: {
        editorDir: dir,
        projectRoot: join(dir, 'projects-root'),
        env: { ...process.env, SME_CLAUDE_BIN: a, SME_CODEX_BIN: b },
      },
    };
  }

  it('切替後は currentTool と sessionId が入れ替わる', async () => {
    const { base } = setupTwoFakes();
    const mgr = createPtySessionManager();
    await mgr.ensure({ ...base, tool: 'claude' });
    const before = mgr.sessionId();
    const r = await mgr.switchTool({ ...base, tool: 'codex' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actualTool).toBe('codex');
      expect(r.sessionId).not.toBe(before);
    }
    expect(mgr.currentTool()).toBe('codex');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('切替で scrollback を捨てる（旧ツールの履歴を新端末に流さない）', async () => {
    const { base } = setupTwoFakes();
    const mgr = createPtySessionManager();
    await mgr.ensure({ ...base, tool: 'claude' });
    await new Promise((res) => setTimeout(res, 500));
    expect(mgr.scrollback()).toContain('AAA');
    await mgr.switchTool({ ...base, tool: 'codex' });
    await new Promise((res) => setTimeout(res, 500));
    expect(mgr.scrollback()).not.toContain('AAA');
    expect(mgr.scrollback()).toContain('BBB');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('切替時に writer 失効関数を呼ぶ', async () => {
    const { base } = setupTwoFakes();
    const mgr = createPtySessionManager();
    let invalidated = 0;
    mgr.setInvalidateWriter(() => { invalidated++; });
    await mgr.ensure({ ...base, tool: 'claude' });
    await mgr.switchTool({ ...base, tool: 'codex' });
    expect(invalidated).toBe(1);
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('連打しても直列化され、最後に指定したツールが動く', async () => {
    const { base } = setupTwoFakes();
    const mgr = createPtySessionManager();
    await mgr.ensure({ ...base, tool: 'claude' });
    const results = await Promise.all([
      mgr.switchTool({ ...base, tool: 'codex' }),
      mgr.switchTool({ ...base, tool: 'claude' }),
      mgr.switchTool({ ...base, tool: 'codex' }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(mgr.currentTool()).toBe('codex');
    expect(mgr.state()).toBe('running');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });

  it('SIGTERM を無視するプロセスも強制終了して切替を完了する（かつ旧プロセスが実際に死ぬ）', async () => {
    // 回帰ガード: 以前は強制 kill が node-pty の引数無し kill()（実体は SIGHUP・捕捉可能）
    // だったため、SIGTERM/SIGHUP 両方を trap するプロセスが「切替は成功したことになっている
    // のに孤児として生き残る」バグがあった。r.ok/currentTool だけを見るテストではこの回帰を
    // 検出できない（孤児プロセスがいても ensure() 側の新セッションは正しく立ち上がるため）。
    // ここでは旧プロセスの実 pid を捕まえ、切替後に実際に終了していることまで確認する。
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-stubborn-'));
    mkdirSync(join(dir, 'projects-root'));
    const stubborn = join(dir, 'stubborn.mjs');
    const b = join(dir, 'fake-b.mjs');
    writeFileSync(
      stubborn,
      "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});" +
        "process.stdout.write('PID:' + process.pid + '\\n');setInterval(()=>{},1000);",
    );
    writeFileSync(b, 'process.stdout.write("BBB");setInterval(()=>{},1000);');
    const mgr = createPtySessionManager();
    const chunks: string[] = [];
    mgr.onData((c) => chunks.push(c));
    const base = {
      editorDir: dir, projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: stubborn, SME_CODEX_BIN: b },
    };
    let oldPid: number | null = null;
    try {
      expect((await mgr.ensure({ ...base, tool: 'claude' })).ok).toBe(true);
      // 全gateで起動が200msを超えても、trap登録とPID出力を実測してから切り替える。
      await vi.waitFor(() => {
        const pidMatch = /PID:(\d+)/.exec(chunks.join(''));
        expect(pidMatch).not.toBeNull();
        oldPid = Number(pidMatch![1]);
      }, { timeout: 5000, interval: 25 });

      const r = await mgr.switchTool({ ...base, tool: 'codex' });
      expect(r.ok).toBe(true);
      expect(mgr.currentTool()).toBe('codex');

      // kill送信だけで合格にせず、OSによる実終了まで確認する。
      await vi.waitFor(() => {
        expect(() => process.kill(oldPid!, 0)).toThrow(/ESRCH/);
      }, { timeout: 4000, interval: 25 });
    } finally {
      // 失敗時も、このテストが起動したtrapプロセスを孤児にしない。
      if (oldPid !== null) {
        try { process.kill(oldPid, 'SIGKILL'); } catch { /* already exited */ }
      }
      mgr.killAll();
      await new Promise((res) => setTimeout(res, 300));
    }
  }, 20_000);

  it('新ツールが見つからなければ失敗を返す（旧セッションは既に終了している）', async () => {
    const { base } = setupTwoFakes();
    const mgr = createPtySessionManager();
    await mgr.ensure({ ...base, tool: 'claude' });
    const r = await mgr.switchTool({
      ...base,
      tool: 'codex',
      env: { ...process.env, SME_CODEX_BIN: join(dir, 'does-not-exist.mjs') },
    });
    expect(r.ok).toBe(false);
    expect(mgr.currentTool()).toBeNull();
  });

  it('switchTool は内部で例外が飛んでも throw せず { ok: false } を返す（契約: throw しない）', async () => {
    // adapter.prepare?.() / checkToolVersion が同期的に throw する経路は switchTool の
    // try/catch でしか守れないが、アダプタを直接注入して throw させるのはテストからは難しい
    // （AI_TOOLS はモジュール定数）。ここでは switchTool の run() 内で実際に呼ばれる
    // invalidateWriter コールバックにテストから直接 throw させることで、同じ try/catch が
    // 機能していることを検証する（prepare/checkToolVersion 経路そのものは静的検証のみ・
    // 詳細はレポート参照）。
    const { base } = setupTwoFakes();
    const mgr = createPtySessionManager();
    mgr.setInvalidateWriter(() => { throw new Error('boom-from-invalidate'); });
    await mgr.ensure({ ...base, tool: 'claude' });
    const r = await mgr.switchTool({ ...base, tool: 'codex' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('boom-from-invalidate');
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });
});

describe('ensure(codex) の prepare 配線（CODEX_HOME が spawn env に載る）', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('偽 codex に CODEX_HOME を書き出させると隔離ディレクトリのパスが見える', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-codexhome-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-codex.mjs');
    // 起動直後に受け取った CODEX_HOME をそのまま標準出力へ書く。
    writeFileSync(fake, 'process.stdout.write(process.env.CODEX_HOME ?? "NO-CODEX-HOME");');
    const mgr = createPtySessionManager();
    const chunks: string[] = [];
    mgr.onData((c) => chunks.push(c));

    // AI_TOOLS.codex.prepare は deps を注入できない実アダプタ経由の呼び出しのため、
    // os.homedir() はファイル先頭の beforeAll が差し替えた偽ホーム（ptyFakeHome）を見る。
    const r = await mgr.ensure({
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CODEX_BIN: fake },
      tool: 'codex',
    });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 500));
    expect(chunks.join('')).toContain(codexRuntimeDir(dir, { homeDir: () => ptyFakeHome }));
    mgr.killAll();
    await new Promise((res) => setTimeout(res, 300));
  });
});

describe('X-1: 死んだ pty への resize/write でサーバが落ちない', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * 根本原因（指揮が実測で特定）: 子プロセスが自然終了して fd が閉じてから、
   * node-pty の onExit（非同期・libuv 経由）が発火するまでの数ミリ秒の窓が存在する。
   * `pty !== null` はこの窓の間ずっと true のまま（onExit がまだ pty=null に
   * 戻していないため）なので、`pty?.resize(...)` の optional chaining は
   * この窓を一切防がない。窓の間に resize が届くと node-pty の native ioctl が
   * 同期的に `ioctl(2) failed, EBADF` を throw し、呼び出し側（ptyApi.ts の
   * WS message ハンドラ）は try/catch していないため、この throw がそのまま
   * dev サーバーのプロセスを落とす（実測: `[WebServer] Error: ioctl(2) failed, EBADF`）。
   * 実プロセスの自然終了で確実にこの窓を作るため、即終了する偽バイナリを spawn し、
   * ensure() 直後（onExit がまだ発火し得ない同期区間）から高頻度で resize/write を
   * 連打して窓を捉える。
   */
  it('自然終了直後の窓に resize が飛んでも例外を投げない（修正前は EBADF を throw していた）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-deadresize-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-instant-exit.mjs');
    // 起動直後に自然終了する（SIGTERM/kill 経路ではなく「自然死」を再現する）。
    writeFileSync(fake, 'process.exit(0);');
    const mgr = createPtySessionManager();
    const opts = {
      editorDir: dir,
      projectRoot: join(dir, 'projects-root'),
      env: { ...process.env, SME_CLAUDE_BIN: fake },
    };
    const r = await mgr.ensure(opts);
    expect(r.ok).toBe(true);

    // onExit 確定前の窓を捉えるため、間隔を空けずに resize/write を連打する。
    // 窓を外しても実害はない（次の呼び出しでまた窓を狙える）ので broad に回す。
    let threw: unknown = null;
    for (let i = 0; i < 500 && threw === null; i++) {
      try {
        mgr.resize(90, 30);
        mgr.write('x');
      } catch (err) {
        threw = err;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 1));
    }

    expect(threw).toBeNull();

    // onExit が確定した後の状態も正しく反映されること（実害の握り潰しではないことの確認）。
    await new Promise((res) => setTimeout(res, 500));
    expect(mgr.state()).toBe('exited');

    mgr.killAll();
  });
  /**
   * 前ラウンドのレビュー minor 指摘の回帰テスト。
   * ptyDead を立てて no-op にするだけだと state() は 'running' のままで、
   * 利用者から見て「動いているのに入力が無言で消える」状態になる
   * （実測プローブ: 窓を捉えた瞬間の state() は 5 回中 4 回 'running' だった）。
   * fd の死を検知した時点で終了を確定し、UI へ1回だけ通知することを検査する。
   *
   * 窓（fd 死亡〜onExit 確定）は数ミリ秒で、1回の spawn で必ず捉えられるとは限らない
   * （実測の再現率は約 50%）。**アサーションを緩めるのではなく**、窓を捉えるまで
   * spawn をやり直し、捉えた「その瞬間」に厳密なアサーションを当てる。
   * 予算内に一度も再現できなかった場合は、検査が成立しなかったこととして fail させる
   * （壊れたプローブを緑と区別できないため）。
   */
  it('fd の死を検知したら state() が running のままにならず、exit 通知が1回だけ出る', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sme-pty-deadstate-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-instant-exit.mjs');
    writeFileSync(fake, 'process.exit(0);');

    let observed = false;
    for (let attempt = 0; attempt < 15 && !observed; attempt++) {
      const mgr = createPtySessionManager();
      const exits: number[] = [];
      mgr.onExit((code) => exits.push(code));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await mgr.ensure({
          editorDir: dir,
          projectRoot: join(dir, 'projects-root'),
          env: { ...process.env, SME_CLAUDE_BIN: fake },
        });
        expect(r.ok).toBe(true);
        for (let i = 0; i < 500 && !observed; i++) {
          mgr.resize(90, 30);
          mgr.write('x');
          const died = errSpy.mock.calls.some((c) => String(c[0]).includes('pty resize が失敗'));
          if (died) {
            observed = true;
            // 本題: 死を検知した瞬間に 'running' を返し続けてはいけない。
            expect(mgr.state(), 'fd 死亡を検知したのに state() が running のまま').not.toBe('running');
            expect(mgr.startWaiting().ok).toBe(false);
            expect(exits.length, 'exit 通知が出ていない（無言の入力不能）').toBe(1);
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((res) => setTimeout(res, 1));
        }
        // 本物の onExit が後から届いても二重に通知しない。
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 500));
        expect(mgr.state()).toBe('exited');
        expect(exits.length, 'exit 通知が二重発火している').toBe(1);
      } finally {
        errSpy.mockRestore();
        mgr.killAll();
      }
    }
    expect(observed, 'fd 死亡の窓を一度も再現できず、検査が成立していない').toBe(true);
  });
});
