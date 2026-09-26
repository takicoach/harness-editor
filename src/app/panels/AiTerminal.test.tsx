/**
 * @vitest-environment jsdom
 *
 * T24 修正ラウンド1のレビュー指摘（I1/I2）の回帰テスト。
 * xterm・実 WebSocket は jsdom で描画/通信できないため、WebSocket はここで
 * 何もしないフェイクに差し替え、'connected' までは進めない（既存の設計注記どおり
 * — 全面的な接続シナリオは e2e に委ねる）。ここで検証したいのは phase 機構から
 * 独立した「再確認」と「導入中」の配線そのもの。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { AiTerminal } from './AiTerminal';
import type { ToolInfo } from './aiToolSwitcher';

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {}
  send(): void {}
  close(): void {}
}

const claudeTool = (over: Partial<ToolInfo> = {}): ToolInfo => ({
  id: 'claude', label: 'Claude', installed: false, versionOk: true, installable: true,
  path: null, source: null, status: 'missing', ...over,
});
const codexTool = (over: Partial<ToolInfo> = {}): ToolInfo => ({
  id: 'codex', label: 'Codex', installed: true, versionOk: true, installable: false,
  path: '/opt/homebrew/bin/codex', source: 'path', status: 'ready', ...over,
});

function jsonRes(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AiTerminal — 再確認ボタン (I1)', () => {
  it('クリックのたびに /api/ai/tools?recheck=1 の GET が1回だけ飛ぶ', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/ai/tools')) {
        return jsonRes({ tools: [claudeTool({ status: 'unverified' }), codexTool()], current: null, notes: [] });
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AiTerminal />);
    const btn = await screen.findByRole('button', { name: '再確認' });
    // 通常の初回取得は recheck 無しのまま（誤って常時 bypass にしていない）。
    expect(calls.some((u) => u === '/api/ai/tools')).toBe(true);
    calls.length = 0;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(calls.filter((u) => u.includes('recheck'))).toHaveLength(1);
    });
    expect(calls.filter((u) => u.includes('recheck'))).toEqual(['/api/ai/tools?recheck=1']);
  });
});

describe('AiTerminal — 片方接続中でももう一方を導入できる (I2)', () => {
  it('codex が使える間に claude の「インストール」を押すと進捗が出て、完了で再検出が走る', async () => {
    let toolsCallCount = 0;
    let installPosted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/ai/install' && init?.method === 'POST') {
        installPosted = true;
        return jsonRes({ ok: true });
      }
      if (url === '/api/ai/install/status') {
        return jsonRes({ phase: 'done', log: ['done'] });
      }
      if (url.startsWith('/api/ai/tools')) {
        toolsCallCount++;
        return jsonRes({
          tools: [claudeTool(), codexTool()],
          // codex は既にサーバー側で起動中 → phase は 'starting' へ進み、
          // 'need-install'/'install-failed' のどちらでもなくなる（I2 が直す状況の再現）。
          current: 'codex',
          notes: [],
        });
      }
      if (url === '/api/pty/ensure' && init?.method === 'POST') {
        return jsonRes({ actualTool: 'codex', notes: [] });
      }
      if (url === '/api/pty/token') {
        return jsonRes({ token: 'tok' });
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AiTerminal />);
    const installBtn = await screen.findByRole('button', { name: 'インストール' });

    fireEvent.click(installBtn);
    await waitFor(() => expect(installPosted).toBe(true));

    // 導入中はツール単位のインライン進捗が出る（全体 phase を占有する
    // 大画面「導入中…」には頼らない——codex 接続を邪魔しないため）。
    await screen.findByText('導入中…');

    const callsBeforePoll = toolsCallCount;
    await waitFor(() => expect(toolsCallCount).toBeGreaterThan(callsBeforePoll), { timeout: 5000 });
  }, 10000);
});
