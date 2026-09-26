import { useEffect, useRef, useState } from 'react';

const seconds = (frame: number, fps: number) => String(Number((frame / fps).toFixed(6)));

/** Keep both draft endpoints until a valid interval can be committed as one edit. */
export function FrameRangeFields({ start, end, fps, max, min = 0, readOnly = false, clock = 'source', onCommit }: {
  start: number; end: number; fps: number; max: number; readOnly?: boolean;
  min?: number;
  clock?: 'source' | 'final';
  onCommit: (start: number, end: number) => void;
}) {
  const initial = { start: seconds(start, fps), end: seconds(end, fps) };
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(initial);
  const committed = useRef({ start, end });
  const displayedFps = useRef(fps);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // An acknowledgement of our own commit must preserve the input nodes and
    // any next field being edited. Undo, dragging, and external timing changes
    // replace the draft without remounting the form or losing keyboard focus.
    if (committed.current.start === start && committed.current.end === end && displayedFps.current === fps) return;
    const next = { start: seconds(start, fps), end: seconds(end, fps) };
    committed.current = { start, end };
    displayedFps.current = fps;
    draftRef.current = next;
    setDraft(next);
    setError(null);
  }, [start, end, fps]);
  function update(next: typeof draft) { draftRef.current = next; setDraft(next); }
  function reset() { update(initial); setError(null); }
  function commit() {
    if (readOnly) return;
    const raw = draftRef.current;
    const a = Number(raw.start), b = Number(raw.end);
    if (raw.start.trim() === '' || raw.end.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) {
      setError('開始と終了を秒数で入力してください。変更はまだ確定していません。'); return;
    }
    const from = Math.round(a * fps), to = Math.round(b * fps);
    if (from < min || to > max) {
      setError(`${seconds(min, fps)}〜${seconds(max, fps)}秒の範囲で入力してください。変更はまだ確定していません。`); return;
    }
    if (to <= from) {
      setError('終了は開始より後にしてください。両方の入力が揃うまで変更を保留します。'); return;
    }
    setError(null);
    update({ start: seconds(from, fps), end: seconds(to, fps) });
    if (committed.current.start === from && committed.current.end === to) return;
    committed.current = { start: from, end: to };
    onCommit(from, to);
  }
  return <>
    <div className="editing-time-fields">
      {(['start', 'end'] as const).map(edge => <label key={edge}>
        {clock === 'final' ? (edge === 'start' ? '開始（完成動画の秒）' : '終了（完成動画の秒）') : (edge === 'start' ? '原素材 In（秒）' : '原素材 Out（秒）')}
        <input type="number" step={1 / fps} min={min / fps} max={max / fps} readOnly={readOnly}
          value={draft[edge]} aria-invalid={error ? true : undefined}
          onChange={event => update({ ...draftRef.current, [edge]: event.currentTarget.value })}
          onBlur={commit} onFocus={event => { if (!readOnly) event.currentTarget.select(); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); }
          }} />
      </label>)}
    </div>
    <p className="editing-time-exact">確定値：{start}–{end} フレーム（終了は含まない）</p>
    {error && <p className="editing-time-error" role="alert">{error}</p>}
  </>;
}
