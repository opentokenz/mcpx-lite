import { describe, expect, it } from 'vitest';
import { resolveFetchOrigin } from '../src/tools/fetch.js';

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', headers });

describe('resolveFetchOrigin（fetch 链接的对外 origin）', () => {
  it('优先取 RFC 7239 Forwarded 的 proto / host', () => {
    const origin = resolveFetchOrigin(
      request('http://127.0.0.1:8787/mcp', { forwarded: 'proto=https;host=pi.example.com' }),
    );

    expect(origin).toBe('https://pi.example.com');
  });

  it('Forwarded 带引号、多段代理时取第一段', () => {
    const origin = resolveFetchOrigin(
      request('http://127.0.0.1:8787/mcp', {
        forwarded: 'for=1.2.3.4;proto="https";host="pi.example.com", proto=http;host=inner.local',
      }),
    );

    expect(origin).toBe('https://pi.example.com');
  });

  it('Forwarded 缺 host 时退到 X-Forwarded-Proto + X-Forwarded-Host', () => {
    const origin = resolveFetchOrigin(
      request('http://127.0.0.1:8787/mcp', {
        forwarded: 'proto=https;for=1.2.3.4',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'pi.example.com',
      }),
    );

    expect(origin).toBe('https://pi.example.com');
  });

  it('X-Forwarded-*：保留端口，多值取第一个', () => {
    expect(
      resolveFetchOrigin(
        request('http://127.0.0.1:8787/mcp', {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'pi.example.com:8443',
        }),
      ),
    ).toBe('https://pi.example.com:8443');

    expect(
      resolveFetchOrigin(
        request('http://127.0.0.1:8787/mcp', {
          'x-forwarded-proto': 'https, http',
          'x-forwarded-host': 'pi.example.com, inner.local',
        }),
      ),
    ).toBe('https://pi.example.com');
  });

  it('代理头只给一半时不算数（不猜协议）', () => {
    expect(
      resolveFetchOrigin(request('http://127.0.0.1:8787/mcp', { 'x-forwarded-host': 'pi.example.com' })),
    ).toBeUndefined();
    expect(
      resolveFetchOrigin(request('http://127.0.0.1:8787/mcp', { 'x-forwarded-proto': 'https' })),
    ).toBeUndefined();
  });

  it('没有代理头时：非回环的绝对 URL 可用', () => {
    expect(resolveFetchOrigin(request('https://pi.example.com/mcp'))).toBe('https://pi.example.com');
    expect(resolveFetchOrigin(request('http://192.168.1.9:8787/mcp'))).toBe('http://192.168.1.9:8787');
  });

  it('回环 / 不可访问地址不可用（由调用方回退到配置的 host:port）', () => {
    for (const url of [
      'http://127.0.0.1:8787/mcp',
      'http://localhost:8787/mcp',
      'http://[::1]:8787/mcp',
      'http://0.0.0.0:8787/mcp',
    ]) {
      expect(resolveFetchOrigin(request(url)), url).toBeUndefined();
    }
  });

  it('代理头里的非法值不拼进 URL：非 http(s) 协议 / 带路径 / 非法 host 都被丢弃', () => {
    // 非 http(s) 协议
    expect(
      resolveFetchOrigin(
        request('http://127.0.0.1:8787/mcp', { 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'evil.com' }),
      ),
    ).toBeUndefined();

    // 带路径：归一化成 origin，路径被丢掉
    expect(
      resolveFetchOrigin(
        request('http://127.0.0.1:8787/mcp', {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'pi.example.com/../evil',
        }),
      ),
    ).toBe('https://pi.example.com');

    // 非法 host
    expect(
      resolveFetchOrigin(
        request('http://127.0.0.1:8787/mcp', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'not a host' }),
      ),
    ).toBeUndefined();
  });

  it('Forwarded 里的值不可用时继续看 X-Forwarded-*', () => {
    expect(
      resolveFetchOrigin(
        request('http://127.0.0.1:8787/mcp', {
          forwarded: 'proto=javascript;host=evil.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'pi.example.com',
        }),
      ),
    ).toBe('https://pi.example.com');
  });

  it('没有请求 / 相对 URL 时返回 undefined', () => {
    expect(resolveFetchOrigin(undefined)).toBeUndefined();
    expect(resolveFetchOrigin({})).toBeUndefined();
    expect(resolveFetchOrigin({ url: '/mcp' })).toBeUndefined();
  });
});
