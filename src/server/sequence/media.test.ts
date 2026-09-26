import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, open, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSequenceAsset, managedAssetPath, prepareSequenceAudio, prepareSequenceSourceWindowAudio, run, publishSequenceAudio } from './media';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { rational } from '../../core/sequence/time';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-sequence-media-'));
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=30000/1001',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.001', '-c:v', 'libx264', '-g', '15', '-bf', '3', '-c:a', 'aac', '-movflags', '+faststart', join(directory, 'source.mp4')]);
}, 15000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function dominantFrequency(data: Buffer): number {
  const values = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const crossings: number[] = [];
  for (let frame = 1500; frame < values.length / 2 - 1500; frame++) {
    if (values[(frame - 1) * 2]! <= 0 && values[frame * 2]! > 0) crossings.push(frame);
  }
  return 48000 * (crossings.length - 1) / (crossings.at(-1)! - crossings[0]!);
}
describe('native source preparation', () => {
  it('retains exact NTSC stream metadata and stable content identities', async () => {
    const asset = await inspectSequenceAsset(directory, 'source.mp4', '映像');
    expect(asset.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(asset.streams.find(s => s.kind === 'video')).toMatchObject({ frameRate: rational(30000, 1001), duration: rational(1001, 1000), width: 128, height: 72 });
    expect((await inspectSequenceAsset(directory, 'source.mp4', '別名')).id).toBe(asset.id);
  });
  it('prepares reusable PCM and a pitch-preserving double-speed variant', async () => {
    const asset = await inspectSequenceAsset(directory, 'source.mp4', '映像');
    const audio = asset.streams.find(s => s.kind === 'audio')!;
    const normal = await prepareSequenceAudio(directory, asset, audio.index, rational(1));
    const fast = await prepareSequenceAudio(directory, asset, audio.index, rational(2));
    expect(normal.sampleRate).toBe(48000); expect(normal.channels).toBe(2);
    expect(normal.sampleCount).toBeGreaterThan(47000); expect(normal.sampleCount).toBeLessThan(50000);
    expect(fast.sampleCount / normal.sampleCount).toBeCloseTo(.5, 1);
    expect(dominantFrequency(await readFile(normal.file))).toBeCloseTo(440, 0);
    expect(dominantFrequency(await readFile(fast.file))).toBeCloseTo(440, 0);
    expect(await prepareSequenceAudio(directory, asset, audio.index, rational(1))).toEqual(normal);
  }, 15000);
  it('rejects traversal, external symlinks and invalid LUTs before registration', async () => {
    await expect(managedAssetPath(directory, '../outside.mp4')).rejects.toThrow(/保存先/);
    await symlink('/etc/hosts', join(directory, 'external'));
    await expect(managedAssetPath(directory, 'external')).rejects.toThrow(/プロジェクト外/);
    await writeFile(join(directory, 'invalid.cube'), 'LUT_3D_SIZE 2\n0 0 0');
    await expect(inspectSequenceAsset(directory, 'invalid.cube', '不正')).rejects.toThrow(/データ数/);
  });
  it('retains a short source at the combined 16× clip and 8× shuttle rate',async()=>{
    const asset=await inspectSequenceAsset(directory,'source.mp4','短い音声');
    const stream=asset.streams.find(s=>s.kind==='audio')!;
    const prepared=await prepareSequenceAudio(directory,asset,stream.index,rational(128));
    expect(prepared.sampleCount).toBeGreaterThan(0);
    expect(prepared.sampleCount).toBeLessThan(500);
    const bytes=await readFile(prepared.file),pcm=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    expect(pcm.some(value=>Math.abs(value)>.001)).toBe(true);
    expect(await prepareSequenceAudio(directory,asset,stream.index,rational(128))).toEqual(prepared);
    await expect(prepareSequenceAudio(directory,asset,stream.index,rational(129))).rejects.toThrow('0.01〜128');
  },15000);
  it('trims short 44.1 kHz shuttle PCM in the output sample rate',async()=>{
    const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw Error(ffmpeg.message);
    execFileSync(ffmpeg.bin,['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1','-c:a','pcm_s16le',join(directory,'short441.wav')]);
    const asset=await inspectSequenceAsset(directory,'short441.wav','44.1kHz'),stream=asset.streams.find(s=>s.kind==='audio')!;
    const prepared=await prepareSequenceAudio(directory,asset,stream.index,rational(128));
    expect(prepared.sampleCount).toBe(375);
  },15000);
});


describe('verified reference PCM',()=>{
  it.each(['whole','window'] as const)('matches managed PCM and rejects offline or changed cache hits (%s)',async kind=>{
    const project=await mkdtemp(join(directory,'reference-')),outside=await mkdtemp(join(directory,'external-'));
    const source=join(outside,'source.mp4');await copyFile(join(directory,'source.mp4'),source);await copyFile(source,join(project,'managed.mp4'));
    const {registerSequenceReference,reconnectSequenceReference}=await import('./references');
    const reference=await registerSequenceReference(project,source),managed=await inspectSequenceAsset(project,'managed.mp4','managed');
    const stream=reference.streams.find(s=>s.kind==='audio')!.index;
    const prepare=(asset:typeof reference,signal?:AbortSignal)=>kind==='whole'?prepareSequenceAudio(project,asset,stream,rational(1),signal):prepareSequenceSourceWindowAudio(project,asset,stream,rational(1),{version:'source-window-v1',start:rational(1,10),end:rational(1,2)},signal);
    const expected=await prepare(managed),actual=await prepare(reference);expect(await readFile(actual.file)).toEqual(await readFile(expected.file));
    const cached=await stat(actual.file);await rename(source,source+'.offline');await expect(prepare(reference)).rejects.toThrow();
    const next=join(outside,'replacement.mp4');await copyFile(source+'.offline',next);await reconnectSequenceReference(project,reference,next);
    const connected=await prepare(reference);expect(connected.file).toBe(actual.file);expect((await stat(connected.file)).mtimeMs).toBe(cached.mtimeMs);
    const bytes=await readFile(next);bytes[bytes.length-20]=bytes[bytes.length-20]!^1;await writeFile(next,bytes);await expect(prepare(reference)).rejects.toThrow();
    await expect(prepare(managed,AbortSignal.abort(Error('cancelled')))).rejects.toThrow('cancelled');
  });
  it('passes a pinned input FD even when its original pathname disappears',async()=>{
    const source=join(directory,'pinned.txt');await writeFile(source,'pinned bytes');const handle=await open(source,'r');
    try{await unlink(source);expect(await run(process.execPath,['-e',"process.stdout.write(require('fs').readFileSync(3,'utf8'))"],undefined,handle.fd)).toBe('pinned bytes');}
    finally{await handle.close();}
  });
  it('waits for child close after cancellation before releasing the input owner',async()=>{
    const ready=join(directory,'child-ready'),closed=join(directory,'child-closed'),controller=new AbortController();
    const task=run(process.execPath,['-e',`const fs=require('fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(closed)},'closed');process.exit(0)},80));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`],controller.signal);
    const rejected=expect(task).rejects.toThrow();await vi.waitFor(async()=>expect(await readFile(ready,'utf8')).toBe('ready'));
    controller.abort();await rejected;expect(await readFile(closed,'utf8')).toBe('closed');
  });
});

it('removes only owned published files when post-publication verification fails',async()=>{
 const temporary=join(directory,'publish.tmp'),destination=join(directory,'publish.pcm');await writeFile(temporary,'pcm');
 let count=0;await expect(publishSequenceAudio(temporary,destination,{test:1},async()=>{if(++count===2)throw Error('source changed');},new AbortController().signal)).rejects.toThrow('source changed');
 await expect(stat(destination)).rejects.toMatchObject({code:'ENOENT'});await expect(stat(destination+'.json')).rejects.toMatchObject({code:'ENOENT'});
 await writeFile(temporary,'pcm');count=0;
 await expect(publishSequenceAudio(temporary,destination,{test:1},async()=>{if(++count===2){await rename(destination,destination+'.old');await writeFile(destination,'other owner');throw Error('source changed');}},new AbortController().signal)).rejects.toThrow('source changed');
 expect(await readFile(destination,'utf8')).toBe('other owner');
});
