import { useMemo } from 'react';
import { textChangeSegments } from './textChangeSegments';

export function TextChangeComparison({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => textChangeSegments(before, after), [before, after]);
  const changes = segments.filter((segment) => segment.changed);
  const text = (side: 'before' | 'after') => segments.map((segment, index) => segment.changed && segment[side]
    ? <mark className="agent-text-change" key={index}>{segment[side]}</mark> : segment[side]);
  return <>
    <p className="agent-text-comparison">変更前：{text('before')}</p>
    <p className="agent-text-comparison">AIの変更案：{text('after')}</p>
    {changes.length > 0 && <div className="agent-text-fragments" aria-label="変更箇所">
      <small>変更箇所</small>
      <ul>{changes.map((change, index) => <li key={index}>
        <span className="agent-fragment-before">{change.before || '（追加）'}</span>
        <span aria-label="から">→</span>
        <span className="agent-fragment-after">{change.after || '（削除）'}</span>
      </li>)}</ul>
    </div>}
  </>;
}
