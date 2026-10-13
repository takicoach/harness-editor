import {HttpError} from '../http';
import {validateRestoreCutCommand} from '../../core/sequence/cutArchive';
import {validateResizeCutBoundaryCommand} from '../../core/sequence/cutBoundary';
import {validateAdoptSourceGap} from '../../core/sequence/adoptSourceGap';
import {isNativeSpeedCommandType,validateNativeSpeedCommand} from '../../core/sequence/speedCommandValidation';
import {validateSceneFadeEdit} from '../../core/sequence/sceneFadeEdits';
import {MAX_SEQUENCE_COMMAND_LEAVES,MAX_USAGE_SWAP_TARGETS,SEQUENCE_COMMAND_TYPES,SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP,SEQUENCE_HISTORY_COMMAND_TYPES} from '../../core/sequence/commandTypes';
import type {EditRequest} from '../../core/sequence/session';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '要求の形式が不正です');
  return value as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new HttpError(400, '要求のIDが不正です');
  return value;
}
export function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HttpError(400, '要求の番号が不正です');
  return value as number;
}
/**
 * /command が受け付ける操作は SequenceCommand の union から導出する（手書きの列挙をやめる）。
 * 専用ルートだけが発行するものは SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP に理由つきで並べ、
 * 「union − 拒否リスト ＋ 履歴操作 = 受理集合」をテストで固定する（commandAllowList.test.ts）。
 */
