import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { SlideCommand } from '../src/core/slides/commands';
import { slidesFixture } from '../src/core/slides/fixtures';
import type { SlideDocument } from '../src/core/slides/model';
import type { SlidesSessionState } from '../src/server/slides/service';
import { SlidesStore } from '../src/server/slides/store';
import { FIXTURES_ROOT } from './helpers';
import { shotDir } from './shotDir';

/** 画面の撮影の置き場。通常ランは追跡しない .aaa-shots/slides（作業ツリーを汚さない）。証拠更新ラン（AAA_UPDATE_EVIDENCE=1）だけ docs 側（設計書: 見た目の確認はここに残す）へ書く。 */
export const SLIDES_SHOTS = process.env['AAA_UPDATE_EVIDENCE'] === '1' ? join(import.meta.dirname, '..', 'docs/research/2026-10-04-slides/shots') : shotDir('slides');
/** 使い捨てのスライド案件（見本は 2 ページ: 表紙・要点）。消すのは tests/helpers.ts の removeTempProject。 */
export function createSlidesFixture(prefix: string, document: SlideDocument = slidesFixture()): { id: string; dir: string } {
  const id = `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, dir = join(FIXTURES_ROOT, id);
  mkdirSync(dir);
  new SlidesStore(dir).save({ expectedSavedRevision: null, executionId: 'seed', document });
  return { id, dir };
}
export async function openSlides(page: Page, id: string, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
  await page.goto(`/?${new URLSearchParams({ slides: id })}`);
  await expect(page.locator('.native-slides')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
export async function slidesState(request: APIRequestContext, id: string): Promise<SlidesSessionState> {
  const response = await request.post(`/api/slides/session?${new URLSearchParams({ id })}`, { data: {} });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as SlidesSessionState;
}
/** API で人の操作をする（画面は通知で受け取る）。保存までする。 */
export async function slidesCommand(request: APIRequestContext, id: string, command: SlideCommand): Promise<SlidesSessionState> {
  const state = await slidesState(request, id), query = new URLSearchParams({ id });
  const applied = await request.post(`/api/slides/command?${query}`, { data: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), command } });
  expect(applied.ok(), await applied.text()).toBe(true);
  const next = await applied.json() as SlidesSessionState;
  const saved = await request.post(`/api/slides/save?${query}`, { data: { sessionId: next.sessionId, expectedRevision: next.document.revision, expectedSavedRevision: next.savedRevision, executionId: crypto.randomUUID() } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return await saved.json() as SlidesSessionState;
}
export async function slidesShot(page: Page, name: string): Promise<void> {
  mkdirSync(SLIDES_SHOTS, { recursive: true });
  await page.screenshot({ path: join(SLIDES_SHOTS, `${name}.png`) });
}
/** キャンバス px（1920×1080）を画面の座標にする。 */
export async function slidesCanvasToScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number; scale: number }> {
  const box = (await page.getByRole('region', { name: 'キャンバス' }).locator('.native-thumbnail-overlay').first().boundingBox())!, scale = box.width / 1920;
  return { x: box.x + x * scale, y: box.y + y * scale, scale };
}
