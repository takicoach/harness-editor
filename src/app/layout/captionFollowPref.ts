/** テキストベース編集の「再生に追従」。legacy の `sme.tx.follow-enabled` とは別キーにする（挙動が違う）。 */
const KEY='sme.native.caption-follow';
export function loadCaptionFollow():boolean {
  try{return localStorage.getItem(KEY)!=='0';}catch{return true;}
}
export function saveCaptionFollow(value:boolean):void {
  try{localStorage.setItem(KEY,value?'1':'0');}catch{/* プライベートウィンドウ等。既定の挙動で続ける。 */}
}
