import { useRef } from 'react';
import { DEFAULT_MAIN_AUDIO, MAIN_AUDIO_GAIN_DB_MIN, MAIN_AUDIO_GAIN_DB_MAX, mainAudioSettingsEqual, type MainAudioSettings } from '../../../core/mainAudio';
import type { EditState } from '../../edit/editState';
import { NumberField } from './shared';
import './mainAudioControls.css';

function update(state: EditState, patch: Partial<MainAudioSettings>): EditState {
  const next = { ...(state.mainAudio ?? DEFAULT_MAIN_AUDIO), ...patch };
  return mainAudioSettingsEqual(state.mainAudio, next) ? state : { ...state, mainAudio: next };
}

export function MainAudioControls({ state, fps, supported, onEdit, onLive }: {
  state: EditState; fps: number; supported: boolean;
  onEdit: (next: EditState) => void; onLive?: (next: EditState) => void;
}) {
  const audio = state.mainAudio ?? DEFAULT_MAIN_AUDIO;
  const drag = useRef<{ base: EditState; gainDb: number } | null>(null);
  const gain = (value: number) => Math.min(MAIN_AUDIO_GAIN_DB_MAX, Math.max(MAIN_AUDIO_GAIN_DB_MIN, value));
  const finish = (cancel: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    onLive?.(active.base);
    if (!cancel) onEdit(update(active.base, { gainDb: active.gainDb }));
  };
  return <section className="ins-section main-audio-controls" aria-label="元音声">
    <div className="main-audio-heading"><h3 className="ins-title">元音声</h3>
      <button type="button" className="tx-mini-btn" disabled={!supported || mainAudioSettingsEqual(audio, DEFAULT_MAIN_AUDIO)}
        onClick={() => onEdit(update(state, DEFAULT_MAIN_AUDIO))}>音声をリセット</button></div>
    <p className="ins-hint">メイン動画の音を調整します。BGMや効果音の音量はそのままです。</p>
    {!supported && <p className="export-note export-note-warn" role="note">この案件の動画構成は元音声の調整に未対応です。設定は変更せず保持しています。</p>}
    <fieldset disabled={!supported}>
      <legend className="sr-only">元音声の音量とフェード</legend>
      <div className="main-audio-gain-row">
        <label htmlFor="main-audio-gain-number">音量</label>
        <NumberField id="main-audio-gain-number" selectAllOnFocus value={audio.gainDb} min={MAIN_AUDIO_GAIN_DB_MIN} max={MAIN_AUDIO_GAIN_DB_MAX}
          step={0.5} decimals={1} suffix="dB" onCommit={value => onEdit(update(state, { gainDb: gain(value) }))} />
        <button type="button" className="tx-mini-btn main-audio-mute" aria-label="ミュート" aria-pressed={audio.muted}
          onClick={() => onEdit(update(state, { muted: !audio.muted }))}>{audio.muted ? 'ミュート中' : 'ミュート'}</button>
      </div>
      <input type="range" aria-label="元音声の音量" min={MAIN_AUDIO_GAIN_DB_MIN} max={MAIN_AUDIO_GAIN_DB_MAX} step={0.5}
        value={audio.gainDb} aria-valuetext={`${audio.gainDb} dB${audio.muted ? '（ミュート中）' : ''}`}
        onPointerDown={event => {
          if (event.button !== 0) return;
          drag.current = { base: state, gainDb: audio.gainDb };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onChange={event => {
          const gainDb = gain(Number(event.target.value));
          if (drag.current) { drag.current.gainDb = gainDb; onLive?.(update(drag.current.base, { gainDb })); }
          else onEdit(update(state, { gainDb }));
        }}
        onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
        onBlur={() => finish(false)} onKeyDown={event => {
          if (event.key === 'Escape' && drag.current) { event.stopPropagation(); finish(true); }
        }} />
      <div className="main-audio-scale" aria-hidden="true"><span>−60 dB</span><span>0 dB · 元の音量</span><span>+12 dB</span></div>
      <div className="main-audio-fades">
        {([{ key: 'fadeInFrames', label: 'フェードイン' }, { key: 'fadeOutFrames', label: 'フェードアウト' }] as const).map(({ key, label }) =>
          <label key={key} htmlFor={`main-audio-${key}`}><span>{label}</span>
            <NumberField id={`main-audio-${key}`} selectAllOnFocus value={audio[key] / fps} min={0} max={Number.MAX_SAFE_INTEGER / fps}
              step={0.1} decimals={2} suffix="秒" onCommit={value => onEdit(update(state, { [key]: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * fps))) }))} />
          </label>)}
      </div>
      <p className="ins-hint">完成動画の先頭と末尾で、元音声を徐々に大きく・小さくします。</p>
    </fieldset>
  </section>;
}
