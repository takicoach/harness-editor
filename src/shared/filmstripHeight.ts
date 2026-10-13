/** コマ絵の高さ（px）。ブラウザが要求し、サーバ（/api/sequence/frames）が受ける。確定値は事前の測定で決めた。 */
export const FRAME_THUMB_HEIGHT=72;
/** サーバが受ける高さ。h<高さ> のフォルダーが高さの数だけ増えるので、ブラウザが要求する値だけに限る。 */
export const FRAME_HEIGHTS:readonly number[]=[FRAME_THUMB_HEIGHT];
/** 1要求の時刻の上限。サーバはこれを越える要求を断り、ブラウザは1本のコマ絵をこの数までに収める。 */
export const FRAME_REQUEST_MAX_TIMES=24;
