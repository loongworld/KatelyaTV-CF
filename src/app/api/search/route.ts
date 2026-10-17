import { NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { addCorsHeaders, handleOptionsRequest } from '@/lib/cors';
import { getStorage } from '@/lib/db';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

/** 全局搜索时间预算：到点即中止剩余上游请求，用已完成的结果返回 */
const SEARCH_BUDGET_MS = 6000;
/** 每个源最多抓取的页数（原全局配置为 5，搜索延迟过大） */
const MAX_PAGES_PER_SOURCE = 3;
/** 上游结果缓存时长（秒） */
const UPSTREAM_CACHE_TTL = 300;

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function getDefaultCache(): CacheLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (globalThis as any).caches;
    return c && c.default ? (c.default as CacheLike) : null;
  } catch {
    return null;
  }
}

// 处理OPTIONS预检请求（OrionTV客户端需要）
export async function OPTIONS() {
  return handleOptionsRequest();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const includeAdult = searchParams.get('include_adult') === 'true';

  // 身份只来自签名会话（middleware 已强制登录）
  const session = await getAuthInfoFromCookie(request);
  if (!session) {
    return addCorsHeaders(NextResponse.json({ error: '未登录' }, { status: 401 }));
  }

  const cacheTime = await getCacheTime();

  if (!query) {
    const response = NextResponse.json(
      { regular_results: [], adult_results: [] },
      {
        headers: {
          // 站点需要登录，不使用公开 CDN 缓存
          'Cache-Control': 'private, max-age=0, no-store',
        },
      }
    );
    return addCorsHeaders(response);
  }

  // 过滤策略：按用户设置决定是否过滤成人内容
  let shouldFilterAdult = true;
  try {
    const storage = getStorage();
    const userSettings = await storage.getUserSettings(session.username);
    shouldFilterAdult = userSettings?.filter_adult_content !== false;
  } catch {
    shouldFilterAdult = true;
  }
  const finalShouldFilter = shouldFilterAdult || !includeAdult;

  // 上游结果缓存键：与用户无关，只依赖关键词与过滤策略
  const cache = getDefaultCache();
  const cacheKey = new Request(
    `https://search-cache.invalid/?q=${encodeURIComponent(query)}&adult=${finalShouldFilter ? '0' : '1'}`
  );
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return addCorsHeaders(
          new Response(body, {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': `private, max-age=${Math.min(60, cacheTime)}`,
              'X-Search-Cache': 'HIT',
            },
          })
        );
      }
    } catch {
      // 缓存读取失败不影响正常搜索
    }
  }

  try {
    const availableSites = finalShouldFilter
      ? await getAvailableApiSites(true)
      : await getAvailableApiSites(false);

    if (!availableSites || availableSites.length === 0) {
      const response = NextResponse.json(
        { regular_results: [], adult_results: [] },
        { headers: { 'Cache-Control': 'private, max-age=0, no-store' } }
      );
      return addCorsHeaders(response);
    }

    // 全局时间预算：超时后中止所有未完成的上游请求
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_BUDGET_MS);
    const collected: SearchResult[] = [];

    try {
      await Promise.allSettled(
        availableSites.map(async (site) => {
          const results = await searchFromApi(site, query, {
            maxPages: MAX_PAGES_PER_SOURCE,
            signal: controller.signal,
          });
          for (const item of results) collected.push(item);
        })
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = JSON.stringify({
      regular_results: collected,
      adult_results: [],
    });

    if (cache) {
      try {
        await cache.put(
          cacheKey,
          new Response(payload, {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': `max-age=${UPSTREAM_CACHE_TTL}`,
            },
          })
        );
      } catch {
        // 缓存写入失败忽略
      }
    }

    return addCorsHeaders(
      new Response(payload, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `private, max-age=${Math.min(60, cacheTime)}`,
          'X-Search-Cache': 'MISS',
        },
      })
    );
  } catch (error) {
    const response = NextResponse.json(
      {
        regular_results: [],
        adult_results: [],
        error: '搜索失败',
      },
      { status: 500 }
    );
    return addCorsHeaders(response);
  }
}
