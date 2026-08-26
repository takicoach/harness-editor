/**
 * ゴミ箱移動／完全削除の確認ダイアログ。HeavyJobConfirmDialog のオーバーレイ構造を踏襲。
 * 既定ボタン（autoFocus）は常にキャンセル — 使用中素材の誤削除防止（設計書 Phase 1 ④）。
 */
export interface TrashConfirmDialogProps {
  /** 表示名（ファイル名 or プロジェクト名）。 */
  name: string;
  /** 使用箇所数（クライアント編集状態＋サーバ走査の合算）。0 なら通常確認文言。 */
  usedCount: number;
  /**
   * 一括操作の対象名。渡すと「選択した N 件」の文言＋件名一覧になる（name は見出しに使わない）。
   * 未指定なら従来どおり単体の確認。
   */
  names?: string[];
  /** trash=ゴミ箱へ移動（復元可能） / purge=完全削除（不可逆）。 */
  mode: 'trash' | 'purge';
  /** 送信中。両ボタンを無効化して連打・二重送信と、警告を読む前の確定を防ぐ。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 件名一覧に出す上限。これを超えたら「ほか N 件」に畳む（ダイアログを画面外へ伸ばさない）。 */
const NAME_LIST_LIMIT = 10;

export function TrashConfirmDialog({ name, usedCount, names, mode, busy = false, onConfirm, onCancel }: TrashConfirmDialogProps) {
  const bulk = names !== undefined && names.length > 0;
  const text = bulk
    ? mode === 'purge'
      ? `選択した ${names.length} 件を完全に削除します。元に戻せません。`
      : `選択した ${names.length} 件をゴミ箱へ移動します。あとで復元できます。`
    : mode === 'purge'
      ? `「${name}」を完全に削除します。元に戻せません。`
      : usedCount > 0
        ? `「${name}」はタイムラインで ${usedCount} 箇所使われています。ゴミ箱へ移動すると、その箇所の表示・音が失われます。`
        : `「${name}」をゴミ箱へ移動します。あとで復元できます。`;
  return (
    <div className="hjc-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div
        className="hjc-dialog"
        role="dialog"
        aria-label="削除確認"
        data-testid="trash-confirm-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="hjc-text">{text}</p>
        {bulk && (
          <ul className="hjc-names" data-testid="trash-confirm-names">
            {names.slice(0, NAME_LIST_LIMIT).map((n, i) => (
              // 同名が並びうる（表示名は一意とは限らない）ので index を混ぜた key にする。
              <li key={`${i}-${n}`}>{n}</li>
            ))}
            {names.length > NAME_LIST_LIMIT && <li>ほか {names.length - NAME_LIST_LIMIT} 件</li>}
          </ul>
        )}
        <div className="hjc-actions">
          <button type="button" className="hjc-dismiss" autoFocus disabled={busy} onClick={onCancel}>
            キャンセル
          </button>
          {/*
            完全削除（不可逆）だけ赤の塗りにする。ゴミ箱へ移動は復元できるので警告色のまま
            ——「戻せない操作」と「戻せる操作」を同じ見た目にしない（危険操作の視覚差）。
          */}
          <button
            type="button"
            className={'hjc-confirm' + (mode === 'purge' ? ' hjc-danger' : '')}
            data-testid="trash-confirm-ok"
            disabled={busy}
            onClick={onConfirm}
          >
            {mode === 'purge' ? '完全に削除' : 'ゴミ箱へ移動'}
          </button>
        </div>
      </div>
    </div>
  );
}
