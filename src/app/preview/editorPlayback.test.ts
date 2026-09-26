import { describe, expect, it, vi } from 'vitest';
import { EditorPlaybackController, type EditorPlaybackConnection, type EditorPlaybackTarget } from './editorPlayback';

const target = (frame = 0): EditorPlaybackTarget => ({ frame: () => frame, seek: vi.fn(), play: vi.fn(), pause: vi.fn() });
describe('editor-owned playback connection', () => {
  it('can replace only the callback owner while the same audio transport continues',()=>{
    const controller=new EditorPlaybackController(vi.fn()),first=target(10),next=target(11),paused=vi.fn();
    const previous=controller.connect(first);previous.playbackChanged(true);controller.addEventListener('pause',paused);
    vi.mocked(first.pause).mockClear();
    const current=controller.connect(next,{preservePlayback:true});
    expect(first.pause).not.toHaveBeenCalled();expect(next.pause).not.toHaveBeenCalled();
    expect(controller.isPlaying()).toBe(true);expect(paused).not.toHaveBeenCalled();
    previous.playbackChanged(false);previous.frameRendered(1);previous.disconnect();
    expect(controller.isPlaying()).toBe(true);expect(controller.getCurrentFrame()).toBe(11);
    current.disconnect();expect(next.pause).toHaveBeenCalledTimes(1);expect(controller.isPlaying()).toBe(false);
  });
  it('requires a live previous target before preserving playback',()=>{
    const controller=new EditorPlaybackController(vi.fn()),renderer=target(0);
    controller.connect(renderer,{preservePlayback:true});
    expect(renderer.pause).toHaveBeenCalledTimes(1);expect(controller.isPlaying()).toBe(false);
  });
  it('ignores an old asynchronous seek failure even when a newer request repeats the same frame', async () => {
    const error=vi.fn(),controller=new EditorPlaybackController(error),renderer=target(0);
    let reject!: (error:Error)=>void;
    renderer.seek=vi.fn().mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
    controller.connect(renderer);controller.seekTo(5);controller.seekTo(5);
    reject(new Error('obsolete seek'));await Promise.resolve();expect(error).not.toHaveBeenCalled();
    controller.seekBy(1);expect(renderer.seek).toHaveBeenLastCalledWith(6);
  });
  it('rejects invalid initial frames without retiring the current owner and stops a newly attached target', () => {
    const controller = new EditorPlaybackController(vi.fn()), original = target(5), next = target(7);
    const port = controller.connect(original);
    expect(() => controller.connect(target(NaN))).toThrow('描画済み');
    port.frameRendered(6); expect(controller.getCurrentFrame()).toBe(6);
    controller.connect(next); expect(next.pause).toHaveBeenCalledOnce(); expect(controller.isPlaying()).toBe(false);
  });
  it('isolates subscriber and reporter exceptions, handles seek failure, and ignores ended while stopped', () => {
    const error=vi.fn(()=>{throw new Error('reporter');}),controller=new EditorPlaybackController(error),renderer=target(),later=vi.fn(),ended=vi.fn();
    const port=controller.connect(renderer);
    controller.addEventListener('frameupdate',()=>{throw new Error('subscriber');});controller.addEventListener('frameupdate',later);
    expect(()=>port.frameRendered(1)).not.toThrow();expect(later).toHaveBeenCalledOnce();
    renderer.seek=()=>{throw new Error('seek');};expect(()=>controller.seekTo(3)).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({message:'seek'}));
    controller.addEventListener('ended',ended);port.ended();expect(ended).not.toHaveBeenCalled();
  });
  it('does not attach an initially unpausable target or invent its initial frame', () => {
    const error=vi.fn(),controller=new EditorPlaybackController(error),renderer=target(10),frame=vi.fn();
    renderer.pause=()=>{throw new Error('cannot stop');};controller.addEventListener('frameupdate',frame);
    const port=controller.connect(renderer);port.playbackChanged(true);controller.play();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({message:'cannot stop'}));expect(frame).not.toHaveBeenCalled();
    expect(renderer.play).not.toHaveBeenCalled();expect(controller.isPlaying()).toBe(false);
  });
  it('accumulates relative requests before any frame is rendered and clamps to duration', () => {
    const controller = new EditorPlaybackController(vi.fn()), renderer = {...target(10), durationFrames: () => 14};
    const port = controller.connect(renderer), frames: number[] = [];
    controller.addEventListener('frameupdate', event => frames.push(event.detail.frame));
    for (let i=0;i<5;i++) controller.seekBy(1);
    expect(vi.mocked(renderer.seek).mock.calls.map(call => call[0])).toEqual([11,12,13,13,13]);
    expect(controller.getCurrentFrame()).toBe(10); expect(frames).toEqual([]);
    port.frameRendered(13); expect(frames).toEqual([13]);
    controller.seekBy(-100); expect(renderer.seek).toHaveBeenLastCalledWith(0);
  });
  it('does not deliver an obsolete frame after a subscriber replaces the renderer', () => {
    const controller = new EditorPlaybackController(vi.fn()), frames: number[] = [];
    controller.addEventListener('frameupdate', event => {
      if (event.detail.frame === 10) controller.connect(target(200));
    });
    controller.addEventListener('frameupdate', event => frames.push(event.detail.frame));
    controller.connect(target(10));
    expect(frames).toEqual([200]); expect(controller.getCurrentFrame()).toBe(200);
  });
  it('stops a play notification superseded by a subscriber pause', () => {
    const controller = new EditorPlaybackController(vi.fn()), events: string[] = [];
    const port = controller.connect(target());
    controller.addEventListener('play', () => controller.pause());
    controller.addEventListener('play', () => events.push('play'));
    controller.addEventListener('pause', () => events.push('pause'));
    port.playbackChanged(true);
    expect(events).toEqual(['pause']); expect(controller.isPlaying()).toBe(false);
  });
  it('does not announce ended after a pause subscriber restarts the same renderer', () => {
    const controller = new EditorPlaybackController(vi.fn()), ended = vi.fn();
    const port = controller.connect(target()); port.playbackChanged(true);
    controller.addEventListener('pause', () => port.playbackChanged(true));
    controller.addEventListener('ended', ended);
    port.ended(); expect(controller.isPlaying()).toBe(true); expect(ended).not.toHaveBeenCalled();
  });
  it('publishes confirmed frames only and keeps subscriptions across renderer replacement', () => {
    const controller = new EditorPlaybackController(vi.fn()), a = target(10), b = target(30), frames: number[] = [];
    controller.addEventListener('frameupdate', event => frames.push(event.detail.frame));
    const first = controller.connect(a); controller.seekTo(19.7);
    expect(a.seek).toHaveBeenCalledWith(20); expect(controller.getCurrentFrame()).toBe(10); expect(frames).toEqual([10]);
    first.frameRendered(20); expect(controller.getCurrentFrame()).toBe(20);
    const second = controller.connect(b); first.frameRendered(999); first.playbackChanged(true); first.ended(); first.disconnect();
    expect(controller.getCurrentFrame()).toBe(30); expect(controller.isPlaying()).toBe(false);
    second.frameRendered(31); expect(frames).toEqual([10, 20, 30, 31]);
    expect(() => second.frameRendered(NaN)).toThrow(); expect(controller.getCurrentFrame()).toBe(31);
  });
  it('announces actual playback and end state without treating async play completion as playback', async () => {
    const controller = new EditorPlaybackController(vi.fn()), events: string[] = [];
    const port = controller.connect(target());
    controller.addEventListener('play', () => events.push('play'));
    controller.addEventListener('pause', () => events.push('pause'));
    controller.addEventListener('ended', () => { expect(controller.isPlaying()).toBe(false); events.push('ended'); });
    controller.play(); await Promise.resolve(); expect(controller.isPlaying()).toBe(false);
    port.playbackChanged(true); port.playbackChanged(true); expect(events).toEqual(['play']);
    port.ended(); expect(events).toEqual(['play', 'pause', 'ended']);
    port.playbackChanged(true); controller.pause(); expect(controller.isPlaying()).toBe(false);
    expect(events).toEqual(['play', 'pause', 'ended', 'play', 'pause']);
  });
  it('ignores a retired play rejection but reports failure from the active renderer', async () => {
    const error = vi.fn(), controller = new EditorPlaybackController(error);
    let reject!: (reason: Error) => void;
    const a = target(), b = target(); a.play = () => new Promise((_resolve, fail) => { reject = fail; });
    controller.connect(a); controller.play(); controller.connect(b); reject(new Error('old'));
    await Promise.resolve(); expect(error).not.toHaveBeenCalled();
    b.play = () => Promise.reject(new Error('current')); controller.play(); await Promise.resolve();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'current' }));
  });
  it('does not overwrite a newer connection created while the previous renderer pauses', () => {
    const controller = new EditorPlaybackController(vi.fn()), a = target(1), b = target(2), c = target(3);
    let latest!: EditorPlaybackConnection;
    controller.connect(a); a.pause = () => { latest = controller.connect(c); latest.playbackChanged(true); };
    const superseded = controller.connect(b);
    superseded.frameRendered(90); superseded.disconnect(); controller.play();
    expect(controller.getCurrentFrame()).toBe(3); expect(controller.isPlaying()).toBe(true); expect(c.play).toHaveBeenCalledOnce(); expect(b.play).not.toHaveBeenCalled();
  });
  it('pause/disconnect cannot reset playback started by a newer owner during a callback', () => {
    const controller = new EditorPlaybackController(vi.fn()), a = target(), b = target();
    const old = controller.connect(a);
    a.pause = () => { a.pause = vi.fn(); const next = controller.connect(b); next.playbackChanged(true); };
    controller.pause(); expect(controller.isPlaying()).toBe(true);
    old.disconnect(); expect(controller.isPlaying()).toBe(true);
    const c = target(), d = target(), active = controller.connect(c);
    c.pause = () => { const next = controller.connect(d); next.playbackChanged(true); };
    active.disconnect(); expect(controller.isPlaying()).toBe(true);
  });
});


