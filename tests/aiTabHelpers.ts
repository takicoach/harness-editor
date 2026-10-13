import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AiFocusView } from '../src/shared/aiFocus';
import { shotDir } from './shotDir';

/** 撮影の置き場。AAA_UPDATE_EVIDENCE=1 の時だけ証拠として docs に書く（通常は .aaa-shots）。 */
export const AI_TAB_SHOTS = process.env['AAA_UPDATE_EVIDENCE'] === '1' ? join(import.meta.dirname, '..', 'docs/research/2026-10-08-ai-tab/shots') : shotDir('ai-tab');
export async function aiTabShot(page: Page, name: string): Promise<void> {
  mkdirSync(AI_TAB_SHOTS, { recursive: true });
  await page.screenshot({ path: join(AI_TAB_SHOTS, `${name}.png`) });
}
/** 新形式の案件を開いて AI タブを開く（偽の AI が起動するまで待つ）。 */
export async function openNativeAi(page: Page, projectId: string, theme: 'light' | 'dark' = 'light'): Promise<Locator> {
  await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
  await page.goto(`/?project=${encodeURIComponent(projectId)}`);
  await page.getByRole('button', { name: '✦ AI で編集する' }).click();
  const term = page.getByTestId('claude-terminal');
  await expect(term).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });
  return term;
}
/** 偽の AI を終わらせて「再起動する」で起動し直す（前の spec が起動した AI を引き継がないため）。 */
export async function restartFakeAi(page: Page): Promise<Locator> {
  const term = page.getByTestId('claude-terminal');
  await term.click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter'); // 偽の AI の stdin は行単位（Enter まで届かない）
  await page.getByRole('button', { name: '再起動する' }).click();
  await expect(term).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });
  return term;
}
export async function aiFocusView(request: APIRequestContext): Promise<AiFocusView> {
  const response = await request.get('/api/ai/focus');
  expect(response.ok()).toBe(true);
  return await response.json() as AiFocusView;
}
/** AI タブから起動した AI のふりをして MCP につなぐ（/mcp?client=ai-tab）。 */
export async function connectAiTabMcp(baseURL: string) {
  const client = new Client({ name: 'ai-tab-e2e', version: '1.0.0' }), transport = new StreamableHTTPClientTransport(new URL('/mcp?client=ai-tab', baseURL));
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Record<string, any> };
  };
  return { client, call, close: async () => { await transport.terminateSession().catch(() => {}); await client.close(); } };
}
