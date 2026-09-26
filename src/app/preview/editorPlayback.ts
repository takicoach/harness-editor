/** The editing UI depends on this application-owned transport contract. The
 * implementation may change without changing timeline/source-time coordinates. */
export interface EditorPlaybackPayloads {
  frameupdate: { frame: number };
  play: undefined;
  pause: undefined;
  ended: undefined;
}
export type EditorPlaybackEvent = keyof EditorPlaybackPayloads;
export type EditorPlaybackListener<K extends EditorPlaybackEvent> = (event: { detail: EditorPlaybackPayloads[K] }) => void;
export interface EditorPlaybackRef {
  getCurrentFrame(): number;
  seekTo(frame: number): void;
  /** Relative input accumulates against the pending request, not old pixels. */
  seekBy?(delta: number): void;
  setPlaybackRate?(rate: number): void;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  /** A requested play is preparing resources or restoring the edited revision. */
  isPlaybackPending?(): boolean;
  addEventListener<K extends EditorPlaybackEvent>(type: K, listener: EditorPlaybackListener<K>): void;
  removeEventListener<K extends EditorPlaybackEvent>(type: K, listener: EditorPlaybackListener<K>): void;
}
/** pause must cancel pending play as well as active playback. An unpainted
 * renderer returns undefined from frame; duration is an exclusive upper bound.
 * A seek promise settles once that request is rendered or discarded. A void
 * target confirms through frameRendered instead. Only the latest live draw may
 * publish frameRendered: another confirmed frame supersedes a pending seek.
 * Request-specific errors must throw/reject from seek. A target that can discard
 * a seek asynchronously must return a promise, including for cancellation. */
export interface EditorPlaybackTarget { frame(): number | undefined; durationFrames?(): number; seek(frame: number): void | Promise<void>; setPlaybackRate?(rate:number):void | Promise<void>; isPlaybackPending?():boolean; play(): void | Promise<void>; pause(): void }
export interface EditorPlaybackConnection {
  frameRendered(frame: number): void;
  playbackChanged(playing: boolean): void;
  ended(): void;
  /** Playback failure, not cancellation of an unidentified seek request. */
  failed(error: unknown): void;
  disconnect(): void;
}

/** Stable subscriptions outlive a replaced renderer. Only its current connection
 * may publish confirmed frames/playback; a requested seek is not a rendered frame. */