it('keeps a replacement playing when a failed connection reporter reconnects synchronously', () => {
  const next = target(22);
  const controller = new EditorPlaybackController(() => controller.connect(next).playbackChanged(true));
  const broken = target(3); broken.pause = () => { throw new Error('pause failed'); };
  controller.connect(broken);
  expect(controller.getCurrentFrame()).toBe(22);
  expect(controller.isPlaying()).toBe(true);
});

it('keeps a reentrant seek request when the outer seek throws synchronously', () => {
  const error = vi.fn(), controller = new EditorPlaybackController(error), renderer = target();
  renderer.seek = vi.fn(frame => { if (frame === 3) { controller.seekTo(20); throw new Error('old seek'); } });
  controller.connect(renderer); controller.seekTo(3); controller.seekBy(1);
  expect(renderer.seek).toHaveBeenLastCalledWith(21);
  expect(error).not.toHaveBeenCalled();
});

it('retires a superseded seek when playback confirms a different frame', () => {
  const controller = new EditorPlaybackController(vi.fn()), renderer = target(13);
  const connection = controller.connect(renderer);
  controller.seekTo(12); controller.play(); connection.playbackChanged(true);
  connection.frameRendered(20); controller.pause(); controller.seekBy(1);
  expect(renderer.seek).toHaveBeenLastCalledWith(21);
});

