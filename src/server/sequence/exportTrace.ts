import type { ExportParallel, ExportRenderStats } from './exportParallel';
/** Measurement hook for export-speed comparisons (scripts/export-baseline.ts).
 * Unset in the product: the runner then records nothing and writes nothing.
 * Process-wide (globalThis) rather than module-wide, like processRegistry: the dev
 * server bundles its own copy of these modules apart from a measuring script's. */
export interface ExportTraceFrame {
  frame: number;
  /** The exact intermediate frame passed to the encoder, and its format (exportRunner.captureFrameFormat). */
  image: Buffer; format: 'jpeg' | 'png';
  /** harnessNativeFrame (including /export/asset reads and decoding). */
  drawMs: number;
  /** Compositor wait and screenshot. */
  captureMs: number;
  /** captureMs split: the compositor wait (two animation frames) and the CDP screenshot with its base64 decode. */
  rafMs?: number; shotMs?: number;
  /** drawMs split by the drawing page (sceneRenderer lastDrawTiming): decodeMs, composeMs, reactMs, assetsMs, measureMs. */
  phases?: Record<string, number> | null;
  /** Writing the frame to FFmpeg's stdin. */
  encodeMs: number;
  /** The drawing worker (exportParallel.ts; 0 with one worker). */
  worker: number;
  /** The source sample each video layer used (NativeFrameSample[] of the drawing page). */
  samples?: unknown;
}
export interface ExportTraceSink {
  frame?(frame: ExportTraceFrame): void;
  /** Overrides the export's per-source retention (EXPORT_RETAIN_FRAMES) to compare values; 0 = byte budget only, no release. */
  retainFrames?: number;
  /** Called once after the last frame, before encoding finishes. decode: the drawing page's decoder counters,
   * an array per worker when more than one worker drew. stats: queue and manager waits, block starts. */
  rendered?(summary: { jobId: string; decode: unknown; parallel: ExportParallel; stats: ExportRenderStats }): void;
}
const key = Symbol.for('harness-editor.exportTrace');
export function exportTraceSink(): ExportTraceSink | undefined {
  return (globalThis as unknown as Record<symbol, ExportTraceSink | undefined>)[key];
}
export function setExportTraceSink(sink: ExportTraceSink | undefined): void {
  const scope = globalThis as unknown as Record<symbol, ExportTraceSink | undefined>;
  if (sink) scope[key] = sink; else delete scope[key];
}
