/**
 * jsdom 環境で `localStorage` を使えるようにする。
 *
 * Node 22 以降（実測 v26.8.1）は Web Storage を**組み込みグローバル**として持つが、
 * `--localstorage-file` を渡さない限り `localStorage` の値は `undefined` になる。
 * vitest の jsdom 環境は「globalThis に未定義のキーだけ」を jsdom window から写すため、
 * Node 側の `undefined` なグローバルが jsdom の Storage を覆い隠す。
 * jsdom 環境では `window === globalThis` なので window 経由でも実体に届かない
 * （実測: `typeof window.localStorage === 'undefined'`、`sessionStorage` だけ object）。
 * グローバルの `Storage` クラスも同じ理由で Node 側のものに覆われている
 * （実測: `Storage.prototype !== Object.getPrototypeOf(sessionStorage)`）。
 *
 * そこで localStorage が欠けている時だけ、仕様どおりの Storage 実装を貼り、
 * グローバルの `Storage` もその実装へ揃える。`Storage` を揃えるのは
 * テスト側の `vi.spyOn(Storage.prototype, 'getItem')`（＝ localStorage 拒否環境の模擬）を
 * 効かせるため — 揃えないと「拒否されても落ちない」系のテストが素通りする。
 * `environment: 'node'` のテストでは window が無いので何もしない。
 */
class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    const k = String(key);
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.map.delete(String(key));
  }

  clear(): void {
    this.map.clear();
  }
}

const g = globalThis as Record<string, unknown>;

if (g['window'] && !g['localStorage']) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'Storage', {
    value: MemoryStorage,
    configurable: true,
    writable: true,
  });
}

/**
 * 新画面の初回チュートリアルを、テスト中は自動で出さない。
 * vitest の e2e（src/**\/*.e2e.test.ts）は scripts/native-*-audit.ts を子プロセスで起動し、
 * 空のブラウザ記録で新画面を開く。設定が有効のままだと初回チュートリアルの暗幕・吹き出しが
 * 画面中央に出て、監査のクリックや画素検査を妨げる。子プロセスは process.env を引き継ぐので、
 * ここで既定を 0 にすれば全監査に効く（Playwright は playwright.config.ts が SME_TUTORIAL=0 を渡す）。
 * 明示的に値が渡されている場合は上書きしない。監査を手で直接実行するときは SME_TUTORIAL=0 を付ける。
 */
if (process.env['SME_TUTORIAL'] === undefined) process.env['SME_TUTORIAL'] = '0';
