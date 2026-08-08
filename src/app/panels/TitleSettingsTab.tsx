import { useState, useEffect } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorTitle } from '../../core/types';
import type { EditState } from '../edit/editState';
import { setTitleText, setTitleTiming, splitTitleAt, removeTitle } from '../edit/titleOps';
import { originalToPlayback, playbackToOriginal } from '../../core/cutEngine';
import { frameToSec, parseSecField } from '../../shared/format';

interface TitleSettingsTabProps {
  title: EditorTitle;
  state: EditState;
  fps: number;
  playerRef: RefObject<PlayerRef | null>;
  onEdit: (next: EditState) => void;
}

export function TitleSettingsTab({ title, state, fps, playerRef, onEdit }: TitleSettingsTabProps) {
  // 表示タイミングは再生（カット後）フレームでユーザーに見せる。
  const playbackStart = originalToPlayback(title.originalStart, state.cutRegions);
  const playbackEnd = originalToPlayback(title.originalEnd, state.cutRegions);
  // カット区間内へ落ちている端は null。その場合は原本フレームをそのまま表示する。
  const shownStart = playbackStart ?? title.originalStart;
  const shownEnd = playbackEnd ?? title.originalEnd;
  const timingEditable = playbackStart !== null && playbackEnd !== null;

  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));

  // 外部要因（選択変更・Undo/Redo・カット変更）で shownStart/End が変わったら同期する。
  useEffect(() => { setStartStr(frameToSec(shownStart, fps).toFixed(2)); }, [shownStart, fps]);
  useEffect(() => { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); }, [shownEnd, fps]);

  /** 再生フレーム入力 → 原本フレームへ逆射影してタイミングを更新する。 */
  function commitTiming(nextStart: number, nextEnd: number): void {
    const origStart = playbackToOriginal(nextStart, state.cutRegions);
    const origEnd = playbackToOriginal(nextEnd, state.cutRegions);
    onEdit(setTitleTiming(state, title.id, origStart, origEnd));
  }

  function commitStart(): void {
    const frame = parseSecField(startStr, shownStart, fps);
    if (frame === null) { setStartStr(frameToSec(shownStart, fps).toFixed(2)); return; }
    commitTiming(frame, shownEnd);
  }

  function commitEnd(): void {
    const frame = parseSecField(endStr, shownEnd, fps);
    if (frame === null) { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); return; }
    commitTiming(shownStart, frame);
  }

  /** 分割: onClick で現在の再生ヘッドを読み取り、原本フレームへ逆射影して splitTitleAt を適用する。
   *  範囲外の場合は reducer が no-op になる。 */
  function handleSplit(): void {
    const pf = Math.round(playerRef.current?.getCurrentFrame() ?? 0);
    const atOriginalFrame = playbackToOriginal(pf, state.cutRegions);
    onEdit(splitTitleAt(state, title.id, atOriginalFrame));
  }

  return (
    <>
      <div className="ins-section">
        <div className="ins-label">
          <span>タイトル #{title.id}</span>
        </div>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>文字</span></div>
        <textarea
          className="tx-text-edit"
          value={title.text}
          rows={2}
          onChange={(e) => onEdit(setTitleText(state, title.id, e.target.value))}
        />
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>表示する時間（秒）</span></div>
        {!timingEditable && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 6px' }}>
            このタイトルはカット区間にかかっているため、ここでは編集できません
          </p>
        )}
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-title-start">開始</label>
            <input
              id="ins-title-start"
              type="number"
              step={0.1}
              value={startStr}
              disabled={!timingEditable}
              onChange={(e) => setStartStr(e.target.value)}
              onBlur={() => { if (timingEditable) commitStart(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && timingEditable) commitStart();
              }}
            />
          </div>
          <div className="num-field">
            <label htmlFor="ins-title-end">終了</label>
            <input
              id="ins-title-end"
              type="number"
              step={0.1}
              value={endStr}
              disabled={!timingEditable}
              onChange={(e) => setEndStr(e.target.value)}
              onBlur={() => { if (timingEditable) commitEnd(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && timingEditable) commitEnd();
              }}
            />
          </div>
        </div>
      </div>

      <div className="ins-section ins-title-actions">
        {/* カット区間にかかっているタイトルは再生フレーム⇔原本フレームの対応が取れず
            分割位置を決められないため、タイミング編集と同じく分割も無効化する。 */}
        <button type="button" className="tx-mini-btn" onClick={handleSplit} disabled={!timingEditable}>
          再生位置で分割
        </button>
        <button type="button" className="tx-mini-btn ins-title-del" onClick={() => onEdit(removeTitle(state, title.id))}>
          このタイトルを削除
        </button>
      </div>
    </>
  );
}
