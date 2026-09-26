/**
 * 撮影ページから見た「'remotion' の面」（M2b T2・設計判断1／M2c T2・設計点(a)で改訂）。
 *
 * 旧実装は `import * as remotionSpecifier from 'remotion'` で読み、ブラウザの importmap
 * （'remotion' → captureRuntime バレル）に解決を委ねていた。M2c の captureRunPlanner は
 * **Node で** layers.tsx（→ 本ファイル経由）を直接 require する。Node には importmap が無く
 * 'remotion' は node_modules の real remotion package に解決されてしまい、
 * CaptureFrameProvider が undefined になる・useCurrentFrame 等が「real remotion の
 * コンポジション外」で throw する、という形で壊れる。
 *
 * そこで本ファイルは captureRuntime バレルを**相対 import**に変える。Node ではそのまま
 * captureRuntime を指すため何も特別なことをせず正しく解決する。ブラウザ向けバンドル
 * （bundleCapture.ts の bundleCaptureEntry）は esbuild の onResolve プラグインで
 * この相対 import を external 'remotion' へ書き戻し、importmap 経由で
 * captureRuntime バレルと**同一インスタンス**を共有する、という従来のブラウザ挙動を保つ
 * （bundleCapture.test.ts の「'remotion' 非混入」pin と captureSmoke e2e が無変更で
 * 通ることが、ブラウザ側の挙動が変わっていないことの存在検査）。
 *
 * M2c T3: interpolate/spring を追加公開する（CaptureTitleLayer が preview/TitleLayer.tsx の
 * TitleClip と同じ数式を再現するために要る。captureRuntime.interpolate/spring は
 * numericParity.test.ts で real remotion との数値一致を pin 済み）。
 */
import * as captureRuntime from '../captureRuntime';

export const CaptureFrameProvider = captureRuntime.CaptureFrameProvider;
export const setStaticFileResolver = captureRuntime.setStaticFileResolver;
export const AbsoluteFill = captureRuntime.AbsoluteFill;
export const Sequence = captureRuntime.Sequence;
export const useCurrentFrame = captureRuntime.useCurrentFrame;
export const useVideoConfig = captureRuntime.useVideoConfig;
export const interpolate = captureRuntime.interpolate;
export const spring = captureRuntime.spring;
