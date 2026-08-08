import { useState, useEffect } from 'react';
import { useAudition } from '../../audio/useAudition';
import { assetPathFor, assetUrl } from '../materialList';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorSe } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import { moveSe, setSeFile, setSeVolume, removeSe, setSeFadeIn, setSeFadeOut } from '../../edit/seOps';
import { VOLUME_PRESETS } from './shared';

/** 音量プリセット（小/中/大・SE/BGM 共通）。 */
interface SeSettingsTabProps {
  se: EditorSe;
  state: EditState;
  fps: number;
  seLibrary: string[];
  projectId: string;
  assetVersions?: Record<string, string>;
  onEdit: (next: EditState) => void;
}

/** SE 選択時のインスペクタ本体（ファイル・音量・試聴・鳴らす時間・削除）。 */
export function SeSettingsTab({ se, state, fps, seLibrary, projectId, assetVersions, onEdit }: SeSettingsTabProps) {
  const audition = useAudition();
  // 再生（カット後）フレームでユーザーに見せる。カット区間内なら null。
  const playbackFrame = originalToPlayback(se.originalStart, state.cutRegions);
  const shown = playbackFrame ?? se.originalStart;
  const editable = playbackFrame !== null;
  // volume 未指定 SE は ハーネス形式の再生既定（volume ?? 1）と一致させる。
  // 新規追加 SE は addSe が 0.3 を明示するため、ここは「ファイル経由で来た既存 SE」
  // 用のフォールバック。0.3 表示だと初回スライダー操作で実音量がいきなり下がってしまう。
  const volume = se.volume ?? 1;
  // 現在のファイルがライブラリに無くても選べるよう先頭へ補う。
  const fileOptions = seLibrary.includes(se.file) ? seLibrary : [se.file, ...seLibrary];
  const seAuditionUrl = assetUrl(projectId, assetPathFor('se', se.file), assetVersions);

  const [frameStr, setFrameStr] = useState(frameToSec(shown, fps).toFixed(2));
  useEffect(() => {
    setFrameStr(frameToSec(shown, fps).toFixed(2));
  }, [shown, fps]);

  const [fadeInStr, setFadeInStr] = useState(frameToSec(se.fadeInFrames ?? 0, fps).toFixed(2));
  const [fadeOutStr, setFadeOutStr] = useState(frameToSec(se.fadeOutFrames ?? 0, fps).toFixed(2));
  useEffect(() => { setFadeInStr(frameToSec(se.fadeInFrames ?? 0, fps).toFixed(2)); }, [se.fadeInFrames, fps]);
  useEffect(() => { setFadeOutStr(frameToSec(se.fadeOutFrames ?? 0, fps).toFixed(2)); }, [se.fadeOutFrames, fps]);

  function commitFadeIn(): void {
    const frame = parseSecField(fadeInStr, se.fadeInFrames ?? 0, fps);
    if (frame === null) { setFadeInStr(frameToSec(se.fadeInFrames ?? 0, fps).toFixed(2)); return; }
    onEdit(setSeFadeIn(state, se.id, frame));
  }
  function commitFadeOut(): void {
    const frame = parseSecField(fadeOutStr, se.fadeOutFrames ?? 0, fps);
    if (frame === null) { setFadeOutStr(frameToSec(se.fadeOutFrames ?? 0, fps).toFixed(2)); return; }
    onEdit(setSeFadeOut(state, se.id, frame));
  }

  /** 秒入力 → 再生フレームへ変換 → 原本フレームへ逆射影して moveSe を適用する。 */
  function commitFrame(): void {
    const frame = parseSecField(frameStr, shown, fps);
    if (frame === null) { setFrameStr(frameToSec(shown, fps).toFixed(2)); return; }
    onEdit(moveSe(state, se.id, playbackToOriginal(frame, state.cutRegions)));
  }

  return (
    <>
      <div className="ins-section">
        <div className="ins-label">
          <span>効果音 #{se.id}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
          {`${formatClock(frameToSec(se.originalStart, fps))} — ${formatClock(frameToSec(se.originalEnd, fps))}`}
        </div>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>効果音ファイル</span></div>
        <select
          className="hl-input"
          value={se.file}
          onChange={(e) => onEdit(setSeFile(state, se.id, e.target.value))}
        >
          {fileOptions.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>音量 {Math.round(volume * 100)}%</span></div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => onEdit(setSeVolume(state, se.id, Number(e.target.value)))}
        />
        <div className="ins-volume-presets">
          {VOLUME_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="ins-volume-preset"
              onClick={() => onEdit(setSeVolume(state, se.id, p.value))}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={'tx-mini-btn' + (audition.playingPath === seAuditionUrl ? ' playing' : '')}
          style={{ marginTop: 8 }}
          onClick={() => audition.toggle(seAuditionUrl, volume)}
        >
          {audition.playingPath === seAuditionUrl ? '停止' : '試聴'}
        </button>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>フェード（秒）</span></div>
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-se-fade-in">フェードイン</label>
            <input
              id="ins-se-fade-in"
              type="number"
              step={0.1}
              min={0}
              value={fadeInStr}
              onChange={(e) => setFadeInStr(e.target.value)}
              onBlur={() => commitFadeIn()}
              onKeyDown={(e) => { if (e.key === 'Enter') commitFadeIn(); }}
            />
          </div>
          <div className="num-field">
            <label htmlFor="ins-se-fade-out">フェードアウト</label>
            <input
              id="ins-se-fade-out"
              type="number"
              step={0.1}
              min={0}
              value={fadeOutStr}
              onChange={(e) => setFadeOutStr(e.target.value)}
              onBlur={() => commitFadeOut()}
              onKeyDown={(e) => { if (e.key === 'Enter') commitFadeOut(); }}
            />
          </div>
        </div>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>鳴らす時間（秒）</span></div>
        {!editable && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 6px' }}>
            この効果音はカット区間内にあります。ここでは編集できません。
            このまま保存するとカット終端へ寄せて出力されます（位置は復元できません）。
          </p>
        )}
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-se-frame">開始</label>
            <input
              id="ins-se-frame"
              type="number"
              step={0.1}
              value={frameStr}
              disabled={!editable}
              onChange={(e) => setFrameStr(e.target.value)}
              onBlur={() => editable && commitFrame()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editable) commitFrame();
              }}
            />
          </div>
        </div>
      </div>

      <div className="ins-section">
        <button className="tx-mini-btn" onClick={() => onEdit(removeSe(state, se.id))}>
          この効果音を削除
        </button>
      </div>
    </>
  );
}
