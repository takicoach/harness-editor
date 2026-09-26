/**
 * @vitest-environment jsdom
 */
/**
 * AI タブからコピーする待機プロンプトの編集・保存契約。
 * native 案件では画面と共通の編集APIを使い、直接ファイル編集は旧形式に限る。
 */
import { describe, it, expect } from 'vitest';
import { AGENT_LOOP_PROMPT, dedicatedLoopPrompt, mcpUrl } from './AgentSetup';

describe('AGENT_LOOP_PROMPT — 全体待機（並列版・既定）', () => {
  it('元の指示を委譲し、次の指示を待ちながら案件別に結果を返す', () => {
    expect(AGENT_LOOP_PROMPT).toContain(
      'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら、その場では編集せず' +
        'バックグラウンドの subagent に委譲して、すぐ次の get_next_instruction を呼びに戻る。' +
        'subagent には次の編集手順と、元の指示 ID・projectId を渡す。',
    );
    expect(AGENT_LOOP_PROMPT).toContain('report_instruction_status を元の指示 ID に対して done（失敗なら failed）');
    expect(AGENT_LOOP_PROMPT).toContain('empty が返ったら再度呼んで待ち続ける。');
  });
});

describe('dedicatedLoopPrompt — 動画専属', () => {
  it('projectId を指定して待機し、同じ案件の結果を返す', () => {
    const prompt = dedicatedLoopPrompt('sample-project');
    expect(prompt).toContain('get_next_instruction を projectId: "sample-project" で呼んで編集指示を待つ。');
    expect(prompt).toContain('report_instruction_status を done / failed');
    expect(prompt).toContain('empty が返ったら再度呼んで待ち続ける。');
  });

  it('projectId が変われば文言中の埋め込み部分だけ変わる', () => {
    expect(dedicatedLoopPrompt('another-video')).toContain('projectId: "another-video"');
  });
});

it.each([AGENT_LOOP_PROMPT, dedicatedLoopPrompt('sample-project')])('画面の現在版を読み、共通JSONへ適用して保存完了を確かめる', prompt => {
  expect(prompt).toContain('editor_projects と editor_read で指示の projectId に一致する編集画面と現在版を確認');
  expect(prompt).toContain('documentFormat が sequence-v2');
  expect(prompt).toContain('project.v2.json や旧編集ファイルを直接書き換えず');
  expect(prompt).toContain('clips・assets・tracks・cuts・transcripts');
  expect(prompt).toContain('changes は空配列、sequence は documentId と型付き commands');
  expect(prompt).toContain('editor_validate、editor_apply の順');
  expect(prompt).toContain('runId を editor_runs で確認');
  expect(prompt).toContain('結果不明の操作を新しい operationId で再実行しない');
  expect(prompt).toContain('saved を確認した場合だけ完了');
  expect(prompt).toContain('旧形式であることを確認できた案件だけ');
});

describe('mcpUrl', () => {
  it('現在のオリジンから /mcp を組む', () => {
    expect(mcpUrl()).toBe(`${window.location.origin}/mcp`);
  });
});
