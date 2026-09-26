/** 秒を ffmpeg のフィルタ用文字列にする（小数 6 桁・指数表記を避ける）。 */
export function sec(frame: number, fps: number): string {
  return (frame / fps).toFixed(6);
}
