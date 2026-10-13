import { createFile, type Movie, type MP4BoxBuffer, type Sample, type Track } from 'mp4box';
import { addTime, rational, subtractTime, type Rational } from '../../core/sequence/time';
import type { ByteSource, FrameIdentity } from './mp4FrameSource';
import { mp4Presentation } from './mp4Presentation';

/** The export decoder's MP4 timeline, without WebCodecs or Node APIs: the server's
 * filmstrip index must pick the same frame for a source time as the export does. */
export interface IndexedSample { sample: Sample; identity: FrameIdentity; timestamp: number }
export interface Mp4EditTimeline { mediaStart: Rational; leading: Rational; editDuration: Rational | undefined }

export async function readMp4Movie(bytes: ByteSource): Promise<{ file: ReturnType<typeof createFile>; movie: Movie }> {
  const file = createFile(false);
  let movie: Movie | undefined, error: string | undefined, offset = 0, metadataBytes = 0;
  file.onReady = info => { movie = info; };
  file.onError = (...args) => { error = args.map(String).join(': '); };
  while (!movie && !error && offset < bytes.size) {
    const end = Math.min(bytes.size, offset + 256 * 1024);
    const buffer = await bytes.read(offset, end) as MP4BoxBuffer;
    buffer.fileStart = offset;
    metadataBytes += buffer.byteLength;
    if (metadataBytes > 32 * 1024 * 1024) throw new Error('映像の索引が大きすぎます。編集用プロキシを作成してください');
    const next = file.appendBuffer(buffer, end === bytes.size);
    offset = Math.max(end, next);
  }
  if (error || !movie) throw new Error(`MP4の索引を読み取れません: ${error ?? 'moovがありません'}`);
  const info = movie as Movie;
  if (info.isFragmented) throw new Error('分割MP4は編集用プロキシへ変換してください');
  return { file, movie: info };
}

export function mp4EditTimeline(track: Pick<Track, 'edits' | 'timescale' | 'movie_timescale'>): Mp4EditTimeline {
  let mediaStart = rational(0), leading = rational(0), editDuration: Rational | undefined;
  if (track.edits?.length) {
    let active = false;
    for (const edit of track.edits) {
      if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0) throw new Error('速度付きMP4編集リストはプロキシへ変換してください');
      if (edit.media_time === -1 && !active) leading = addTime(leading, rational(edit.segment_duration, track.movie_timescale));
      else if (!active && edit.media_time >= 0) {
        mediaStart = rational(edit.media_time, track.timescale);
        editDuration = rational(edit.segment_duration, track.movie_timescale); active = true;
      }
      else throw new Error('複雑なMP4編集リストはプロキシへ変換してください');
    }
    if (!active) throw new Error('表示区間のないMP4編集リストはプロキシへ変換してください');
  }
  return { mediaStart, leading, editDuration };
}

/** Source time of a sample = its CTS − the edit's media time + the leading empty edit. */
export function mp4SampleTimeline(sampleInfo: readonly Sample[], { mediaStart, leading, editDuration }: Mp4EditTimeline, byteSize: number): { samples: IndexedSample[]; presentation: FrameIdentity[] } {
  const samples = sampleInfo.map((sample, index) => {
    if (![sample.cts, sample.duration, sample.offset, sample.size, sample.timescale].every(Number.isSafeInteger)
      || sample.duration <= 0 || sample.timescale <= 0 || sample.offset < 0 || sample.size <= 0 || sample.offset + sample.size > byteSize) {
      throw new Error('映像フレームの索引が不正です');
    }
    return { sample, timestamp: Math.round(sample.cts / sample.timescale * 1e6),
      identity: { sample: index, pts: addTime(subtractTime(rational(sample.cts, sample.timescale), mediaStart), leading), duration: rational(sample.duration, sample.timescale) } };
  });
  if (!samples.length || new Set(samples.map(s => s.timestamp)).size !== samples.length) throw new Error('映像フレームの時刻を一意に識別できません');
  const presentation = mp4Presentation(samples.map(s => s.identity), leading, editDuration);
  if (!presentation.length) throw new Error('映像の表示区間がありません');
  return { samples, presentation };
}
