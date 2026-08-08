/**
 * @vitest-environment jsdom
 */
/**
 * AgentSetup の待機役プロンプト文言。スペック 4.7 の逐語文言を固定化する
 * （AI タブ・チュートリアルの MCP ステップ両方がこの定数/関数をコピー用に参照する）。
 */
import { describe, it, expect } from 'vitest';
import { AGENT_LOOP_PROMPT, dedicatedLoopPrompt, mcpUrl } from './AgentSetup';

describe('AGENT_LOOP_PROMPT — 全体待機（並列版・既定）', () => {
  it('スペック 4.7 の逐語文言と一致する', () => {
    expect(AGENT_LOOP_PROMPT).toBe(
      'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら、その場では編集せず' +
        'バックグラウンドの subagent に委譲して、すぐ次の get_next_instruction を呼びに戻る。' +
        'subagent には「projectDir 配下を編集して実現し、作業中は .sme/status.json の activity を書き、' +
        '完了したら report_instruction_status を done（失敗なら failed）で一言返答する」ことを指示する。' +
        'empty が返ったら再度呼んで待ち続ける。',
    );
  });
});

describe('dedicatedLoopPrompt — 動画専属', () => {
  it('projectId を埋め込んだスペック 4.7 の逐語文言を返す', () => {
    expect(dedicatedLoopPrompt('sample-project')).toBe(
      'sme-editor の get_next_instruction を projectId: "sample-project" で呼んで編集指示を待つ。' +
        '指示が返ったら projectDir 配下のファイルを編集して実現し、完了したら report_instruction_status を ' +
        'done / failed で一言返答する。empty が返ったら再度呼んで待ち続ける。',
    );
  });

  it('projectId が変われば文言中の埋め込み部分だけ変わる', () => {
    expect(dedicatedLoopPrompt('another-video')).toContain('projectId: "another-video"');
  });
});

describe('mcpUrl', () => {
  it('現在のオリジンから /mcp を組む', () => {
    expect(mcpUrl()).toBe(`${window.location.origin}/mcp`);
  });
});
