import type { ComponentType } from 'react';

/** サブ動画部品の React コンポーネント型。segment の中身はプロジェクト側の VideoInsert。 */
export type InsertVideoComponent = ComponentType<{ segment: unknown }>;
