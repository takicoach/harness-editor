/** payload ローカルの CutSegment（ユーザープロジェクトへ同梱されるため src/core を import しない）。 */
export interface CutSegment {
  id: number;
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
}
