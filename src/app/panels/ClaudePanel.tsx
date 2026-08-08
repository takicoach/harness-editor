/**
 * AI タブ（実験: feat/simplified-ai-tab）。
 * 「初心者には画面が渋滞していて怖い」というオーナーの実機フィードバックを受け、
 * 在席表示・指示の履歴/入力欄・上下2段折りたたみを撤去し、埋め込みターミナル
 * （AiTerminal）だけの単純な画面にした UI 簡素化の実験版。
 *
 * サーバー側（受け箱 instructionInbox・/api/instructions・/api/agent-status・
 * MCP の get_next_instruction / report_instruction_status）は一切変更していない。
 * 別ターミナルで動かす Claude Code からは従来どおり使える。このパネルの UI を
 * 差し替えているだけなので、元の複合 UI（在席2段表示・指示履歴・打ち切り導線）に
 * 戻したい場合は git でこのファイルの変更を revert すればよい。
 */
import type { InstructionContext } from '../../shared/types';
import { AiTerminal } from './AiTerminal';

interface ClaudePanelProps {
  /** 開いているプロジェクト id。null のとき送信不可。 */
  projectId: string | null;
  /** パネルが開いているか（折りたたみ）。 */
  open: boolean;
  /** 折りたたみトグル。 */
  onToggle: () => void;
  /** 送信時に「今見ている文脈」を読み取る（再生位置・選択）。簡素化版では未使用（インターフェース維持）。 */
  buildContext: () => InstructionContext;
  /** ドック埋め込み（aside/折りたたみトグル無し・常時展開・中身のみ）。 */
  embedded?: boolean;
  /**
   * 埋め込みターミナル（AiTerminal）を実際にマウントしてよいか（I-2）。
   * false の間は claude の導入確認・pty ensure すら呼ばない——プロジェクト未選択の
   * ホーム画面や、AI タブを開いていない間に claude を勝手に spawn しないための
   * ゲート。省略時 true（非 embedded の従来呼び出しとの後方互換）。
   */
  showTerminal?: boolean;
}

export function ClaudePanel({
  open,
  onToggle,
  embedded = false,
  showTerminal = true,
}: ClaudePanelProps) {
  if (!open && !embedded) {
    return (
      <aside className="cl cl-collapsed">
        <button className="cl-toggle" onClick={onToggle} title="AI パネルを開く" aria-label="AI パネルを開く">
          {'«'}
        </button>
      </aside>
    );
  }

  const body = showTerminal ? <AiTerminal /> : null;

  if (embedded) {
    return <div className="cl cl-embedded">{body}</div>;
  }
  return (
    <aside className="cl">
      <div className="cl-head">
        <h2>AI に指示</h2>
        <button className="cl-toggle" onClick={onToggle} title="隠す" aria-label="AI パネルを隠す">
          {'»'}
        </button>
      </div>
      {body}
    </aside>
  );
}
