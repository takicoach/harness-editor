import type { SlidesRequestKind } from '../../../shared/agentPrompts';

/** AI（または貼り付け）に頼むこと。keys は構成案のページの key（構成案のときは空）。 */
export interface SlidesRequestIntent { kind: SlidesRequestKind; keys: string[] }
/** AI の経路（B12 でつなぐ）。connected は AI の待機役がいるか（null はまだ分からない）。 */
export interface SlidesAiAccess { connected: boolean | null; /** 依頼を送っている最中、または AI が受付済み・作業中（二重に頼まない）。 */ busy: boolean; send(intent: SlidesRequestIntent): Promise<void> }
