import { useEffect, useState } from 'react';
import type { TelopPosition } from '../../../core/types';
import { POSITION_PRESETS } from '../../preview/positionPresets';

/**
 * 値の確定タイミング。
 * - `'change'`: 1 文字打つたびに適用する（単一選択の従来挙動）。
 * - `'blur'`: フォーカスを外す / Enter で確定してから適用する。複数選択の一括適用は
 *   打鍵ごとに全員へ書き込むと中間値（"-0" 等）で履歴が埋まるため、こちらを使う。
 */
export type CommitMode = 'change' | 'blur';

interface TelopPositionFieldsProps {
  /** input の id 接頭辞。`{prefix}-pos-x` / `{prefix}-pos-y` / `{prefix}-scale` になる。 */
  idPrefix: string;
  /** 表示する位置（複数選択ではプライマリの値）。 */
  position: TelopPosition;
  /** 表示する大きさ（複数選択ではプライマリの値）。 */
  scale: number;
  commitMode: CommitMode;
  onPosition: (x: number, y: number) => void;
  onScale: (scale: number) => void;
}

/**
 * テロップの位置プリセット・左右/上下位置・大きさの入力部（単一選択と複数選択で共有）。
 * 位置プリセットのクリックは commitMode に関わらず即時確定（クリック自体が確定操作）。
 */
export function TelopPositionFields({
  idPrefix,
  position,
  scale,
  commitMode,
  onPosition,
  onScale,
}: TelopPositionFieldsProps) {
  // blur 確定モードでは入力中の文字列をローカルに持ち、確定時だけ数値へ変換して適用する。
  const [xStr, setXStr] = useState(String(position.x));
  const [yStr, setYStr] = useState(String(position.y));
  const [scaleStr, setScaleStr] = useState(String(scale));
  // 外部要因（選択変更・Undo/Redo・プリセット適用）で値が変わったら表示を同期する。
  useEffect(() => { setXStr(String(position.x)); }, [position.x]);
  useEffect(() => { setYStr(String(position.y)); }, [position.y]);
  useEffect(() => { setScaleStr(String(scale)); }, [scale]);

  const immediate = commitMode === 'change';

  /** 入力文字列を数値化して適用する。数値にならなければ表示を元へ戻す。 */
  function commitX(raw: string): void {
    const v = Number(raw);
    if (Number.isFinite(v) && raw.trim() !== '') onPosition(v, position.y);
    else setXStr(String(position.x));
  }
  function commitY(raw: string): void {
    const v = Number(raw);
    if (Number.isFinite(v) && raw.trim() !== '') onPosition(position.x, v);
    else setYStr(String(position.y));
  }
  function commitScale(raw: string): void {
    const v = Number(raw);
    if (Number.isFinite(v) && raw.trim() !== '') onScale(v);
    else setScaleStr(String(scale));
  }

  return (
    <>
      <div className="pos-pad">
        {POSITION_PRESETS.map((row, ri) =>
          row.map((preset, ci) => (
            <button
              key={`${ri}-${ci}`}
              className={position.x === preset.x && position.y === preset.y ? 'active' : ''}
              title={`位置プリセット (${preset.x}, ${preset.y})`}
              onClick={() => onPosition(preset.x, preset.y)}
            />
          )),
        )}
      </div>
      <div className="num-row" style={{ marginTop: 8 }}>
        <div className="num-field">
          <label htmlFor={`${idPrefix}-pos-x`} title="-1=左 / 0=中央 / 1=右">左右位置</label>
          <input
            id={`${idPrefix}-pos-x`}
            type="number"
            step={0.1}
            value={immediate ? position.x : xStr}
            onChange={(e) => {
              if (!immediate) {
                setXStr(e.target.value);
                return;
              }
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onPosition(v, position.y);
            }}
            onBlur={(e) => { if (!immediate) commitX(e.target.value); }}
            onKeyDown={(e) => {
              if (immediate || e.key !== 'Enter') return;
              commitX((e.target as HTMLInputElement).value);
            }}
          />
        </div>
        <div className="num-field">
          <label htmlFor={`${idPrefix}-pos-y`} title="-1=上 / -0.5=中央 / 0=下（既定）">上下位置</label>
          <input
            id={`${idPrefix}-pos-y`}
            type="number"
            step={0.1}
            value={immediate ? position.y : yStr}
            onChange={(e) => {
              if (!immediate) {
                setYStr(e.target.value);
                return;
              }
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onPosition(position.x, v);
            }}
            onBlur={(e) => { if (!immediate) commitY(e.target.value); }}
            onKeyDown={(e) => {
              if (immediate || e.key !== 'Enter') return;
              commitY((e.target as HTMLInputElement).value);
            }}
          />
        </div>
        <div className="num-field">
          <label htmlFor={`${idPrefix}-scale`} title="1=標準（0.3〜3 の範囲）">大きさ</label>
          <input
            id={`${idPrefix}-scale`}
            type="number"
            step={0.1}
            value={immediate ? scale : scaleStr}
            onChange={(e) => {
              if (!immediate) {
                setScaleStr(e.target.value);
                return;
              }
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onScale(v);
            }}
            onBlur={(e) => { if (!immediate) commitScale(e.target.value); }}
            onKeyDown={(e) => {
              if (immediate || e.key !== 'Enter') return;
              commitScale((e.target as HTMLInputElement).value);
            }}
          />
        </div>
      </div>
    </>
  );
}
