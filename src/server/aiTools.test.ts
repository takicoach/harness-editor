import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_TOOLS, DEFAULT_AI_TOOL, isAiToolId } from './aiTools';
import { AGENT_LOOP_PROMPT, SERIAL_LOOP_PROMPT } from '../shared/agentPrompts';
import { codexRuntimeDir } from './codexHome';

describe('isAiToolId', () => {
  it('許可リストのみ通す', () => {
    expect(isAiToolId('claude')).toBe(true);
    expect(isAiToolId('codex')).toBe(true);
  });
  it('未知の値・型違いを弾く', () => {
    for (const v of ['gemini', 'CLAUDE', '', 'claude; rm -rf /', null, undefined, 1, {}]) {
      expect(isAiToolId(v)).toBe(false);
    }
  });
});

describe('DEFAULT_AI_TOOL', () => {
  it('claude（利用者の既定を変えない）', () => {
    expect(DEFAULT_AI_TOOL).toBe('claude');
  });
});

describe('claude アダプタ', () => {
  const t = AI_TOOLS.claude;

  it('launchArgs は --mcp-config, JSON, --strict-mcp-config, --settings, JSON の5要素', () => {
    const args = t.launchArgs(2110, 'light');
    expect(args).toHaveLength(5);
    expect(args[0]).toBe('--mcp-config');
    expect(args[2]).toBe('--strict-mcp-config');
    expect(args[3]).toBe('--settings');
  });

  it('MCP の URL が port を反映する', () => {
    const parsed = JSON.parse(AI_TOOLS.claude.launchArgs(2110, 'dark')[1] ?? '');
    expect(parsed.mcpServers['sme-editor'].url).toBe('http://127.0.0.1:2110/mcp');
    expect(parsed.mcpServers['sme-editor'].type).toBe('http');
  });

  it('--settings に theme を注入する', () => {
    expect(JSON.parse(AI_TOOLS.claude.launchArgs(2109, 'light')[4] ?? '')).toEqual({ theme: 'light' });
    expect(JSON.parse(AI_TOOLS.claude.launchArgs(2109, 'dark')[4] ?? '')).toEqual({ theme: 'dark' });
  });

  it('課金系キーは Anthropic 系 5 件', () => {
    expect([...t.billingEnvKeys].sort()).toEqual([
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    ]);
  });

  it('CODEX_ACCESS_TOKEN は除去対象に含めない', () => {
    expect(t.billingEnvKeys).not.toContain('CODEX_ACCESS_TOKEN');
  });

  it('自動導入対象で版が固定されている', () => {
    expect(t.installPackage).toEqual({ name: '@anthropic-ai/claude-code', version: '2.1.220' });
  });

  it('待機プロンプトは並列版', () => {
    expect(t.waitingPrompt).toBe(AGENT_LOOP_PROMPT);
  });
});

describe('codex アダプタ', () => {
  const t = AI_TOOLS.codex;

  it('launchArgs は -c による MCP インライン注入の 2 要素', () => {
    const args = t.launchArgs(2112, 'light');
    expect(args).toEqual(['-c', 'mcp_servers.sme-editor.url="http://127.0.0.1:2112/mcp"']);
  });

  it('theme を渡しても引数は変わらない（tui.theme は構文ハイライト専用で地色を変えられない）', () => {
    expect(t.launchArgs(2109, 'light')).toEqual(t.launchArgs(2109, 'dark'));
  });

  it('課金系キーは OpenAI 系 2 件で、サブスク認証は除去しない', () => {
    expect([...t.billingEnvKeys].sort()).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY']);
    expect(t.billingEnvKeys).not.toContain('CODEX_ACCESS_TOKEN');
  });

  it('自動導入の対象外', () => {
    expect(t.installPackage).toBeNull();
  });

  it('最低版が 0.145.0', () => {
    expect(t.minVersion).toBe('0.145.0');
  });

  it('待機プロンプトは直列版（subagent 委譲を前提にしない）', () => {
    expect(t.waitingPrompt).toBe(SERIAL_LOOP_PROMPT);
    expect(t.waitingPrompt).not.toContain('subagent');
  });

  it('prepare を持つ（隔離 CODEX_HOME を用意する）', () => {
    expect(typeof t.prepare).toBe('function');
  });
});

describe('codex の prepare', () => {
  it('CODEX_HOME を隔離ディレクトリへ向ける（アダプタ経由でも実ホーム非依存）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-aitools-prep-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'sme-aitools-home-'));
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'auth.json'), '{"mode":"chatgpt"}');

    // AI_TOOLS.codex.prepare は deps を注入できない実アダプタ経由の呼び出しのため、
    // 素の呼び出しだと os.homedir() が実ホームを見てしまい環境依存になる。
    // os.homedir() は POSIX で $HOME、Windows で %USERPROFILE% を優先するため、
    // それを偽ホームへ差し替えることで公開シグネチャを変えずに実ホーム依存を断つ。
    const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const original = process.env[homeKey];
    process.env[homeKey] = fakeHome;
    try {
      const r = AI_TOOLS.codex.prepare?.({ editorDir: dir, env: {} });
      expect(r?.env.CODEX_HOME).toBe(codexRuntimeDir(dir, { homeDir: () => fakeHome }));
      expect(r?.notes).toEqual([]);
    } finally {
      if (original === undefined) {
        delete process.env[homeKey];
      } else {
        process.env[homeKey] = original;
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('SERIAL_LOOP_PROMPT', () => {
  it('get_next_instruction と report_instruction_status を含む', () => {
    expect(SERIAL_LOOP_PROMPT).toContain('get_next_instruction');
    expect(SERIAL_LOOP_PROMPT).toContain('report_instruction_status');
  });
  it('並列版とは別文面', () => {
    expect(SERIAL_LOOP_PROMPT).not.toBe(AGENT_LOOP_PROMPT);
  });
});
