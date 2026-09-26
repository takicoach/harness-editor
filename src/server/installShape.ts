import { installNativeDataPack, isNativeDataPackInstalled } from './nativeDataPacks';

export function isShapeInstalled(dir: string): boolean {
  return isNativeDataPackInstalled('shape', dir);
}

/** Shape geometry is built into the native renderer; install only its data. */
export function installShape(dir: string): { installed: boolean } {
  return installNativeDataPack('shape', dir);
}
