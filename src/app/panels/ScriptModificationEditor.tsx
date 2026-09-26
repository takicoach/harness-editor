import { useEffect, useMemo, useState } from 'react';
import type { ScriptEditArtifact } from '../../core/scriptEditArtifact';
import { deriveScriptStructurePlan } from '../../core/scriptEditProposal';
import { validateScriptEditModification, type ScriptEditModification } from '../../core/scriptEditModification';

type RangeDraft = { key: number; start: string; end: string };
export function ScriptModificationEditor({ artifact, disabled, onChange }: {
  artifact: ScriptEditArtifact; disabled: boolean; onChange(value: ScriptEditModification | null): void;
}) {
  const { input, proposal } = artifact;
  const initialRanges = () => proposal.kind === 'structure' ? deriveScriptStructurePlan(input, proposal).cutOrder.map((range, key) => ({
    key, start: String(range.originalStart / input.editing.fps), end: String(range.originalEnd / input.editing.fps),
  })) : [];
  const [texts, setTexts] = useState(() => proposal.kind === 'caption' ? proposal.changes.map(c => c.after) : []);
  const [ranges, setRanges] = useState<RangeDraft[]>(initialRanges);
  const [visible, setVisible] = useState(20);
  const parsed = useMemo(() => {
    try {
      if (ranges.some(range => !range.start.trim() || !range.end.trim())) throw new Error('区間の開始と終了を入力してください。');
      if (ranges.some(range => Number(range.start) < 0 || Number(range.end) < 0)) throw new Error('区間の時間は0秒以上で指定してください。');
      const value = proposal.kind === 'caption'
        ? { kind: 'caption', changes: proposal.changes.map((change, i) => ({ telopId: change.telopId, after: texts[i] ?? '' })) }
        : { kind: 'structure', cutOrder: ranges.map(range => ({ originalStart: Math.round(Number(range.start) * input.editing.fps), originalEnd: Math.round(Number(range.end) * input.editing.fps) })) };
      return { value: validateScriptEditModification(artifact, value), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { value: null, error: message.replace(/^[A-Z_]+:\s*/, '') };
    }
  }, [artifact, input.editing.fps, proposal, texts, ranges]);
  useEffect(() => { onChange(parsed.value); }, [parsed.value, onChange]);
  const move = (index: number, direction: -1 | 1) => setRanges(current => {
    const next = [...current], other = index + direction;
    if (other < 0 || other >= next.length) return current;
    [next[index], next[other]] = [next[other]!, next[index]!];
    return next;
  });
  return <div className="script-modification" aria-label="提案を直す">
    <p className="script-stage-note">元の提案を残して、あなたの修正を別に記録します。下の採用ボタンを押すまで、編集は変わりません。</p>
    {proposal.kind === 'caption' ? <ol>{proposal.changes.slice(0, visible).map((change, index) => <li key={change.telopId}>
      <p>元の提案：{change.after}</p>
      <label>修正する字幕 {index + 1}<textarea value={texts[index] ?? ''} maxLength={10000} disabled={disabled}
        onChange={e => { const value = e.target.value; setTexts(current => current.map((text, i) => i === index ? value : text)); }} /></label>
    </li>)}</ol> : <>
      <p className="script-stage-note">{input.native?'元の素材の時間で指定します。選んだ原音の使用区間内を上から順に並べます。完成動画の前後の区間は保持します。':'元の映像の時間で指定します。上から順に再生し、区間の外をカットします。'}</p>
      <ol>{ranges.slice(0, visible).map((range, index) => <li key={range.key}>
        <div className="script-modification-range">
          <label>区間 {index + 1} の開始（秒）<input type="number" step="any" min="0" value={range.start} disabled={disabled}
            onChange={e => { const value = e.target.value; setRanges(current => current.map((r, i) => i === index ? { ...r, start: value } : r)); }} /></label>
          <label>区間 {index + 1} の終了（秒）<input type="number" step="any" min="0" value={range.end} disabled={disabled}
            onChange={e => { const value = e.target.value; setRanges(current => current.map((r, i) => i === index ? { ...r, end: value } : r)); }} /></label>
        </div>
        <div className="script-adoption-actions">
          <button type="button" className="btn-secondary" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={`区間 ${index + 1} を前へ`}>前へ</button>
          <button type="button" className="btn-secondary" disabled={disabled || index === ranges.length - 1} onClick={() => move(index, 1)} aria-label={`区間 ${index + 1} を後ろへ`}>後ろへ</button>
          <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setRanges(current => current.filter((_, i) => i !== index))} aria-label={`区間 ${index + 1} を外す`}>この区間を外す</button>
        </div>
      </li>)}</ol>
    </>}
    {Math.max(texts.length, ranges.length) > visible && <button type="button" className="btn-secondary" onClick={() => setVisible(n => n + 20)}>修正項目の続きを表示</button>}
    {parsed.error && <p className="script-stage-note" role="status">{parsed.error}</p>}
    <button type="button" className="btn-secondary" disabled={disabled} onClick={() => {
      setTexts(proposal.kind === 'caption' ? proposal.changes.map(c => c.after) : []); setRanges(initialRanges());
    }}>元の提案に戻す</button>
  </div>;
}
