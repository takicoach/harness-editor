import { HttpError } from '../http';
import { id, integer, object } from '../sequence/editRequest';
import { countThumbnailLeaves, THUMBNAIL_COMMAND_TYPES, type ThumbnailCommand } from '../../core/thumbnail/commands';
import { THUMBNAIL_MAX_COMMAND_LEAVES } from '../../core/thumbnail/model';
import type { ThumbnailEditRequest } from '../../core/thumbnail/session';

/** /command で受ける操作。素材の登録は保存済みのバイトを確かめる /register だけが行う。 */
export const THUMBNAIL_HTTP_COMMAND_TYPES: readonly string[] = THUMBNAIL_COMMAND_TYPES.filter(type => type !== 'register-assets');
function checkTypes(command: Record<string, unknown>, depth: number): void {
  if (typeof command.type !== 'string' || !THUMBNAIL_HTTP_COMMAND_TYPES.includes(command.type)) throw new HttpError(400, '未対応の編集操作です');
  if (command.type !== 'batch') return;
  if (depth >= 4 || !Array.isArray(command.commands) || command.commands.length > THUMBNAIL_MAX_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
  for (const child of command.commands) checkTypes(object(child), depth + 1);
}
export function thumbnailEditRequest(body: Record<string, unknown>): ThumbnailEditRequest {
  const command = object(body.command), base = { sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision), executionId: id(body.executionId) };
  if (command.type === 'undo' || command.type === 'redo') return { ...base, command: { type: command.type } };
  checkTypes(command, 0);
  if (countThumbnailLeaves(command as unknown as ThumbnailCommand) > THUMBNAIL_MAX_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
  return { ...base, command: command as unknown as ThumbnailCommand };
}
