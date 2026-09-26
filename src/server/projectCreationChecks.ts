import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { CREATE_MEDIA_EXTENSIONS, MAX_CREATE_IMAGES, classifyCreateSelection, createMediaKind } from '../shared/createMedia';

/** Shared validation only: no legacy template, generation or package installation. */
export function sanitizeProjectName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (name === '' || name.length > 80) {
    throw new HttpError(400, 'プロジェクト名は 1〜80 文字で入力してください');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    throw new HttpError(400, `プロジェクト名に使えない文字が含まれています: ${raw}`);
  }
  return name;
}

/** 名前の形と重複だけを確かめる（大きな受信の前に弾く）。 */
export function precheckProjectName(root: string, rawName: string): string {
  const name = sanitizeProjectName(rawName);
  if (existsSync(join(root, name))) {
    throw new HttpError(409, `同じ名前のプロジェクトがすでにあります: ${name}`);
  }
  return name;
}

/** Reject invalid names, extensions and duplicates before accepting large uploads. 動画・音声・画像の1件（設計 M1・M5）。 */
export function precheckCreateProject(root: string, rawName: string, sourceName: string): void {
  sanitizeProjectName(rawName);
  if (createMediaKind(sourceName) === null) {
    throw new HttpError(400, `動画・音声・画像のファイルを選んでください（対応: ${CREATE_MEDIA_EXTENSIONS.join(' ')}）`);
  }
  precheckProjectName(root, rawName);
}

/** 複数画像の作成。画像だけ・1〜200 枚・受け付ける拡張子。 */
export function precheckCreateImages(root: string, rawName: string, names: readonly string[]): void {
  sanitizeProjectName(rawName);
  if (names.length === 0) throw new HttpError(400, '画像を選んでください');
  if (names.length > MAX_CREATE_IMAGES) throw new HttpError(400, `画像は1回に${MAX_CREATE_IMAGES}枚まで選べます（選んだ画像: ${names.length} 枚）`);
  const selection = classifyCreateSelection(names);
  if (!selection.ok) throw new HttpError(400, selection.message);
  if (selection.kind !== 'image') throw new HttpError(400, '複数のファイルから作れるのは画像だけです。動画・音声は1件ずつ選んでください');
  precheckProjectName(root, rawName);
}
