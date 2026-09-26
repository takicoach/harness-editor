/** @vitest-environment jsdom */
import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {renderHook,act} from '@testing-library/react';
import {useAssetAudition} from './useAssetAudition';
import {normalizedVolumeFromSamples} from '../audio/loudness';

vi.mock('../audio/loudness',()=>({normalizedVolumeFromSamples:vi.fn(()=>0.5)}));

const flush=async()=>{await act(async()=>{await Promise.resolve();await Promise.resolve();});};

beforeEach(()=>{
  HTMLMediaElement.prototype.play=vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause=vi.fn();
});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});

describe('useAssetAudition',()=>{
  it('再生を開始すると playingId が立つ',async()=>{
    const {result}=renderHook(()=>useAssetAudition());
    await act(async()=>result.current.toggle('a1','/asset/a1'));
    expect(result.current.playingId).toBe('a1');
  });
  it('同じ素材をもう一度押すと止まる',async()=>{
    const {result}=renderHook(()=>useAssetAudition());
    await act(async()=>result.current.toggle('a1','/asset/a1'));
    await act(async()=>result.current.toggle('a1','/asset/a1'));
    expect(result.current.playingId).toBeNull();
  });
  it('別の素材を押すと前を止めてから鳴らす（同時に 1 つ）',async()=>{
    const {result}=renderHook(()=>useAssetAudition());
    await act(async()=>result.current.toggle('a1','/asset/a1'));
    await act(async()=>result.current.toggle('a2','/asset/a2'));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(result.current.playingId).toBe('a2');
  });
  it('アンマウントで止まる',async()=>{
    const {result,unmount}=renderHook(()=>useAssetAudition());
    await act(async()=>result.current.toggle('a1','/asset/a1'));
    unmount();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
  // M-c: 上限（24MB）を超える素材は全体をデコードしない代わりに、読み切らない response.body を明示的に閉じる。
  it('上限を超える素材は response.body を閉じて解析を諦める',async()=>{
    const cancel=vi.fn();
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>String(30*1024*1024)},body:{cancel},arrayBuffer:async()=>new ArrayBuffer(0)})));
    vi.stubGlobal('AudioContext',vi.fn(()=>({decodeAudioData:vi.fn(),close:vi.fn()})));
    const {result}=renderHook(()=>useAssetAudition());
    await act(async()=>result.current.toggle('big','/asset/big'));
    await flush();
    expect(cancel).toHaveBeenCalled();
    expect(normalizedVolumeFromSamples).not.toHaveBeenCalled();
  });
  // M-d: 正規化は素材の種類（BGM か SE/その他）で出し分ける。呼び出し元が渡した kind がそのまま解析へ渡ること。
  it('渡された種類（bgm/se）で音量を正規化する',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>'4'},body:{cancel:vi.fn()},arrayBuffer:async()=>new ArrayBuffer(4)})));
    const channel=new Float32Array([0.1]);
    vi.stubGlobal('AudioContext',vi.fn(()=>({decodeAudioData:vi.fn(async()=>({getChannelData:()=>channel})),close:vi.fn()})));
    const {result}=renderHook(()=>useAssetAudition());
    // 'se' を渡す（常に 'bgm' 固定だった旧実装ならここで 'bgm' が渡ってしまい落ちる）。
    await act(async()=>result.current.toggle('se1','/asset/se1','se'));
    await flush();
    expect(normalizedVolumeFromSamples).toHaveBeenCalledWith(channel,'se');
  });
});
