import { realpathSync } from 'node:fs';
import type { SequenceDocument } from '../../core/sequence/model';
import { HttpError } from '../http';

/** 書き出し・縮小画像の描画ページへ渡す、固定した 1 コマの文書。撮影の間だけ登録する。 */
export class ThumbnailRenderInputs {
  private readonly inputs = new Map<string, SequenceDocument>();
  private key(directory: string, jobId: string): string { return `${realpathSync(directory)}\0${jobId}`; }
  register(directory: string, jobId: string, document: SequenceDocument): () => void {
    const key = this.key(directory, jobId);
    this.inputs.set(key, structuredClone(document));
    return () => { this.inputs.delete(key); };
  }
  get(directory: string, jobId: string): SequenceDocument {
    const document = this.inputs.get(this.key(directory, jobId));
    if (!document) throw new HttpError(404, '描画する入力が見つかりません');
    return document;
  }
}
export const thumbnailRenderInputs = new ThumbnailRenderInputs();
