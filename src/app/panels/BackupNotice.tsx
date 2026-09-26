import { backupTimeLabel } from '../backupLabel';

interface BackupNoticeProps {
  /** 退避先（プロジェクトフォルダからの相対パス）。 */
  backupDir: string;
  /** 「案件フォルダを開く」押下。 */
  onOpenFolder: () => void;
  /** 「閉じる」押下。読み終えるまでは自分から消えない。 */
  onDismiss: () => void;
}

/**
 * 上書き保存で消した内容の退避先の案内（data-safety-4 の持続表示）。
 *
 * これまで退避先はトースト 1 つにしか出ておらず、4 秒で消えて再表示の導線も無かった。
 * 全角 62 文字・3 行を読み切る前に消えると、復元の唯一の手がかりが失われ、
 * 非エンジニアの利用者は隠しフォルダ `.sme/backup/` を自力で探すしかなくなる
 * （サイクル 2 レビュー Important）。バナー帯に残し、閉じるのは利用者の操作だけにする。
 *
 * 「取り返しがつかない状態を作らない」ための案内なので、成功の知らせとして
 * 危険色は使わない（role も alert にしない）。
 */
export function BackupNotice({ backupDir, onOpenFolder, onDismiss }: BackupNoticeProps) {
  // フォルダ名は UTC のまま（場所の手がかり）。案内の文は現地時刻で言い換える。
  const when = backupTimeLabel(backupDir);
  return (
    <div className="ext-banner backup-notice" role="status">
      <div className="ext-banner-text">
        <strong>上書き保存しました（消えた内容の控えを残しています）</strong>
        <span>
          {when === null
            ? '以前の内容は案件フォルダの中に控えとして残っています。戻したいときはこの場所を開いてください: '
            : `以前の内容は案件フォルダの中に「${when}」として残っています。戻したいときはこの場所を開いてください: `}
          <code className="backup-notice-path">{backupDir}</code>
        </span>
      </div>
      <div className="ext-banner-actions">
        <button type="button" className="ext-banner-btn" onClick={onOpenFolder}>
          案件フォルダを開く
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>
          閉じる
        </button>
      </div>
    </div>
  );
}
