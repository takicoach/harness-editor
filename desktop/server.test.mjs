import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// desktop/server.mjs をリポジトリ直下（実 vite.config.ts・実 node_modules）で起動して検査する。
// デスクトップ版は設定ファイルの読み込み方式（configLoader）が CLI の `vite` と異なるため、
// CLI 経由の e2e では見えない不具合がここでだけ出る（2026-09-21: 'runner' は読み込み直後に
// module runner を閉じるので、ptySession.ts の `await import('node-pty')` が
// 「Vite module runner has been closed.」で失敗し AI タブだけが使えなかった）。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function startServer(env) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'desktop/server.mjs'], {
      cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server did not become ready\n${log}`)); }, 90000);
    child.on('message', (m) => {
      if (m && m.type === 'ready') { clearTimeout(timer); accept({child, origin: m.origin}); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code})\n${log}`)); });
  });
}

function stopServer(child) {
  return new Promise((accept) => {
    const killer = setTimeout(() => { child.kill('SIGKILL'); accept('killed'); }, 10000);
    child.once('exit', (code) => { clearTimeout(killer); accept(code); });
    child.send('shutdown');
  });
}

test('desktop server: AI terminal loads node-pty after the config loader has finished', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'harness-desktop-server-'));
  const env = {
    ...process.env,
    HARNESS_DESKTOP_CACHE: join(scratch, 'cache'),
    HARNESS_PROJECT_ROOT: join(scratch, 'projects'),
    HARNESS_DESKTOP_PORT: '0',
    SME_NO_OPEN: '1',
    // tests/fixtures 配下は aiToolBin.ts の差し替えゲート内。本物の claude は起動しない。
    SME_CLAUDE_BIN: join(repo, 'tests', 'fixtures', 'fake-claude.mjs'),
  };
  const {child, origin} = await startServer(env);
  let exitCode;
  try {
    const response = await fetch(`${origin}/api/pty/ensure`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin},
      body: JSON.stringify({tool: 'claude'}),
    });
    const body = await response.json();
    // 存在検査: 差し替えた claude が pty で実際に起動している＝ node-pty の読み込みを通過した。
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.state, 'running', JSON.stringify(body));
    assert.equal(body.actualTool, 'claude', JSON.stringify(body));
  } finally {
    exitCode = await stopServer(child);
    await rm(scratch, {recursive: true, force: true});
  }
  assert.equal(exitCode, 0, 'server shuts down cleanly on the shutdown message');
});
