import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { EditorPlaybackRef as PlayerRef } from './editorPlayback';
import { formatTimecode, parseTimecode } from '../../shared/timecode';

interface Props {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  durationInFrames: number;
  sourceMode: boolean;
  disabled?: boolean;
}

export function PlayheadInput({ playerRef, fps, durationInFrames, sourceMode, disabled }: Props) {
  const [frame, setFrame] = useState(0);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  const errorId = useId();
  useEffect(() => {
    const player = playerRef.current;
    setReady(player !== null);
    if (!player) return;
    setFrame(player.getCurrentFrame());
    const onFrame = (event: { detail: { frame: number } }) => setFrame(event.detail.frame);
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [playerRef, durationInFrames, sourceMode]);

  const commit = () => {
    if (cancelBlur.current) { cancelBlur.current = false; return; }
    if (draft === null) return;
    const target = parseTimecode(draft, fps);
    if (target === null || target >= durationInFrames) {
      setError(target === null ? '秒数または時:分:秒:コマで入力してください'
        : `最後のコマは ${formatTimecode(Math.max(0, durationInFrames - 1), fps)} です`);
      return;
    }
    const player = playerRef.current;
    if (!player || disabled) return;
    player.pause();
    player.seekTo(target);
    setFrame(target); setDraft(null); setError(null);
  };

  return <div className="pv-timecode">
    <label>
      <span>{sourceMode ? '原素材の再生位置' : '再生位置'}</span>
      <input
        type="text"
        aria-label="再生位置（時:分:秒:コマ）"
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        title="秒数（30）、分:秒（1:00）、時:分:秒:コマ（00:01:00:00）、フレーム番号（1800f）で移動"
        value={draft ?? formatTimecode(frame, fps)}
        disabled={disabled || !ready}
        spellCheck={false}
        onFocus={(event) => {
          playerRef.current?.pause();
          setDraft(event.currentTarget.value);
          event.currentTarget.select();
        }}
        onChange={(event) => { setDraft(event.currentTarget.value); setError(null); }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') {
            event.preventDefault(); cancelBlur.current = true;
            setDraft(null); setError(null); event.currentTarget.blur();
          }
        }}
      />
    </label>
    <span aria-label={sourceMode ? '原素材の尺（時:分:秒:コマ）' : '完成尺（時:分:秒:コマ）'}>
      / {formatTimecode(durationInFrames, fps)}
    </span>
    <span className="pv-timecode-rate" title="時:分:秒:コマ。小数fpsはノンドロップフレーム表示">
      {Number(fps.toFixed(3))} fps{Number.isInteger(fps) ? '' : ' NDF'}
    </span>
    {error && <span id={errorId} className="pv-timecode-error" role="alert">{error}</span>}
  </div>;
}
