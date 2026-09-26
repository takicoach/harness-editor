import { useEffect, useMemo, useRef, useState } from 'react';
import type { Transcript } from '../../core/types';
import { validateScriptEditArtifact, type ScriptEditArtifact } from '../../core/scriptEditArtifact';
import { deriveScriptStructurePlan } from '../../core/scriptEditProposal';
import { buildCutOrdering } from '../../core/cutOrder';
import { samePersistedContent, type EditState } from '../edit/editState';
import type { EditSession } from '../useEditSession';
import { fetchJson } from '../fetchJson';
import { ScriptAdoptionControls, type ScriptAdoptionAccess } from './ScriptAdoptionControls';

interface Props {
  projectId: string; mode: 'caption' | 'structure'; session: EditSession; transcript: Transcript;
  previewVersion: string | null; projectStale: boolean; onSeekSource: (ms: number) => void;
  adoption?: ScriptAdoptionAccess;
}
type Review = { artifact: ScriptEditArtifact; state: EditState; guard: () => boolean;
  transcript: Transcript; previewVersion: string | null };
const time = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${Math.floor(ms / 100) % 10}`;
};

/** An imported skill result remains a draft. Reviewing/previewing never implies adoption. */
export function ScriptEditReview(props: Props) {
  const { projectId, mode, session, transcript, previewVersion, projectStale, onSeekSource } = props;
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(20);
  const pending = useRef<{ token: number; controller?: AbortController }>({ token: 0 });
  const latest = useRef(props); latest.current = props;
  useEffect(() => () => { pending.current.token++; pending.current.controller?.abort(); }, []);
  const disabled = busy || projectStale || session.dirty || session.saveStatus === 'saving';
  const stale = review !== null && (projectStale || session.dirty || !review.guard()
    || review.artifact.input.alignment.packet.projectId !== projectId
    || review.artifact.proposal.kind !== mode || review.previewVersion !== previewVersion
    || review.transcript !== transcript || !samePersistedContent(review.state, session.state));
  const display = useMemo(() => {
    if (!review) return null;
    const { input, proposal } = review.artifact;
    return { alignmentByPassage: new Map(input.alignment.proposals.map(p => [p.passageId, p])),
      passages: new Map(input.alignment.packet.script.passages.map(p => [p.id, p])),
      telops: new Map(input.editing.telops.map(t => [t.id, t])),
      before: proposal.kind === 'structure' ? buildCutOrdering(input.editing.totalFrames, input.editing.cutRegions, input.editing.cutOrder).segments : [],
      plan: proposal.kind === 'structure' ? deriveScriptStructurePlan(input, proposal) : null };
  }, [review]);

  async function importDraft(file: File) {
    if (disabled) return;
    const captured = session.state, guard = session.sessionGuard();
    pending.current.controller?.abort();
    const controller = new AbortController(), token = ++pending.current.token;
    pending.current.controller = controller;
    setBusy(true); setError(null); setReview(null);
    const current = () => token === pending.current.token && guard() && latest.current.projectId === projectId
      && latest.current.mode === mode && latest.current.previewVersion === previewVersion
      && latest.current.transcript === transcript && !latest.current.projectStale && !latest.current.session.dirty
      && samePersistedContent(captured, latest.current.session.state);
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('変更案は16MB以内のファイルを選んでください。');
      const body = await file.text();
      if (!current()) throw new Error('確認中に編集内容が変わりました。もう一度変更案を読み込んでください。');
      const query = new URLSearchParams({ id: projectId, mode });
      if (previewVersion !== null) query.set('expectedPreviewVersion', previewVersion);
      const raw = await fetchJson<unknown>(`/api/script-edit-review?${query}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
      const artifact = validateScriptEditArtifact(raw);
      if (!current()) throw new Error('確認中に編集内容が変わりました。もう一度変更案を読み込んでください。');
      const packet = artifact.input.alignment.packet;
      const words = transcript.words.map((w, index) => ({ index, text: w.text, startMs: w.start, endMs: w.end }));
      if (packet.projectId !== projectId || artifact.proposal.kind !== mode
        || JSON.stringify(packet.script) !== JSON.stringify(captured.scriptDocument)
        || JSON.stringify(packet.transcript.words) !== JSON.stringify(words)
        || JSON.stringify(artifact.input.editing.telops) !== JSON.stringify(captured.telops.map(t => ({
          originalStart: t.originalStart, originalEnd: t.originalEnd, id: t.id, text: t.text,
        })))
        || JSON.stringify(artifact.input.editing.cutRegions) !== JSON.stringify(captured.cutRegions.map(c => ({ start: c.start, end: c.end })))
        || JSON.stringify(artifact.input.editing.cutOrder) !== JSON.stringify((captured.cutOrder ?? []).map(c => ({ originalStart: c.originalStart, originalEnd: c.originalEnd })))
        || artifact.input.editing.totalFrames !== captured.originalTotalFrames) {
        throw new Error('画面の台本・発話と変更案が一致しません。案件を読み直して確認してください。');
      }
      setReview({ artifact, state: captured, guard, transcript, previewVersion }); setVisible(20);
    } catch (cause) {
      if (token === pending.current.token && !controller.signal.aborted) setError(cause instanceof Error && cause.name !== 'ZodError'
        ? cause.message : '変更案を確認できませんでした。スキルが作成した変更案を選んでください。');
    } finally { if (token === pending.current.token) setBusy(false); }
  }

  const artifact = review?.artifact, proposal = artifact?.proposal;
  return <section className="script-edit-review" aria-label="スキルの変更案">
    <h3>スキルの変更案を確認</h3>
    <p>作成した案を読み込むと、変更する内容と提案理由を確認できます。</p>
    <label className={`script-import${disabled ? ' script-import-disabled' : ''}`}>
      {busy ? '現在の案件と照合しています…' : '変更案を読み込む'}
      <input type="file" accept=".json,application/json" aria-label="スキルの変更案を読み込む" disabled={disabled}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importDraft(file); }} />
    </label>
    {session.dirty && <p className="script-stage-note">編集中の内容を保存すると、変更案を確認できます。</p>}
    {busy && <button className="btn-secondary" onClick={() => {
      pending.current.token++; pending.current.controller?.abort(); setBusy(false);
    }}>変更案の確認を中止</button>}
    {error && <p className="script-error" role="alert">{error}</p>}
    {artifact && proposal && display && <div className="script-edit-content">
      <div className="script-result-heading"><h4>{proposal.kind === 'caption' ? '字幕の表記案' : '台本に沿った構成案'}</h4><span>{props.adoption ? '変更案' : '未適用'}</span></div>
      <p className="script-stage-note">{proposal.kind === 'caption' ? '字幕の表記だけを変更する案です。発話の時間と映像の順番は保ちます。'
        : '発話の時刻から残す範囲を求めた案です。前後の余裕や、つながりの自然さは映像で確認してください。'}</p>
      {stale && <p className="script-stale" role="status">現在の内容と照合し直す必要があります。保存状態を確認し、変更案を読み込み直してください。</p>}
      {proposal.kind === 'caption' && <ol className="script-edit-changes" aria-label="字幕の変更前後">
        {proposal.changes.slice(0, visible).map(change => {
          const target = display.telops.get(change.telopId)!;
          return <li key={change.telopId}><dl><dt>現在</dt><dd>{change.before}</dd><dt>提案</dt><dd>{change.after}</dd></dl>
            <button className="btn-secondary" disabled={stale || busy} onClick={() => onSeekSource((target.originalStart + target.originalEnd) / 2 / artifact.input.editing.fps * 1000)}>この字幕の区間を確認</button></li>;
        })}</ol>}
      {display.plan && <>
        <details><summary>現在の順番（{display.before.length}区間）</summary><ol aria-label="現在の映像の順番">{display.before.slice(0, visible).map((range, i) =>
          <li key={i}>{time(range.originalStart / artifact.input.editing.fps * 1000)}–{time(range.originalEnd / artifact.input.editing.fps * 1000)}</li>)}</ol></details>
        <p>提案：{display.plan.cutOrder.length}区間を台本順に使用</p>
        <details><summary>提案で使わない原素材（{display.plan.cutRegions.length}区間）</summary><ol aria-label="提案で使わない原素材">{display.plan.cutRegions.slice(0, visible).map((range, i) =>
          <li key={i}>{time(range.start / artifact.input.editing.fps * 1000)}–{time(range.end / artifact.input.editing.fps * 1000)}</li>)}</ol></details>
      </>}
      <ol className="script-edit-passages" aria-label="台本ごとの提案理由">{proposal.passages.slice(0, visible).map(decision => {
        const passage = display.passages.get(decision.passageId)!;
        const alignment = display.alignmentByPassage.get(decision.passageId)!;
        const candidate = decision.action === 'use' ? alignment.candidates[decision.candidateIndex]! : null;
        const words = artifact.input.alignment.packet.transcript.words;
        const start = candidate ? words[candidate.wordRef.startIndex]!.startMs : 0;
        const end = candidate ? words[candidate.wordRef.endIndex - 1]!.endMs : 0;
        return <li key={decision.passageId}>
          <span className="script-match-label">{proposal.kind === 'caption'
            ? decision.action === 'use' ? '表記の根拠に使う発話' : '表記変更の対象外'
            : decision.action === 'use' ? '使用する発話' : '今回は使用しない'}</span>
          <p>{artifact.input.alignment.packet.script.text.slice(passage.range.start, passage.range.end)}</p>
          <p className="script-proposal-reason">提案理由：{decision.reason}</p>
          {candidate && <><p className="script-stage-note">{candidate.match === 'literal' ? '文字が一致する候補' : 'モデルが提案した対応'}{alignment.candidates.length > 1 ? ` ／ 全${alignment.candidates.length}候補から選択` : ''}</p>
            <button className="btn-secondary" disabled={stale || busy} onClick={() => onSeekSource((start + end) / 2)}>{time(start)}–{time(end)} の発話を確認</button></>}
        </li>;
      })}</ol>
      {Math.max(proposal.passages.length, proposal.kind === 'caption' ? proposal.changes.length : 0,
        display.before.length, display.plan?.cutRegions.length ?? 0) > visible && <button className="btn-secondary" onClick={() => setVisible(n => n + 20)}>変更案の続きを表示</button>}
      <details className="script-stage-note"><summary>提案に記録されたスキルとモデル</summary>
        <p>{proposal.generator.skillId} / {proposal.generator.skillVersion}<br />{proposal.generator.provider} / {proposal.generator.model}</p></details>
      {props.adoption ? <ScriptAdoptionControls key={artifact.proposal.proposalId} {...props.adoption} artifact={artifact} disabled={stale || busy}
        isCurrent={() => {
          const current = latest.current;
          return !current.projectStale && !current.session.dirty && review.guard()
            && current.projectId === artifact.input.alignment.packet.projectId && current.mode === artifact.proposal.kind
            && current.previewVersion === review.previewVersion && current.transcript === review.transcript
            && samePersistedContent(current.session.state, review.state);
        }} /> : <p className="script-stage-note">読み込みと映像の確認では編集は変わりません。</p>}
    </div>}
  </section>;
}
