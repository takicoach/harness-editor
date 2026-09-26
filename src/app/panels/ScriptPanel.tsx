import { useEffect, useRef, useState } from 'react';
import type { Transcript } from '../../core/types';
import { validateScriptProposalArtifact, type ScriptProposalArtifact } from '../../core/scriptProposalArtifact';
import { samePersistedContent, type EditState } from '../edit/editState';
import { setShootingScriptText } from '../edit/scriptOps';
import { fetchJson } from '../fetchJson';
import type { EditSession } from '../useEditSession';
import { ScriptEditReview } from './ScriptEditReview';
import type { ScriptAdoptionAccess } from './ScriptAdoptionControls';
import './ScriptPanel.css';

interface ScriptPanelProps {
  projectId: string;
  session: EditSession;
  transcript: Transcript;
  previewVersion: string | null;
  projectStale?: boolean;
  onSeekSource: (milliseconds: number) => void;
  adoption?: ScriptAdoptionAccess;
}
type Mode = 'caption' | 'structure';
type Result = { artifact: ScriptProposalArtifact; state: EditState; mode: Mode;
  sessionGuard: () => boolean; previewVersion: string | null; transcript: Transcript };
const label = { unique: '文字が一致', ambiguous: '候補が複数', unmatched: '一致が見つかりません' };
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${Math.floor(ms / 100) % 10}`;
}

/** Shooting-script correspondence; existing EditSession owns all changes and persistence. */
export function ScriptPanel(props: ScriptPanelProps) {
  const { session, projectId, transcript, previewVersion, projectStale = false, onSeekSource } = props;
  const [mode, setMode] = useState<Mode>('caption');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [candidateCounts, setCandidateCounts] = useState<Record<string, number>>({});
  const resultsRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ token: number; controller: AbortController | null }>({ token: 0, controller: null });
  const latest = useRef({ ...props, mode });
  latest.current = { ...props, mode };
  useEffect(() => () => { pending.current.token++; pending.current.controller?.abort(); }, []);
  useEffect(() => { if (result) resultsRef.current?.scrollIntoView?.({ block: 'start' }); }, [result]);
  const script = session.state.scriptDocument;
  const stale = result !== null && (projectStale || result.mode !== mode || session.dirty || !result.sessionGuard()
    || result.previewVersion !== previewVersion || result.transcript !== transcript
    || !samePersistedContent(result.state, session.state));

  function changeText(text: string) {
    try { session.apply(state => setShootingScriptText(state, text)); setError(null); }
    catch { setError('台本を読み込めませんでした。文章の長さや文字を確認してください。'); }
  }

  async function align() {
    const captured = session.state;
    if (!captured.scriptDocument || latest.current.projectStale) return;
    const stillSameSession = session.sessionGuard();
    const token = ++pending.current.token;
    pending.current.controller?.abort();
    const controller = new AbortController();
    pending.current.controller = controller;
    setBusy(true); setError(null);
    const isCurrent = () => pending.current.token === token && stillSameSession()
      && latest.current.projectId === projectId && latest.current.mode === mode
      && latest.current.previewVersion === previewVersion && latest.current.transcript === transcript
      && !latest.current.projectStale
      && samePersistedContent(latest.current.session.state, captured);
    try {
      if (session.dirty && !await session.save({ expectedState: captured })) throw new Error('保存できませんでした。画面上部の保存状態を確認してから、もう一度お試しください。');
      if (!isCurrent()) throw new Error('照合中に編集内容が変わりました。現在の内容でもう一度照合してください。');
      const query = new URLSearchParams({ id: projectId, mode });
      if (previewVersion !== null) query.set('expectedPreviewVersion', previewVersion);
      const value = await fetchJson<unknown>(`/api/script-alignment?${query}`, { signal: controller.signal });
      const artifact = validateScriptProposalArtifact(value);
      if (!isCurrent()) throw new Error('照合中に編集内容が変わりました。現在の内容でもう一度照合してください。');
      const expectedWords = transcript.words.map((word, index) => ({ index, text: word.text, startMs: word.start, endMs: word.end }));
      const skillId = mode === 'caption' ? 'subtitle-orthography' : 'script-structure';
      if (artifact.packet.projectId !== projectId || JSON.stringify(artifact.packet.script) !== JSON.stringify(captured.scriptDocument)
        || JSON.stringify(artifact.packet.transcript.words) !== JSON.stringify(expectedWords)
        || artifact.proposals.some(proposal => proposal.generator.skillId !== skillId)) {
        throw new Error('案件の台本または文字起こしが更新されています。未保存の内容を確認してから案件を読み直してください。');
      }
      setResult({ artifact, state: captured, mode, sessionGuard: stillSameSession, previewVersion, transcript });
      setVisibleCount(20); setSelected(null); setCandidateCounts({});
    } catch (cause) {
      if (pending.current.token === token && !controller.signal.aborted) {
        setError(cause instanceof Error && cause.name !== 'ZodError' ? cause.message : '照合結果を確認できませんでした。もう一度お試しください。');
      }
    } finally { if (pending.current.token === token) setBusy(false); }
  }

  const proposals = result?.artifact.proposals ?? [];
  const visible = onlyAttention ? proposals.filter(proposal => proposal.status !== 'unique') : proposals;
  return <section className="script-panel" aria-label="撮影台本">
    <header><p className="script-eyebrow">撮影した言葉と、台本をつなぐ</p><h2>台本</h2>
      <p>撮影で使った台本を貼り付けてください。改行ごとに発話を探します。</p></header>
    <label className="script-input-label" htmlFor={`shooting-script-${projectId}`}>撮影で使った台本</label>
    <textarea id={`shooting-script-${projectId}`} aria-label="撮影で使った台本" value={script?.text ?? ''}
      onChange={event => changeText(event.target.value)} placeholder="今日は、長いアイアンの打ち方をお話しします。" rows={5} maxLength={2000000} />
    <div className="script-input-meta"><span>{script?.passages.length ?? 0} 文章</span>
      <label className="script-import">テキストを読み込む<input type="file" accept=".txt,text/plain" aria-label="台本のテキストファイルを読み込む"
        onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
          const initial = latest.current.session.state, guard = latest.current.session.sessionGuard();
          try {
            if (file.size > 8_000_000) throw new Error('台本ファイルは8MB以内にしてください。');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
            if (!guard() || latest.current.projectId !== projectId || !samePersistedContent(latest.current.session.state, initial)) throw new Error('読み込み中に編集内容が変わりました。もう一度ファイルを選んでください。');
            latest.current.session.apply(state => setShootingScriptText(state, text)); setError(null);
          } catch (cause) { setError(cause instanceof Error && cause.name === 'Error' ? cause.message : 'UTF-8のテキストファイルを読み込んでください。'); }
        }} /></label></div>
    <fieldset className="script-purpose"><legend>照合の目的</legend>
      <label><input type="radio" name={`script-mode-${projectId}`} value="caption" checked={mode === 'caption'} onChange={() => setMode('caption')} />
        <span><strong>字幕の表記を揃える</strong><small>発話のタイミングを保つ</small></span></label>
      <label><input type="radio" name={`script-mode-${projectId}`} value="structure" checked={mode === 'structure'} onChange={() => setMode('structure')} />
        <span><strong>台本の構成に揃える</strong><small>使う発話と順番を考える</small></span></label>
    </fieldset>
    <button className="btn-primary script-align" disabled={!script || busy || projectStale || session.saveStatus === 'saving'} onClick={() => void align()}>
      {busy ? '発話を探しています…' : session.dirty ? '保存して発話と照合' : '発話と照合'}</button>
    {busy && <button className="btn-secondary script-align" onClick={() => {
      pending.current.token++; pending.current.controller?.abort(); setBusy(false); setError(null);
    }}>照合を中止</button>}
    <p className="script-stage-note">文字が一致する発話を探します。スキルが作成した変更案は、下の「スキルの変更案を確認」から読み込めます。</p>
    {projectStale && <p className="script-stale" role="status">案件が別の画面で更新されています。未保存の内容を確認してから、画面上部の案内で読み直してください。</p>}
    {error && <p className="script-error" role="alert">{error}</p>}
    {result && <div ref={resultsRef} className="script-results" aria-label="台本の照合結果">
      <div className="script-result-heading"><h3>発話との対応</h3><span>{proposals.length} 文章</span></div>
      <p className="script-summary" role="status">一致 {proposals.filter(p => p.status === 'unique').length} ・候補複数 {proposals.filter(p => p.status === 'ambiguous').length} ・未対応 {proposals.filter(p => p.status === 'unmatched').length}</p>
      {stale && <p className="script-stale" role="status">編集内容が変わっています。もう一度照合してください。</p>}
      <label className="script-filter"><input type="checkbox" checked={onlyAttention} onChange={event => { setOnlyAttention(event.target.checked); setVisibleCount(20); }} />確認が必要な文章だけ</label>
      <ol>{visible.slice(0, visibleCount).map(proposal => <li key={proposal.proposalId} className="script-passage" data-status={proposal.status}>
        <span className="script-match-label">{label[proposal.status]}</span>
        <p>{result.artifact.packet.script.text.slice(proposal.scriptRange.start, proposal.scriptRange.end)}</p>
        {proposal.candidates.length === 0 ? <small>言い換えや未撮影の可能性があります。自動では対応を決めません。</small>
          : <div className="script-candidates">{proposal.candidates.slice(0, candidateCounts[proposal.proposalId] ?? 20).map((candidate, index) => {
            // The complete artifact was validated once at the API boundary; don't parse a large packet for every button.
            const words = result.artifact.packet.transcript.words;
            const range = { startMs: words[candidate.wordRef.startIndex]!.startMs, endMs: words[candidate.wordRef.endIndex - 1]!.endMs };
            const key = `${proposal.proposalId}:${index}`;
            return <button key={key} disabled={stale || busy} className={selected === key ? 'selected' : ''} aria-pressed={selected === key}
              title={`原素材の ${clock(range.startMs)} の発話を確認`} onClick={() => { setSelected(key); onSeekSource((range.startMs + range.endMs) / 2); }}>
              {proposal.candidates.length > 1 ? `候補 ${index + 1} ` : ''}{clock(range.startMs)}–{clock(range.endMs)}</button>;
          })}{proposal.candidates.length > (candidateCounts[proposal.proposalId] ?? 20) && <button
            onClick={() => setCandidateCounts(counts => ({ ...counts, [proposal.proposalId]: (counts[proposal.proposalId] ?? 20) + 20 }))}>
            他の候補を表示（全{proposal.candidates.length}件）</button>}</div>}
      </li>)}</ol>
      {visible.length === 0 && <p>確認が必要な文章はありません。</p>}
      {visible.length > visibleCount && <button className="btn-secondary" onClick={() => setVisibleCount(count => count + 20)}>続きを表示（残り{visible.length - visibleCount}文章）</button>}
      <p className="script-stage-note">時刻を押すとカット前の映像へ移動します。候補の選択では映像や字幕は変更されません。</p>
    </div>}
    <ScriptEditReview projectId={projectId} mode={mode} session={session} transcript={transcript}
      previewVersion={previewVersion} projectStale={projectStale} onSeekSource={onSeekSource} adoption={props.adoption} />
  </section>;
}
