/**
 * captureRuntime バレル（M2a 最終修正 I-1）。
 *
 * AUDITED_API の9シンボル（useCurrentFrame/useVideoConfig/interpolate/spring/Easing/
 * Sequence/AbsoluteFill/staticFile/Img）+ CaptureFrameProvider（Provider・監査対象外）+
 * setStaticFileResolver（設定関数・監査対象外）を再エクスポートする。
 *
 * 撮影ページはこのバレルのバンドルを remotion の importmap 先に使い、
 * native preview / swatch は @harness/frame-runtime として同じ独自APIを使う。
 * animationSpike.test.tsx の CAPTURE_SHIM もここから組み立てる（I-1）。
 */
export {
  AbsoluteFill,
  CaptureFrameProvider,
  Img,
  Sequence,
  setStaticFileResolver,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from './components';
export { Easing } from './easing';
export { interpolate } from './interpolate';
export { spring } from './spring';
