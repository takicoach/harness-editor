import { HttpError } from '../http';
import { id, integer, object } from '../sequence/editRequest';
import { countSlideLeaves, SLIDE_COMMAND_TYPES, type SlideCommand } from '../../core/slides/commands';
import { SLIDES_MAX_COMMAND_LEAVES } from '../../core/slides/model';
import type { SlideEditRequest } from '../../core/slides/session';

/** /command で受ける操作。素材の登録は保存済みのバイトを確かめる /register、構成案と本文は AI の受け口（/apply・MCP）だけが出す。 */
export const SLIDES_HTTP_COMMAND_TYPES: readonly string[] = SLIDE_COMMAND_TYPES.filter(type => !['register-assets', 'set-outline', 'apply-page-bodies'].includes(type));
function checkTypes(command: Record<string, unknown>, depth: number): void {
  if (typeof command.type !== 'string' || !SLIDES_HTTP_COMMAND_TYPES.includes(command.type)) throw new HttpError(400, '未対応の編集操作です');
  if (command.type !== 'batch') return;
  if (depth >= 4 || !Array.isArray(command.commands) || command.commands.length > SLIDES_MAX_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
  for (const child of command.commands) checkTypes(object(child), depth + 1);
}
export function slidesEditRequest(body: Record<string, unknown>): SlideEditRequest {
  const command = object(body.command), base = { sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision), executionId: id(body.executionId) };
  if (command.type === 'undo' || command.type === 'redo') return { ...base, command: { type: command.type } };
  checkTypes(command, 0);
  if (countSlideLeaves(command as unknown as SlideCommand) > SLIDES_MAX_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
  return { ...base, command: command as unknown as SlideCommand };
}
