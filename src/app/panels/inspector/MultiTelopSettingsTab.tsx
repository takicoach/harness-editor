import type { EditorTelop } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import { setTelopsPosition, setTelopsScale, removeTelops } from '../../edit/telopSettingsOps';
import { TelopPositionFields } from './TelopPositionFields';

interface MultiTelopSettingsTabProps {
  /** 編集の正。複数選択集合は `state.multiTelopIds`。 */
  state: EditState;
  /** 編集操作（履歴へ積む）。 */
  onEdit: (next: EditState) => void;
}

/**
 * テロップ複数選択時の設定パネル（設計書 §3）。
 *
 * 出すのは「位置プリセット / 左右・上下位置 / 大きさ / まとめて削除」だけ。
 * スタイル・本文・表示タイミングは 1 つずつ選んで直す方が安全なのでここには出さない
 * （スコープ外・設計書 §5）。
 *
 * 表示している数値はプライマリ（`selection`）の値で、**混在していても `—` は出さない**。
 * 代わりに「値を変えると選択中の全テロップに適用されます」を常設し、確定した値だけを
 * 全員へ書き込む（＝揃える）。非エンジニア向けに表示を複雑化しないための裁定。
 */
export function MultiTelopSettingsTab({ state, onEdit }: MultiTelopSettingsTabProps) {
  const ids = state.multiTelopIds;
  const selected: EditorTelop[] = state.telops.filter((t) => ids.includes(t.id));
  const primaryId = state.selection?.kind === 'telop' ? state.selection.id : null;
  const primary = selected.find((t) => t.id === primaryId) ?? selected[0];
  // 不変条件（サイズ 2 以上・プライマリ包含）が守られていれば primary は必ず居る。
  if (primary === undefined) return null;

  const position = primary.position ?? { x: 0, y: 0 };
  const scale = primary.scale ?? 1;
  // 削除できるのは飾りテロップ（manual）だけ。字幕の削除は区間カットという既存契約を変えない。
  const manualIds = selected.filter((t) => t.manual === true).map((t) => t.id);
  const subtitleCount = selected.length - manualIds.length;

  return (
    <>
      <div className="ins-section">
        <div className="ins-label">
          <span>テロップ {selected.length} 個を選択中</span>
        </div>
        <p className="ins-pack-hint">値を変えると選択中の全テロップに適用されます。</p>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>位置・大きさ</span></div>
        <TelopPositionFields
          idPrefix="ins-multi"
          position={position}
          scale={scale}
          commitMode="blur"
          onPosition={(x, y) => onEdit(setTelopsPosition(state, ids, x, y))}
          onScale={(v) => onEdit(setTelopsScale(state, ids, v))}
        />
      </div>

      <div className="ins-section">
        <button
          type="button"
          className="tx-mini-btn ins-multi-remove"
          disabled={manualIds.length === 0}
          onClick={() => onEdit(removeTelops(state, ids))}
        >
          選択中の飾りテロップ {manualIds.length} 個を削除
        </button>
        {subtitleCount > 0 && (
          <p className="ins-pack-hint">
            字幕 {subtitleCount} 件は対象外（字幕の削除は区間カットで行います）。
          </p>
        )}
      </div>
    </>
  );
}
