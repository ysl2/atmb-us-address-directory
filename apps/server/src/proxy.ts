import type { AxiosRequestConfig } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

export interface CrawlProxy {
  id: number;
  url: string;
}

export interface AxiosProxyOptions {
  protocol: string;
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

export type AxiosProxyRequestOptions = Pick<AxiosRequestConfig, 'proxy' | 'httpAgent' | 'httpsAgent'>;

const supportedProxyProtocols = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

export function normalizeProxyUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('INVALID_PROXY_URL');
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('INVALID_PROXY_URL');
  }

  if (!supportedProxyProtocols.has(parsed.protocol)) {
    throw new Error('UNSUPPORTED_PROXY_PROTOCOL');
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error('INVALID_PROXY_URL');
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function proxyUrlToAxiosProxy(url: string): AxiosProxyOptions {
  const parsed = new URL(normalizeProxyUrl(url));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('UNSUPPORTED_AXIOS_PROXY_PROTOCOL');
  }

  const proxy: AxiosProxyOptions = {
    protocol: parsed.protocol.replace(/:$/, ''),
    host: parsed.hostname,
    port: Number(parsed.port),
  };

  if (parsed.username || parsed.password) {
    proxy.auth = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }

  return proxy;
}

export function proxyUrlToAxiosRequestOptions(url: string): AxiosProxyRequestOptions {
  const normalizedUrl = normalizeProxyUrl(url);
  const parsed = new URL(normalizedUrl);

  if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
    const agent = new SocksProxyAgent(normalizedUrl);
    return {
      proxy: false,
      httpAgent: agent,
      httpsAgent: agent,
    };
  }

  return {
    proxy: proxyUrlToAxiosProxy(normalizedUrl),
  };
}

export function proxyUrlToCurlArgs(url: string) {
  return ['--proxy', normalizeProxyUrl(url)];
}
