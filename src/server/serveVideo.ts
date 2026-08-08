import { createReadStream, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

export interface RangeSpec {
  start: number;
  end: number;
}

/**
 * HTTP Range ヘッダを解釈する。単一範囲のみ対応（動画ストリーミングはこれで足りる）。
 * 解釈不能・無効な範囲は null（呼び出し側は全体を返す or 416 を判断）。
 */
export function parseRange(header: string | undefined, size: number): RangeSpec | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startStr = match[1] ?? '';
  const endStr = match[2] ?? '';

  let start: number;
  let end: number;
  if (startStr === '') {
    // サフィックス: 末尾 N バイト
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  if (end > size - 1) end = size - 1;
  return { start, end };
}

/** 動画ファイルを Range 対応で配信する。 */
export function serveVideo(
  res: ServerResponse,
  filePath: string,
  rangeHeader: string | undefined,
): void {
  const size = statSync(filePath).size;
  const range = parseRange(rangeHeader, size);
  const stream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);
  // 読み取り中の OS エラー（ファイル削除・ディスク障害等）で未捕捉例外を出して
  // 開発サーバを落とさないよう、stream の error を必ず処理する。
  stream.on('error', (err) => {
    console.error('[sme] 動画ストリームのエラー:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  if (range) {
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range.end - range.start + 1),
      'Cache-Control': 'no-store',
    });
  } else {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    });
  }
  stream.pipe(res);
}
