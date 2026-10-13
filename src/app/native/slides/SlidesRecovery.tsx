import type { SlidesBrokenInfo, SlidesSessionHook } from './useSlidesSession';

/** 保存ファイルが壊れていたとき（保全済み）。隠しフォルダーの手直しを求めず、控えから戻すか新しく始めるかを選ぶ。 */
export function SlidesRecovery({ session, broken, onHome }: { session: SlidesSessionHook; broken: SlidesBrokenInfo; onHome(): void }) {
  return <section className="native-slides-recovery" role="alert">
    <h2>スライドの保存ファイルを読めませんでした</h2>
    <p>壊れたファイルは消さずに {broken.preservedFiles.join('・') || '.harness フォルダー'} として残しました。控え（直前に保存できた版）から戻すか、新しく始めるかを選んでください。</p>
    <div className="native-slides-row">
      <button type="button" className="btn btn-primary" disabled={!broken.backupAvailable || session.busy} onClick={() => void session.recover('backup')}>控えから戻す</button>
      <button type="button" className="btn btn-secondary" disabled={session.busy} onClick={() => void session.recover('new')}>新しく始める</button>
      <button type="button" className="btn btn-ghost" onClick={onHome}>ホームへ戻る</button>
    </div>
  </section>;
}
