/**
 * 案件ごとの依頼入力・履歴。実行は既存のMCP受け箱を使い、接続用端末は明示的に開く。
 * showTerminalの既存ゲートは、非表示のAIタブで接続処理を開始しないために維持する。
 */
import type { InstructionContext } from '../../shared/types';
import { AiRequestPanel } from './AiRequestPanel';

interface ClaudePanelProps {
  /** 開いているプロジェクト id。null のとき送信不可。 */
  projectId: string | null;
  /** パネルが開いているか（折りたたみ）。 */
  open: boolean;
  /** 折りたたみトグル。 */
  onToggle: () => void;
  /** 送信時の再生位置・選択を読み取る。受付確認では送信時の値を再利用する。 */
  buildContext: () => InstructionContext;
  onOpenActivity?: () => void;
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
  projectId,
  buildContext,
  onOpenActivity,
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

  const body = showTerminal && projectId ? <AiRequestPanel key={projectId} projectId={projectId} buildContext={buildContext} onOpenActivity={onOpenActivity} /> : null;

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