export class EditorPlaybackController implements EditorPlaybackRef {
  private target: EditorPlaybackTarget | null = null;
  private owner: object | null = null;
  private frame = 0;
  private requestedFrame: number | null = null;
  private seekVersion = 0;
  private playing = false;
  private frameVersion = 0;
  private playbackVersion = 0;
  private listeners: { [K in EditorPlaybackEvent]: Set<EditorPlaybackListener<K>> } = {
    frameupdate: new Set(), play: new Set(), pause: new Set(), ended: new Set(),
  };
  constructor(private readonly onError: (error: unknown) => void) {}
  private report(error: unknown): void { try { this.onError(error); } catch { /* A host reporter must not stop other subscribers or the renderer. */ } }
  getCurrentFrame(): number { return this.frame; }
  isPlaying(): boolean { return this.playing; }
  isPlaybackPending(): boolean { return this.target?.isPlaybackPending?.() ?? false; }
  addEventListener<K extends EditorPlaybackEvent>(type: K, listener: EditorPlaybackListener<K>): void { this.listeners[type].add(listener); }
  removeEventListener<K extends EditorPlaybackEvent>(type: K, listener: EditorPlaybackListener<K>): void { this.listeners[type].delete(listener); }
  private emit<K extends EditorPlaybackEvent>(type: K, event: { detail: EditorPlaybackPayloads[K] }, current: () => boolean): void {
    const owner = this.owner;
    for (const listener of [...this.listeners[type]]) {
      if (this.owner !== owner || !current()) break;
      if (this.listeners[type].has(listener)) { try { listener(event); } catch (error) { this.report(error); } }
    }
  }
  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    const version = ++this.playbackVersion;
    this.playing = playing; this.emit(playing ? 'play' : 'pause', { detail: undefined }, () => this.playbackVersion === version);
  }
  seekTo(frame: number): void {
    if (!Number.isFinite(frame)) throw new Error('再生位置が不正です');
    const target = this.target, owner = this.owner; if (!target) return;
    const operation = ++this.seekVersion;
    try {
      const duration = target.durationFrames?.() ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(duration) || duration < 0) throw new Error('再生時間が不正です');
      this.requestedFrame = Math.max(0, Math.min(Math.max(0, duration - 1), Math.round(frame)));
      const requested = this.requestedFrame;
      const completion = target.seek(requested);
      if (completion) void Promise.resolve(completion).then(() => {
        if (this.owner === owner && this.seekVersion === operation) this.requestedFrame = null;
      }, error => {
        if (this.owner === owner && this.seekVersion === operation) { this.requestedFrame = null; this.report(error); }
      });
    } catch (error) { if (this.owner === owner && this.seekVersion === operation) { this.requestedFrame = null; this.report(error); } }
  }
  seekBy(delta: number): void {
    if (!Number.isFinite(delta)) throw new Error('移動量が不正です');
    this.seekTo((this.requestedFrame ?? this.frame) + delta);
  }
  play(): void {
    const target = this.target, owner = this.owner; if (!target) return;
    try { void Promise.resolve(target.play()).catch(error => { if (this.owner === owner) this.report(error); }); }
    catch (error) { if (this.owner === owner) this.report(error); }
  }
  setPlaybackRate(rate:number):void {
    const owner=this.owner,target=this.target;
    if(!target?.setPlaybackRate)return;
    try { void Promise.resolve(target.setPlaybackRate(rate)).catch(error=>{if(this.owner===owner)this.report(error);}); }
    catch(error){if(this.owner===owner)this.report(error);}
  }
  pause(): void { const owner = this.owner; try { this.target?.pause(); } catch (error) { if (this.owner === owner) this.report(error); } if (this.owner === owner) this.setPlaying(false); }
  /** preservePlayback transfers notifications for the same physical transport.
   * The caller must establish unchanged audio and retain the old connection
   * until this atomic replacement. Normal attachment/disconnection always stops. */
  connect(target: EditorPlaybackTarget, options?: {preservePlayback?:boolean}): EditorPlaybackConnection {
    const initial = target.frame();
    if (initial !== undefined && (!Number.isSafeInteger(initial) || initial < 0)) throw new Error('描画済みの再生位置が不正です');
    const previous = this.target, preserve = options?.preservePlayback === true && previous !== null;
    const owner = {}; this.owner = owner; this.target = target;
    this.requestedFrame = null;
    const current = () => this.owner === owner;
    if (!preserve) try { previous?.pause(); } catch (error) { if (current()) this.report(error); }
    if (!preserve && current()) {
      try { target.pause(); } catch (error) { if (current()) { this.target = null; this.owner = null; this.setPlaying(false); if (this.owner === null) this.report(error); } }
      if (current()) this.setPlaying(false);
    }
    const frameRendered = (frame: number) => {
      if (!current()) return;
      if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('描画済みの再生位置が不正です');
      const version = ++this.frameVersion;
      this.requestedFrame = null;
      this.frame = frame; this.emit('frameupdate', { detail: { frame } }, () => this.frameVersion === version);
    };
    if (current() && initial !== undefined) frameRendered(initial);
    return {
      frameRendered,
      playbackChanged: playing => { if (current()) { if (playing) this.requestedFrame = null; this.setPlaying(playing); } },
      ended: () => {
        if (!current() || !this.playing) return;
        const version = this.playbackVersion + (this.playing ? 1 : 0);
        this.setPlaying(false);
        if (current() && this.playbackVersion === version) {
          this.emit('ended', { detail: undefined }, () => this.playbackVersion === version);
        }
      },
      // Native failure publishes pause first; its subscribers may already have
      // issued a newer seek. Only that seek's own completion may discard it.
      failed: error => { if (current()) { this.setPlaying(false); if (current()) this.report(error); } },
      disconnect: () => { if (current()) { this.owner = null; this.target = null; this.requestedFrame = null; try { target.pause(); } catch (error) { this.report(error); } if (this.owner === null) this.setPlaying(false); } },
    };
  }
}
