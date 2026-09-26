import { linkSync, unlinkSync } from 'node:fs';

/** 完成した同一ファイルシステム内の動画を、既存の宛先を置換せず公開する。 */
export function publishRenderOutput(source: string, destination: string): void {
  // link は宛先が存在すれば EEXIST。exists → rename の競合窓を作らない。
  linkSync(source, destination);
  try { unlinkSync(source); } catch { /* 公開済み。中間ファイルの掃除失敗で完成を取り消さない。 */ }
}