export const SEQUENCE_API_COMMAND_TYPES: readonly string[] = [
  ...SEQUENCE_COMMAND_TYPES.filter(type => !(SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP as readonly string[]).includes(type)),
  ...SEQUENCE_HISTORY_COMMAND_TYPES,
];
export function editRequest(body: Record<string, unknown>, depth = 0, budget = {leafCount: 0}): EditRequest {
  const command = object(body.command), type = command.type;
  if (typeof type!=='string'||!SEQUENCE_API_COMMAND_TYPES.includes(type)) throw new HttpError(400, '未対応の編集操作です');
  // Count editing leaves across the entire HTTP request. Batch containers,
  // including empty batches, do not consume the existing 50-operation budget.
  if (type !== 'batch' && ++budget.leafCount > MAX_SEQUENCE_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
  if(isNativeSpeedCommandType(type))validateNativeSpeedCommand(command);
  if(type==='set-scene-fades')validateSceneFadeEdit(command.targets,command.change);
  // 転換の形だけをここで見る。つなぎ目との一致・重なりの妥当性は set-transition と
  // 文書検証が持つ（UI は planTransition の結果をそのまま渡す）。
  if(type==='set-transition'){
    if(typeof command.joinKey!=='string'||!command.joinKey||command.joinKey.length>512)throw new HttpError(400,'つなぎ目の指定が不正です');
    if(command.transition!==null){
      const transition=object(command.transition);
      // SequenceTransition（id を除く）が持ちうるキーだけを許す。未知キーはここで弾く。
      const allowed=['trackId','outClipId','inClipId','kind','startFrame','durationFrames','edge','audioCurve','joinKey','joinFrame'];
      if(Object.keys(transition).some(key=>!allowed.includes(key)))throw new HttpError(400,'転換の内容が不正です');
      for(const key of ['trackId','outClipId','inClipId','kind'])if(typeof transition[key]!=='string'||!transition[key])throw new HttpError(400,'転換の内容が不正です');
      integer(transition.startFrame);integer(transition.durationFrames);
      if((transition.durationFrames as number)<1)throw new HttpError(400,'転換の長さが不正です');
      if(transition.edge!==undefined&&transition.edge!=='in'&&transition.edge!=='out')throw new HttpError(400,'転換の内容が不正です');
      if(transition.audioCurve!==undefined&&transition.audioCurve!=='linear'&&transition.audioCurve!=='none')throw new HttpError(400,'転換の内容が不正です');
      if(transition.joinKey!==undefined&&(typeof transition.joinKey!=='string'||!transition.joinKey))throw new HttpError(400,'転換の内容が不正です');
      if(transition.joinFrame!==undefined)integer(transition.joinFrame);
    }
  }
  if (type === 'remove-asset') id(command.assetId);
  // 文字スタイルの一括適用・表示切替。番号の実在はカタログを持つ document 側が見る。
  if (type === 'apply-text-style-all') {
    if (command.trackId !== undefined) id(command.trackId);
    id(command.assetId); integer(command.styleId); if ((command.styleId as number) < 1) throw new HttpError(400, 'スタイル番号が不正です');
    if (command.clearUnsupportedAnimations !== undefined && typeof command.clearUnsupportedAnimations !== 'boolean') throw new HttpError(400, '動きの解除指定が不正です');
  }
  if (type === 'set-text-style-hidden') {
    id(command.assetId);
    if (!Array.isArray(command.hidden) || command.hidden.length > 200) throw new HttpError(400, '表示設定が不正です');
    for (const value of command.hidden) integer(value);
  }
  // 追加パックの一覧登録だけがこの経路を使う。保存済みバイトとの一致は /command の実行前に確かめる。
  if (type === 'register-assets') {
    if (!Array.isArray(command.assets) || !command.assets.length || command.assets.length > 20) throw new HttpError(400, '登録する素材の一覧が不正です');
    for (const value of command.assets) {
      const asset = object(value); id(asset.id);
      if (asset.kind !== 'component') throw new HttpError(400, 'この操作で登録できるのは描画部品だけです');
    }
  }
  // 音声補正の参照切替。形だけをここで見る（素材の実在・音声ストリームの一致は文書側が持つ）。
  if (type === 'replace-audio-source') { id(command.trackId); id(command.fromAssetId); id(command.toAssetId); }
  // 文字スタイルの参照切替。形だけをここで見る（資産の実在・部品かどうかは文書側が持つ）。
  if (type === 'replace-text-style-asset') { id(command.fromAssetId); id(command.toAssetId); }
  if (type === 'batch') {
    if (depth >= 4 || !Array.isArray(command.commands) || command.commands.length > MAX_SEQUENCE_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
    for (const child of command.commands) {
      const parsed = editRequest({ ...body, command: child }, depth + 1, budget);
      if (parsed.command.type === 'undo' || parsed.command.type === 'redo') throw new HttpError(400, '履歴操作はまとめて実行できません');
    }
  }
  if (['split', 'delete', 'move', 'unlink'].includes(String(type))
    && (!Array.isArray(command.clipIds) || !command.clipIds.every(v => typeof v === 'string' && v.length))) throw new HttpError(400, '対象クリップの一覧が不正です');
  if (command.linked !== undefined && typeof command.linked !== 'boolean') throw new HttpError(400, '連動設定が不正です');
  if (type === 'ripple-delete') { integer(command.startFrame); integer(command.endFrame); }
  if(type==='resize-cut-boundary')validateResizeCutBoundaryCommand(command);
  if(type==='adopt-source-gap')validateAdoptSourceGap(command);
  if(type==='restore-cut') {id(command.entryId);validateRestoreCutCommand(command);}
  if(type==='fill-cut-captions')id(command.templateClipId);
  if(type==='split-caption'){id(command.clipId);integer(command.frame);if(typeof command.leftText!=='string'||typeof command.rightText!=='string')throw new HttpError(400,'字幕本文が不正です');}
  if(type==='merge-captions'){id(command.firstClipId);id(command.secondClipId);}
  if (type === 'split' || type === 'trim') integer(command.frame);
  if (type === 'move' && !Number.isSafeInteger(command.deltaFrames)) throw new HttpError(400, '移動量が不正です');
  if (type === 'trim' && command.edge !== 'start' && command.edge !== 'end') throw new HttpError(400, 'トリム端点が不正です');
  // 詰める（リップル）の切替。省略は従来動作。受理集合は union 導出のまま（コマンド型は増えない）。
  if (type === 'trim' && command.ripple !== undefined && typeof command.ripple !== 'boolean') throw new HttpError(400, '詰める指定が不正です');
  if (type === 'trim' || type === 'update-clip') id(command.clipId);
  if (type === 'add-track') { object(command.track); if (command.index !== undefined) integer(command.index); }
  if (type === 'insert' && !Array.isArray(command.clips)) throw new HttpError(400, '挿入クリップの一覧が不正です');
  if (type === 'set-track-enabled') { id(command.trackId); if (typeof command.enabled !== 'boolean') throw new HttpError(400, 'トラック設定が不正です'); }
  if (type === 'move-track') { id(command.trackId); integer(command.index); }
  if (type === 'remove-track') id(command.trackId);
  if (type === 'update-clip') object(command.patch);
  // 使用箇所の差し替え（素材の試し差し替えの採用）。葉としては1件で、片の数は live と退避の合計で MAX_USAGE_SWAP_TARGETS まで。
  // 形だけをここで見る（クリップ・退避の実在・中身の妥当性は文書側の検証が持つ）。
  if (type === 'swap-usage-content') {
    // batch の中には入れない（1回の送信で書き換えられる片を MAX_USAGE_SWAP_TARGETS に保つ）。
    if (depth > 0) throw new HttpError(400, '使用箇所の差し替えはまとめて実行できません');
    if (!Array.isArray(command.live) || !Array.isArray(command.archived)) throw new HttpError(400, '要求の形式が不正です');
    if (command.live.length + command.archived.length > MAX_USAGE_SWAP_TARGETS) throw new HttpError(400, 'まとめる編集操作が多すぎます');
    const target = (value: unknown, keys: string[]) => {
      const item = object(value);
      if (Object.keys(item).some(key => !keys.includes(key))) throw new HttpError(400, '差し替えの変更内容が不正です');
      const patch = object(item.patch);
      if (Object.keys(patch).some(key => !['name', 'content'].includes(key)) || (patch.name !== undefined && typeof patch.name !== 'string')) throw new HttpError(400, '差し替えの変更内容が不正です');
      object(patch.content); return item;
    };
    for (const value of command.live) id(target(value, ['clipId', 'patch']).clipId);
    for (const value of command.archived) { const item = target(value, ['entryId', 'clipId', 'patch']); id(item.entryId); id(item.clipId); }
  }
  if(type==='set-ducking'){
    const patch=object(command.patch);
    if(Object.keys(patch).some(key=>!['enabled','strength'].includes(key))||('enabled' in patch&&typeof patch.enabled!=='boolean')
      ||('strength' in patch&&!['weak','mid','strong'].includes(String(patch.strength))))throw new HttpError(400,'BGMの自動音量調整の設定が不正です');
  }
  if(type==='set-script' && command.script!==null)object(command.script);
  return { sessionId: id(body.sessionId), executionId: id(body.executionId), expectedRevision: integer(body.expectedRevision), command: command as EditRequest['command'] };
}