it('retires an acknowledged no-op seek without publishing an invented frame', async () => {
  const controller = new EditorPlaybackController(vi.fn()), renderer = target(13), observed = vi.fn();
  renderer.seek = vi.fn(() => Promise.resolve());
  controller.connect(renderer); controller.addEventListener('frameupdate', observed);
  controller.seekTo(12); await Promise.resolve(); controller.seekBy(1);
  expect(renderer.seek).toHaveBeenLastCalledWith(14);
  expect(controller.getCurrentFrame()).toBe(13); expect(observed).not.toHaveBeenCalled();
});

it('does not let an old completion discard a newer pending relative request', async () => {
  const controller = new EditorPlaybackController(vi.fn()), renderer = target(13);
  let complete!: () => void;
  renderer.seek = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  controller.connect(renderer); controller.seekTo(12); controller.seekTo(20);
  complete(); await Promise.resolve(); controller.seekBy(1);
  expect(renderer.seek).toHaveBeenLastCalledWith(21);
});


it.each(['void', 'promise'] as const)('keeps a %s seek issued by a pause notification before the old failure arrives', kind => {
  const error = vi.fn(), controller = new EditorPlaybackController(error), renderer = target(13);
  if (kind === 'promise') renderer.seek = vi.fn(() => new Promise<void>(() => {}));
  const connection = controller.connect(renderer);
  connection.playbackChanged(true);
  controller.addEventListener('pause', () => controller.seekTo(20));
  // Native fail first publishes pause, then calls the facade failure callback.
  connection.playbackChanged(false);
  connection.failed(new Error('old playback draw'));
  controller.seekBy(1);
  expect(renderer.seek).toHaveBeenLastCalledWith(21);
  expect(error).toHaveBeenCalledOnce();
});

it('keeps a seek issued inside failed itself as the direct-call control', () => {
  const controller = new EditorPlaybackController(vi.fn()), renderer = target(13);
  const connection = controller.connect(renderer);
  connection.playbackChanged(true);
  controller.addEventListener('pause', () => controller.seekTo(20));
  connection.failed(new Error('direct failure'));
  controller.seekBy(1);
  expect(renderer.seek).toHaveBeenLastCalledWith(21);
});

it.each(['throw', 'reject'] as const)('retires the failed request through its own %s result', async kind => {
  const error = vi.fn(), controller = new EditorPlaybackController(error), renderer = target(13);
  renderer.seek = vi.fn().mockImplementationOnce(() => {
    if (kind === 'throw') throw new Error('this seek');
    return Promise.reject(new Error('this seek'));
  });
  controller.connect(renderer); controller.seekTo(20); await Promise.resolve(); controller.seekBy(1);
  expect(renderer.seek).toHaveBeenLastCalledWith(14);
  expect(error).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({message:'this seek'}));
});
