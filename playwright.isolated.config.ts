// 手動 dev サーバー（:2109）と共存して e2e を回すための隔離設定。
// 通常の playwright.config.ts は reuseExistingServer で :2109 の手動 dev を拾ってしまい
// （fixture でない実プロジェクトが開いて）落ちるため、編集作業中はこちらを使う:
//   npx playwright test --config playwright.isolated.config.ts
import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...(base as object),
  use: { baseURL: 'http://localhost:5199' },
  webServer: {
    ...(base as any).webServer,
    command: 'npm run edit -- --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: false,
  },
});
