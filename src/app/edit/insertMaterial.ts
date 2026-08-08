import type { MaterialKind } from '../panels/materialList';
import type { EditState } from './editState';
import { addSe } from './seOps';
import { addImage } from './imageOps';
import { addBgm } from './bgmOps';
import { addVideoInsert } from './videoInsertOps';

/** 種別に応じた挿入 op を originalStart（原本フレーム）で適用する。クリック挿入・ドロップ挿入で共用。 */
export function applyInsertMaterial(
  kind: MaterialKind,
  state: EditState,
  file: string,
  originalStart: number,
): EditState {
  switch (kind) {
    case 'se':
      return addSe(state, file, originalStart);
    case 'image':
      return addImage(state, file, originalStart);
    case 'bgm':
      return addBgm(state, file, originalStart);
    case 'video':
      return addVideoInsert(state, file, originalStart);
  }
}
