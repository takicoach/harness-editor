/** The canvas engine's half inside the export drawing page (renderPage.ts installs it when the URL has canvas=1;
 * server/sequence/exportCanvas.ts drives it). Each frame is drawn by the page as for the screenshot path, copied
 * into a canvas by HTML in Canvas (Chrome 157: drawElementImage) and compressed there by one VideoEncoder for the
 * whole export, at a constant QP, as H.264 in Annex B. The encoded bytes go to Node in pieces (take) and on to FFmpeg. */

/** HTML in Canvas is not in TypeScript's DOM types yet. */
interface DrawableContext extends CanvasRenderingContext2D { drawElementImage?(element: Element, x: number, y: number): void }

/** exportCanvasSupport.canvasEncoderConfig plus the project rate and the key frame interval. */
export interface CanvasExportConfig {
  codec: string; width: number; height: number; framerate: number; bitrateMode: 'quantizer'; hardwareAcceleration: 'prefer-hardware';
  avc: { format: 'annexb' }; quantizer: number; fps: { num: number; den: number }; keyFrameInterval: number;
}
export interface HarnessCanvasExport {
  /** Build the canvas, check support, encode 2 frames with the same configuration and flush them, then make the
   * export's encoder. Rejects with the reason (Japanese) when this browser cannot. */
  start(config: CanvasExportConfig): Promise<{ codec: string; hardwareAcceleration: string }>;
  /** Draw frame n, copy it into the canvas and hand it to the encoder. An encoder error rejects here and every call after. */
  frame(n: number): Promise<void>;
  /** The encoded bytes output so far (Annex B, joined) as base64, emptying the store. Frames still inside the encoder come later. */
  take(): Promise<string>;
  /** Flush, return the rest as base64 and close the encoder. */
  finish(): Promise<string>;
  /** The canvas as it is now, as PNG (base64): the reference frames. */
  png(): Promise<string>;
}
declare global { interface Window { harnessCanvasExport?: HarnessCanvasExport } }

/** Waiting on the encoder (a free place in its queue, a flush) longer than this means it stopped working. */
const ENCODER_STALL_MS = 10_000;
/** Frames queued in the encoder before frame() waits for one to leave (as in the measured spike). */
const ENCODE_QUEUE = 2;

const twoAnimationFrames = () => new Promise<void>(resolve => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(String(reader.result).split(',')[1] ?? ''); };
    reader.onerror = () => { reject(reader.error ?? new Error('圧縮した映像を読み出せませんでした')); };
    reader.readAsDataURL(blob);
  });
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Session {
  canvas: HTMLCanvasElement; context: DrawableContext & { drawElementImage(element: Element, x: number, y: number): void }; wrapper: HTMLElement;
  encoder: VideoEncoder; config: CanvasExportConfig; chunks: Uint8Array<ArrayBuffer>[];
  /** The encoder's error, kept: every later call rejects with it. */
  failure?: Error;
  /** Rejecters of the waits in progress, called with the encoder's error. */
  waits: Set<(error: Error) => void>;
  finished: boolean;
}

/** Wait for `work` at most ENCODER_STALL_MS; an encoder error ends the wait at once. */
function bounded<T>(session: Session, work: Promise<T>, stalled: string): Promise<T> {
  if (session.failure) return Promise.reject(session.failure);
  return new Promise<T>((resolve, reject) => {
    const end = (settle: () => void) => { clearTimeout(timer); session.waits.delete(fail); settle(); };
    const fail = (error: Error) => { end(() => reject(error)); };
    const timer = setTimeout(() => { end(() => reject(new Error(stalled))); }, ENCODER_STALL_MS);
    session.waits.add(fail);
    work.then(value => { end(() => resolve(value)); }, error => { end(() => reject(session.failure ?? new Error(`映像の圧縮に失敗しました: ${message(error)}`))); });
  });
}

