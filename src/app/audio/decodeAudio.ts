// 動画 URL から音声をデコードし、波形描画用のモノラル Float32 サンプルを得る。
// クライアント専用（Web Audio API を使う）。短尺前提のためメインスレッドで処理する。

let sharedCtx: AudioContext | null = null;

/** デコード用の AudioContext を遅延生成して共有する（webkit プレフィックスもフォールバック）。 */
function getAudioContext(): AudioContext {
  if (sharedCtx !== null) return sharedCtx;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (Ctor === undefined) throw new Error('AudioContext is unavailable');
  sharedCtx = new Ctor();
  return sharedCtx;
}

/** AudioBuffer を全チャンネル平均のモノラル Float32 サンプル列へ縮約する。 */
function audioBufferToMono(audio: AudioBuffer): Float32Array {
  const channels = audio.numberOfChannels;
  const length = audio.length;
  const mono = new Float32Array(length);
  if (channels === 0) return mono;
  // 全チャンネルを加算してから 1 回だけ割る（チャンネルごとの除算による丸め誤差累積を避ける）。
  for (let ch = 0; ch < channels; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] = (mono[i] ?? 0) + (data[i] ?? 0);
    }
  }
  for (let i = 0; i < length; i++) {
    mono[i] = (mono[i] ?? 0) / channels;
  }
  return mono;
}

/**
 * url（= /api/video?…）の音声をデコードし、全チャンネルを平均したモノラル
 * Float32 サンプル列（原本サンプルレート）を返す。失敗時は例外を投げる。
 * キャッシュを通さない直接デコード。通常は loadWaveformSamples を使うこと。
 */
export async function decodeAudioToMono(url: string): Promise<Float32Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`video fetch failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const ctx = getAudioContext();
  const audio = await ctx.decodeAudioData(arrayBuffer);
  return audioBufferToMono(audio);
}

// URL ごとにデコード済みサンプルをキャッシュし、同一 URL の重複デコードを防ぐ。
// キャッシュはタブ生存中・上限なし（短尺前提）。多プロジェクトで肥大化が問題になれば LRU/WeakRef へ。
const sampleCache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();

/**
 * url のモノラルサンプルを取得する。キャッシュ済みなら即返し、
 * 進行中のデコードがあればそれを共有する（in-flight 重複排除）。
 */
export function loadWaveformSamples(url: string): Promise<Float32Array> {
  const cached = sampleCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = inflight.get(url);
  if (existing !== undefined) return existing;
  const p = decodeAudioToMono(url)
    .then((samples) => {
      sampleCache.set(url, samples);
      inflight.delete(url);
      return samples;
    })
    .catch((err) => {
      inflight.delete(url);
      throw err;
    });
  inflight.set(url, p);
  return p;
}

/** モノラルサンプル ＋ 長さ（秒）。SE のクリップ幅算出に長さを使う。 */
export interface AudioClip {
  samples: Float32Array;
  durationSec: number;
}

// 音源クリップ（samples＋長さ）の URL キャッシュ。波形サンプルとは別キャッシュ。
const clipCache = new Map<string, AudioClip>();
const clipInflight = new Map<string, Promise<AudioClip>>();

async function decodeAudioClip(url: string): Promise<AudioClip> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset fetch failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const ctx = getAudioContext();
  const audio = await ctx.decodeAudioData(arrayBuffer);
  return { samples: audioBufferToMono(audio), durationSec: audio.duration };
}

/**
 * url の音源を {samples, durationSec} としてロードする。キャッシュ済みなら即返し、
 * 進行中があれば共有する（loadWaveformSamples と同じ in-flight 重複排除）。
 */
export function loadAudioClip(url: string): Promise<AudioClip> {
  const cached = clipCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = clipInflight.get(url);
  if (existing !== undefined) return existing;
  const p = decodeAudioClip(url)
    .then((clip) => {
      clipCache.set(url, clip);
      clipInflight.delete(url);
      return clip;
    })
    .catch((err) => {
      clipInflight.delete(url);
      throw err;
    });
  clipInflight.set(url, p);
  return p;
}
