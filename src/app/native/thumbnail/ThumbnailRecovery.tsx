import type { ThumbnailBrokenInfo, ThumbnailSessionHook } from './useThumbnailSession';

/** 壊れたファイルは保全済み。利用者に隠しフォルダーの手編集を求めず、控えか新規かを選ばせる。 */
export function ThumbnailRecovery({ session, broken }: { session: ThumbnailSessionHook; broken: ThumbnailBrokenInfo }) {
  return <section className="native-thumbnail native-thumbnail-loading">
    <div className="native-thumbnail-recovery" role="alertdialog" aria-labelledby="native-thumbnail-recovery-title">
      <h2 id="native-thumbnail-recovery-title">サムネの保存ファイルが壊れていました</h2>
      <p>壊れたファイルは消さずに残してあります（{broken.preservedFiles.map(name => `.harness/${name}`).join('、')}）。どちらで再開するか選んでください。</p>
      <div className="native-thumbnail-row">
        <button type="button" className="btn-primary" disabled={!broken.backupAvailable || session.busy} onClick={() => void session.recover('backup')}>控えから戻す</button>
        <button type="button" className="btn-secondary" disabled={session.busy} onClick={() => void session.recover('new')}>新しく始める</button>
      </div>
      {!broken.backupAvailable && <p className="native-thumbnail-note">控え（直前に保存できた版）がありません。</p>}
    </div>
  </section>;
}
