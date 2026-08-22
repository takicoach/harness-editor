/**
 * 待機役エージェントへ渡すプロンプト。クライアント（コピー用 UI）とサーバ
 * （待機開始ボタンの pty 投入）が共用するため src/shared/ に置く。
 * 文言は docs/AI接続マニュアル.md（付録の待機文言）と同文を維持する契約。
 */

/** 全体待機・並列版（既定）。 */
export const AGENT_LOOP_PROMPT =
  'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら、その場では編集せず' +
  'バックグラウンドの subagent に委譲して、すぐ次の get_next_instruction を呼びに戻る。' +
  'subagent には「projectDir 配下を編集して実現し、作業中は .sme/status.json の activity を書き、' +
  '完了したら report_instruction_status を done（失敗なら failed）で一言返答する」ことを指示する。' +
  'empty が返ったら再度呼んで待ち続ける。';

/** 動画専属（その動画の projectId を埋め込む）。 */
export function dedicatedLoopPrompt(projectId: string): string {
  return (
    `sme-editor の get_next_instruction を projectId: "${projectId}" で呼んで編集指示を待つ。` +
    '指示が返ったら projectDir 配下のファイルを編集して実現し、完了したら report_instruction_status を ' +
    'done / failed で一言返答する。empty が返ったら再度呼んで待ち続ける。'
  );
}

/**
 * 直列版（codex 等、subagent へのバックグラウンド委譲を前提にできないツール向け）。
 * AGENT_LOOP_PROMPT は「バックグラウンドの subagent に委譲して並列で回す」前提の文面で
 * Claude Code の運用に寄っているため、指示を1件ずつ自分で片付けて次を取りに戻る形にする。
 */
export const SERIAL_LOOP_PROMPT =
  'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら projectDir 配下の' +
  'ファイルを編集して実現し、作業中は .sme/status.json の activity を書く。完了したら ' +
  'report_instruction_status を done（失敗なら failed）で一言返答し、すぐ次の ' +
  'get_next_instruction を呼びに戻る。empty が返ったら再度呼んで待ち続ける。';
