import type { PublicEditorOperation } from '../../shared/editorOperations';

const REVIEW_LABELS: Record<PublicEditorOperation['humanReview'], string> = {
  pending: '未確認', partial: '一部確認', reviewed: '判断を記録済み', unavailable: '取得できません',
};

/** A recognizable summary before opening the full before/after comparison. */
export function AgentOperationSummary({ operation, executionLabel, snapshot = false }: {
  operation: PublicEditorOperation; executionLabel: string; snapshot?: boolean;
}) {
  const date = new Date(operation.createdAt);
  const validDate = Number.isFinite(date.getTime());
  const proposal = operation.request.script?.artifact.proposal;
  const modification = operation.request.script?.modification;
  const firstText = modification?.kind === 'caption' ? modification.changes[0]?.after ?? '' : proposal?.kind === 'caption' ? proposal.changes[0]?.after ?? ''
    : proposal?.kind === 'structure' ? '台本に沿った映像のカットと並び替え' : operation.request.sequence?'映像・字幕・素材のタイムライン編集':operation.request.changes[0]?.after ?? '';
  const characters = Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' })
    .segment(firstText.replace(/\s+/g, ' ').trim()), (part) => part.segment);
  const excerpt = characters.slice(0, 64).join('') + (characters.length > 64 ? '…' : '');
  return <header className="agent-operation-summary">
    <div className="agent-operation-heading">
      <h3>{operation.request.sequence?`タイムライン${operation.request.sequence.commands.length}件の編集`:proposal?.kind === 'structure' ? '台本に沿った構成の編集' : `字幕${proposal?.kind === 'caption' ? proposal.changes.length : operation.request.changes.length}件の修正`}</h3>
      {validDate && <time dateTime={date.toISOString()}>
        {date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </time>}
    </div>
    <div className="agent-operation-statuses">
      <span>{snapshot ? '取得時点：' : ''}{executionLabel}</span>
      {operation.confirmed.applied && <span className="agent-operation-review" data-pending={operation.humanReview !== 'reviewed'}>
        人の確認：{REVIEW_LABELS[operation.humanReview]}
      </span>}
    </div>
    <p className="agent-operation-excerpt"><span>{modification ? '直して採用した内容' : '変更案'}</span> {excerpt || '（文字なし）'}</p>
  </header>;
}
