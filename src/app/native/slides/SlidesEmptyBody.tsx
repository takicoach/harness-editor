/** ページが無いとき（作ったばかり・全部消した）のキャンバスの代わり。onScript は「台本から作る」の引き出しができてから渡す。 */
export function SlidesEmptyBody({ onAddPage, onScript, disabled }: { onAddPage(): void; onScript?: () => void; disabled: boolean }) {
  return <section className="native-thumbnail-stage native-slides-empty" aria-label="キャンバス">
    <div className="native-slides-empty-card">
      <h2>まだページがありません</h2>
      <p>台本から AI に全ページを作らせるか、白紙のページを足して自分で作れます。</p>
      <div className="native-slides-row">
        {onScript && <button type="button" className="btn btn-primary" disabled={disabled} onClick={onScript}>台本から作る</button>}
        <button type="button" className="btn btn-secondary" disabled={disabled} onClick={onAddPage}>白紙のページを足す</button>
      </div>
    </div>
  </section>;
}
