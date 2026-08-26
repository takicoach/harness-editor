/**
 * plugin.ts の受け箱関連ルート（Task 3: MCP projectId フィルタ・打ち切り API・agent-status 拡張・
 * 永続化アタッチ配線）が正しく組み込まれていることを確認するテスト。
 * handleApi / configureServer は非公開のため、plugin.ts のソースを文字列として検証する
 * （plugin.installShape.test.ts と同じ流儀）。受け箱そのものの遷移（abort/agentStatus/
 * attachPersistence）の実際の挙動は instructionInbox.test.ts / inboxPersistence.test.ts でカバー済み。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pluginSrc = readFileSync(join(import.meta.dirname, 'plugin.ts'), 'utf8');

describe('plugin.ts: 起動時の受け箱永続化アタッチ', () => {
  it('configureServer で .sme-inbox.json に対して attachPersistence を呼ぶ', () => {
    expect(pluginSrc).toContain("instructionInbox.attachPersistence(join(root, '.sme-inbox.json')");
  });

  it('resolveProjectDir で projectDir を再解決する deps を渡す', () => {
    const idx = pluginSrc.indexOf('instructionInbox.attachPersistence(');
    const block = pluginSrc.slice(idx, idx + 300);
    expect(block).toContain('resolveProjectDir:');
    expect(block).toContain('resolveProjectDir(root, projectId)');
  });

  it('persisted:false のとき警告ログを出す', () => {
    expect(pluginSrc).toContain('受け箱の永続化を無効化しました（同じフォルダで別のエディタが起動中です）');
  });

  it('サーバ停止時（既存 killAll と同じ並び）に releasePersistence を呼ぶ', () => {
    const closeIdx = pluginSrc.indexOf("server.httpServer?.on('close'");
    const closeBlock = pluginSrc.slice(closeIdx, closeIdx + 500);
    // ジョブの kill は jobRegistries.ts の正本 1 箇所から導出する（再レビュー M-4）。
    expect(closeBlock).toContain('killAllProjectJobs()');
    expect(closeBlock).toContain('instructionInbox.releasePersistence()');
  });
});

describe('plugin.ts: POST /api/instructions/abort', () => {
  it('ルートが存在し POST 以外は 405', () => {
    const idx = pluginSrc.indexOf("url.pathname === '/api/instructions/abort'");
    expect(idx).toBeGreaterThan(-1);
    const block = pluginSrc.slice(idx, idx + 400);
    expect(block).toContain('405');
  });

  it('instructionInbox.abort(id) の成否を { ok } で返す', () => {
    const idx = pluginSrc.indexOf("url.pathname === '/api/instructions/abort'");
    const block = pluginSrc.slice(idx, idx + 600);
    expect(block).toContain('instructionInbox.abort(');
    expect(block).toContain('{ ok:');
  });
});

describe('plugin.ts: GET /api/agent-status の id 対応', () => {
  it('id クエリを読み取り instructionInbox.agentStatus(id) へ渡す', () => {
    const idx = pluginSrc.indexOf("url.pathname === '/api/agent-status'");
    const block = pluginSrc.slice(idx, idx + 600);
    expect(block).toContain("url.searchParams.get('id')");
    expect(block).toContain('instructionInbox.agentStatus(');
  });
});

describe('plugin.ts: POST /api/instructions の保存失敗時 500', () => {
  it('enqueue を try/catch し失敗時に inbox-save-failed を返す', () => {
    const idx = pluginSrc.indexOf("url.pathname === '/api/instructions'");
    expect(idx).toBeGreaterThan(-1);
    const block = pluginSrc.slice(idx, idx + 800);
    expect(block).toContain('try {');
    expect(block).toContain('inbox-save-failed');
  });
});