export function installCanvasExport(stage: HTMLElement): void {
  let session: Session | undefined;
  const current = (): Session => {
    if (!session) throw new Error('速い書き出しの圧縮器がまだ準備されていません');
    if (session.failure) throw session.failure;
    if (session.finished) throw new Error('速い書き出しの圧縮はすでに終わっています');
    return session;
  };
  window.harnessCanvasExport = {
    async start(config) {
      if (session) throw new Error('速い書き出しの圧縮器はすでに準備されています');
      const probe = document.createElement('canvas').getContext('2d') as DrawableContext | null;
      if (typeof probe?.drawElementImage !== 'function') throw new Error('この Chrome では速い書き出しを使えません（HTML in Canvas がありません）');
      if (typeof VideoEncoder === 'undefined') throw new Error('この Chrome では速い書き出しを使えません（VideoEncoder がありません）');
      // The QP goes with each frame (encode options), not in the VideoEncoder configuration.
      const { quantizer, fps, keyFrameInterval: _interval, ...encoderConfig } = config;
      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!support.supported) throw new Error(`この Mac の映像の圧縮器は ${config.codec}・${config.width}×${config.height}・画質一定に対応していません`);
      // The screenshot path's inner composition surface (exportRunner.openRenderSurface): backdrop-filter needs it.
      document.body.style.transform = 'translateZ(0)';
      // <canvas content="drawable"> with the stage inside a drawable child: drawElementImage copies that child.
      const canvas = document.createElement('canvas'), wrapper = document.createElement('div');
      canvas.width = config.width; canvas.height = config.height; canvas.setAttribute('content', 'drawable'); canvas.style.display = 'block';
      wrapper.setAttribute('drawable', ''); wrapper.style.cssText = `position:relative;width:${config.width}px;height:${config.height}px`;
      stage.before(canvas); wrapper.append(stage); canvas.append(wrapper);
      const context = canvas.getContext('2d') as DrawableContext | null;
      if (!context?.drawElementImage) throw new Error('この Chrome では速い書き出しを使えません（HTML in Canvas がありません）');
      const drawable = context as Session['context'];
      // A trial with the real configuration: an encoder that accepts the configuration may still fail on its first
      // frames (hardware busy or refusing the size). Fail here, before any frame is drawn, rather than mid-export.
      const trialChunks: number[] = [];
      let trialError: unknown;
      const trial = new VideoEncoder({ output: chunk => { trialChunks.push(chunk.byteLength); }, error: error => { trialError = error; } });
      try {
        trial.configure(encoderConfig);
        drawable.clearRect(0, 0, config.width, config.height);
        for (let n = 0; n < 2; n++) {
          const frame = new VideoFrame(canvas, { timestamp: Math.round(n * 1e6 * fps.den / fps.num), duration: Math.round(1e6 * fps.den / fps.num) });
          try { trial.encode(frame, { keyFrame: n === 0, avc: { quantizer } }); } finally { frame.close(); }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([trial.flush(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('2 コマが 10 秒以内に終わりませんでした')), ENCODER_STALL_MS); })]); }
        finally { clearTimeout(timer); }
        if (trialError) throw trialError;
        if (trialChunks.length !== 2) throw new Error(`2 コマのうち ${trialChunks.length} コマしか出てきませんでした`);
      } catch (error) { throw new Error(`映像の圧縮を試せませんでした: ${message(trialError ?? error)}`, { cause: trialError ?? error }); }
      finally { if (trial.state !== 'closed') trial.close(); }
      const made: Session = { canvas, context: drawable, wrapper, config, chunks: [], waits: new Set(), finished: false,
        encoder: new VideoEncoder({
          output: chunk => { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); made.chunks.push(bytes); },
          error: error => {
            made.failure ??= new Error(`映像の圧縮に失敗しました: ${message(error)}`, { cause: error });
            for (const fail of [...made.waits]) fail(made.failure);
          },
        }) };
      made.encoder.configure(encoderConfig);
      session = made;
      return { codec: support.config?.codec ?? config.codec, hardwareAcceleration: support.config?.hardwareAcceleration ?? config.hardwareAcceleration };
    },
    async frame(n) {
      const active = current(), { canvas, context, wrapper, encoder, config } = active;
      if (!window.harnessNativeFrame) throw new Error('書き出しの描画画面がコマを描けません');
      await window.harnessNativeFrame(n);
      // Let the compositor present the frame before copying it (the screenshot path waits the same two frames).
      await twoAnimationFrames();
      context.clearRect(0, 0, config.width, config.height);
      context.drawElementImage(wrapper, 0, 0);
      while (encoder.encodeQueueSize > ENCODE_QUEUE)
        await bounded(active, new Promise<void>(resolve => { encoder.addEventListener('dequeue', () => resolve(), { once: true }); }), `${n + 1} コマ目で映像の圧縮が ${ENCODER_STALL_MS / 1000} 秒以上進みません`);
      if (active.failure) throw active.failure;
      const frame = new VideoFrame(canvas, { timestamp: Math.round(n * 1e6 * config.fps.den / config.fps.num), duration: Math.round(1e6 * config.fps.den / config.fps.num) });
      try { encoder.encode(frame, { keyFrame: n % config.keyFrameInterval === 0, avc: { quantizer: config.quantizer } }); }
      finally { frame.close(); }
    },
    async take() {
      const active = current(), chunks = active.chunks;
      active.chunks = [];
      return base64(new Blob(chunks));
    },
    async finish() {
      const active = current();
      await bounded(active, active.encoder.flush(), `映像の圧縮の締めくくりが ${ENCODER_STALL_MS / 1000} 秒以内に終わりませんでした`);
      if (active.failure) throw active.failure;
      active.finished = true; active.encoder.close();
      const chunks = active.chunks; active.chunks = [];
      return base64(new Blob(chunks));
    },
    async png() {
      const { canvas } = current();
      return base64(await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => { if (blob) resolve(blob); else reject(new Error('確認用のコマを画像にできませんでした')); }, 'image/png');
      }));
    },
  };
}
