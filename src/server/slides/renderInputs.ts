import { realpathSync } from 'node:fs';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { HttpError } from '../http';

/** 書き出し・縮小画像・動画への取り込みで描画ページへ渡す、固定したページごとの 1 コマの文書。撮影の間だけ登録する。 */
export class SlidesRenderInputs {
  private readonly inputs = new Map<string, SequenceDocument[]>();
  private key(directory: string, jobId: string): string { return `${realpathSync(directory)}\0${jobId}`; }
  register(directory: string, jobId: string, documents: readonly SequenceDocument[]): () => void {
    const key = this.key(directory, jobId);
    this.inputs.set(key, structuredClone([...documents]));
    return () => { this.inputs.delete(key); };
  }
  get(directory: string, jobId: string, index: number): SequenceDocument {
    const documents = this.inputs.get(this.key(directory, jobId));
    if (!documents) throw new HttpError(404, '描画する入力が見つかりません');
    const document = Number.isSafeInteger(index) ? documents[index] : undefined;
    if (!document) throw new HttpError(404, 'そのページの入力がありません');
    return document;
  }
  asset(directory: string, jobId: string, assetId: string): SequenceAsset {
    const documents = this.inputs.get(this.key(directory, jobId));
    if (!documents) throw new HttpError(404, '描画する入力が見つかりません');
    const asset = documents.flatMap(document => document.assets).find(item => item.id === assetId);
    if (!asset) throw new HttpError(404, '固定した入力に指定の素材がありません');
    return asset;
  }
}
export const slidesRenderInputs = new SlidesRenderInputs();
