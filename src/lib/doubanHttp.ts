/**
 * 豆瓣上游请求的统一入口：固定请求头 + 15 秒超时 + 瞬态失败重试一次。
 *
 * 背景：豆瓣 API（m.douban.com/rexxar、movie.douban.com/j）从边缘出口请求时，
 * 偶发 5xx / 网络抖动（实测 20 次压测 p95 约 2.9s，存在瞬时失败），
 * 单次失败就让页面报错体验很差，这里统一加一次重试并把超时放宽到 15s。
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

/**
 * 请求豆瓣上游；5xx 与网络异常会自动重试一次（共最多两轮）。
 * 4xx 属于确定性拒绝，直接返回给调用方处理。
 */
export async function fetchDoubanWithRetry(
  url: string,
  accept?: string
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOUBAN_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: accept ? { ...DOUBAN_HEADERS, Accept: accept } : DOUBAN_HEADERS,
      });
      if (!response.ok && response.status >= 500 && attempt === 1) {
        lastError = new Error(`HTTP error! Status: ${response.status}`);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt === 2) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('豆瓣上游请求失败');
}
