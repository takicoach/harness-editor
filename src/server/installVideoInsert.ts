import { installNativeDataPack, isNativeDataPackInstalled } from './nativeDataPacks';

/** Native editing uses validated data; legacy project TSX stays untouched. */
export function isVideoInsertInstalled(dir:string):boolean { return isNativeDataPackInstalled('videoInsert',dir); }
export function installVideoInsert(dir:string):{ installed:boolean } {
  return installNativeDataPack('videoInsert',dir);
}
