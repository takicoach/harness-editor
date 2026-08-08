import { describe, it, expect } from 'vitest';
import { isLocalHostHeader, isAllowedOrigin, isAllowedFetchSite, isAllowedLocalRequest } from './localGuard';

describe('isLocalHostHeader', () => {
  it('localhost / 127.0.0.1 / [::1] をポート付きで許可する', () => {
    expect(isLocalHostHeader('localhost:2109')).toBe(true);
    expect(isLocalHostHeader('localhost')).toBe(true);
    expect(isLocalHostHeader('127.0.0.1:2109')).toBe(true);
    expect(isLocalHostHeader('[::1]:2109')).toBe(true);
  });

  it('外部ドメイン・LAN IP・不正値を拒否する（DNS リバインディング対策）', () => {
    expect(isLocalHostHeader('evil.example.com')).toBe(false);
    expect(isLocalHostHeader('evil.example.com:2109')).toBe(false);
    expect(isLocalHostHeader('192.168.1.10:2109')).toBe(false);
    expect(isLocalHostHeader('localhost.evil.com')).toBe(false);
    expect(isLocalHostHeader(undefined)).toBe(false);
    expect(isLocalHostHeader('')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('Origin 未指定（同一オリジン GET・curl 等）は許可する', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('ローカル起源の Origin を許可する', () => {
    expect(isAllowedOrigin('http://localhost:2109')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:2109')).toBe(true);
  });

  it('外部サイト・null Origin を拒否する（CSRF 対策）', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('file://')).toBe(false);
  });
});

describe('isAllowedFetchSite', () => {
  it('same-origin / none / 未指定は許可', () => {
    expect(isAllowedFetchSite('same-origin')).toBe(true);
    expect(isAllowedFetchSite('none')).toBe(true);
    expect(isAllowedFetchSite(undefined)).toBe(true);
    expect(isAllowedFetchSite('')).toBe(true);
  });
  it('cross-site / same-site は拒否（他サイトからの img/fetch/リンク）', () => {
    expect(isAllowedFetchSite('cross-site')).toBe(false);
    expect(isAllowedFetchSite('same-site')).toBe(false);
  });
});

describe('isAllowedLocalRequest', () => {
  it('ローカル Host かつローカル/無 Origin かつ非 cross-site のみ許可する', () => {
    expect(isAllowedLocalRequest({ host: 'localhost:2109' })).toBe(true);
    expect(isAllowedLocalRequest({ host: 'localhost:2109', origin: 'http://localhost:2109' })).toBe(true);
    expect(isAllowedLocalRequest({ host: 'localhost:2109', 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(isAllowedLocalRequest({ host: 'localhost:2109', 'sec-fetch-site': 'none' })).toBe(true);
  });
  it('外部 Host/Origin を拒否する', () => {
    expect(isAllowedLocalRequest({ host: 'evil.example.com' })).toBe(false);
    expect(isAllowedLocalRequest({ host: 'localhost:2109', origin: 'https://evil.example.com' })).toBe(false);
  });
  it('Origin 無しでも cross-site GET（<img> 等）は Sec-Fetch-Site で拒否する', () => {
    // localGuard 迂回 → 未オープンプロジェクトの vm 到達を塞ぐ回帰
    expect(isAllowedLocalRequest({ host: '127.0.0.1:2109', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(isAllowedLocalRequest({ host: '127.0.0.1:2109', 'sec-fetch-site': 'same-site' })).toBe(false);
  });
  it('重複ヘッダ（配列）は fail-closed で拒否する', () => {
    // ['same-origin','cross-site'] を先頭だけ見て通す fail-open を防ぐ
    expect(isAllowedLocalRequest({ host: 'localhost:2109', 'sec-fetch-site': ['same-origin', 'cross-site'] })).toBe(false);
    expect(isAllowedLocalRequest({ host: ['localhost:2109', 'evil.example.com'] })).toBe(false);
    expect(isAllowedLocalRequest({ host: 'localhost:2109', origin: ['http://localhost:2109', 'https://evil.example.com'] })).toBe(false);
  });
});
