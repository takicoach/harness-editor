import type { ComponentType } from 'react';

/** 挿入画像部品の React コンポーネント型。segment の中身はプロジェクト側の ImageSegment。 */
export type InsertImageComponent = ComponentType<{ segment: unknown }>;

/** 動的 import したモジュールから InsertImage コンポーネントを検証して取り出す。 */
export function pickInsertImageExport(mod: Record<string, unknown>): InsertImageComponent {
  const insertImage = mod.InsertImage;
  if (typeof insertImage !== 'function') {
    throw new Error(
      '挿入画像部品 (InsertImage) を読み込めませんでした。対象プロジェクトに src/InsertImage/InsertImage.tsx の InsertImage export がありません。',
    );
  }
  return insertImage as InsertImageComponent;
}
