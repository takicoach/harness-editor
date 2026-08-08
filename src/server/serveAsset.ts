import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ServerResponse } from 'node:http';
import { parseRange } from './serveVideo';

/** 拡張子 → Content-Type のマップ。 */
const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
};

/** ファイルパスの拡張子から Content-Type を決める。未知は octet-stream。 */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** プロジェクトの public/ 配下のアセットを Range 対応で配信する（音声・画像兼用）。 */
export function serveAsset(
  res: ServerResponse,
  filePath: string,
  rangeHeader: string | undefined,
): void {
  const size = statSync(filePath).size;
  const contentType = contentTypeFor(filePath);
  const range = parseRange(rangeHeader, size);
  const stream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('[sme] アセットストリームのエラー:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  if (range) {
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range.end - range.start + 1),
      'Cache-Control': 'no-store',
    });
  } else {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    });
  }
  stream.pipe(res);
}
