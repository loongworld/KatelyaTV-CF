/**
 * 豆瓣上游请求的统一入口：固定请求头 + 15 秒超时。
 * 失败如实上报给调用方处理（不做重试兜底）。
 */

const DOUBAN_TIMEOUT_MS = 15_000;
const DOUBAN_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Referer: 'https://movie.douban.com/',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://movie.douban.com',
};

/** Cloudflare Cache API 的最小用到的接口（DOM 类型里没有 caches.default） */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export function getDefaultCache(): CacheLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (globalThis as any).caches;
    return c && c.default ? (c.default as CacheLike) : null;
  } catch {
    return null;
  }
}

export async function fetchDouban(url: string, accept?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOUBAN_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: accept ? { ...DOUBAN_HEADERS, Accept: accept } : DOUBAN_HEADERS,
    });
  } finally {
    clearTimeout(timer);
  }
}
