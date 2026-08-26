import { describe, it, expect } from 'vitest';
import { VIDEO_EXTENSIONS, VIDEO_ACCEPT } from './videoExtensions';
import { VIDEO_EXTENSIONS as SERVER_VIDEO_EXTENSIONS } from '../server/loadProjectFiles';
import { VIDEO_EXTENSIONS as UPLOAD_VIDEO_EXTENSIONS } from '../app/uploadMaterial';

describe('VIDEO_EXTENSIONS（動画拡張子の単一正本）', () => {
  it('サーバ側の定数は共有の正本そのもの（複製されていない）', () => {
    // 同値ではなく**同一参照**を見る。誰かが loadProjectFiles 側へリテラルを
    // 書き戻すと（バッチE レビュー指摘④の再発）ここが落ちる。
    expect(SERVER_VIDEO_EXTENSIONS).toBe(VIDEO_EXTENSIONS);
  });

  it('クライアントのアップロード分類も同一参照を使う', () => {
    expect(UPLOAD_VIDEO_EXTENSIONS).toBe(VIDEO_EXTENSIONS);
  });

  it('accept 属性は全拡張子を漏れなく含む', () => {
    const parts = VIDEO_ACCEPT.split(',');
    for (const ext of VIDEO_EXTENSIONS) expect(parts).toContain(ext);
  });
});
