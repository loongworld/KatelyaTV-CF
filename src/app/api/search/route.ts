import { NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { ApiSite, getAvailableApiSites, getCacheTime } from '@/lib/config';
import { addCorsHeaders, handleOptionsRequest } from '@/lib/cors';
import { getStorage } from '@/lib/db';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

/** 全局搜索时间预算：到点即中止剩余上游请求，用已完成的结果返回 */
const SEARCH_BUDGET_MS = 6000;
/**
 * 单次请求最多检索多少个源。
 * Cloudflare Workers / Pages Functions 免费版「每请求子请求上限」为 50，
 * 一次搜索每个源至少产生 1 次上游 fetch，因此必须给源数量设上限。
 * 超出部分由客户端用 ?offset= 分片补齐（见 src/app/search/page.tsx）。
 */
const MAX_SOURCES_PER_REQUEST = 40;
/** 每源最多抓取的页数：1 页，避免分页请求把子请求额度吃光 */
const MAX_PAGES_PER_SOURCE = 1;
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

/**
 * 以关键词为起点轮转源列表：让不同关键词优先命中不同批次的源，
 * 避免排在后面的源永远轮不到（同一关键词的顺序稳定，缓存才能复用）。
 */
function rotateSites(sites: ApiSite[], query: string): ApiSite[] {
  if (sites.length <= 1) return sites;
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = (hash * 31 + query.charCodeAt(i)) >>> 0;
  }
  const start = hash % sites.length;
  return [...sites.slice(start), ...sites.slice(0, start)];
}

function emptyResult(cacheTime: number): NextResponse {
  return NextResponse.json(
    {
      regular_results: [],
      adult_results: [],
      total_sources: 0,
      queried_sources: 0,
      offset: 0,
    },
    {
      headers: {
        // 站点需要登录，不使用公开 CDN 缓存；上游结果另有 Cache API 兜底
        'Cache-Control': `private, max-age=${Math.min(cacheTime, 60)}`,
      },
    }
  );
}

// 处理OPTIONS预检请求（OrionTV客户端需要）
export async function OPTIONS() {
  return handleOptionsRequest();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const includeAdult = searchParams.get('include_adult') === 'true';
  const offsetParam = Number(searchParams.get('offset') || '0');
  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;

  // 身份只来自签名会话（middleware 已强制登录）
  const session = await getAuthInfoFromCookie(request);
  if (!session) {
    return addCorsHeaders(NextResponse.json({ error: '未登录' }, { status: 401 }));
  }

  const cacheTime = await getCacheTime();

  if (!query) {
    return addCorsHeaders(emptyResult(cacheTime));
  }

  // 过滤策略：默认过滤成人源；只有用户设置里明确关掉过滤、且请求带上 include_adult=true
  // 时才把成人源纳入检索。两者缺一即保持过滤（fail closed）。
  let shouldFilterAdult = true;
  try {
    const storage = getStorage();
    const userSettings = await storage.getUserSettings(session.username);
    shouldFilterAdult = userSettings?.filter_adult_content !== false;
  } catch {
    shouldFilterAdult = true;
  }
  const includeAdultSources = !shouldFilterAdult && includeAdult;

  // 上游结果缓存键：与用户无关，只依赖关键词、过滤策略与分片偏移
  const cache = getDefaultCache();
  const cacheKey = new Request(
    `https://search-cache.invalid/?q=${encodeURIComponent(query)}&adult=${
      includeAdultSources ? '1' : '0'
    }&offset=${offset}`
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
              'Cache-Control': `private, max-age=${Math.min(cacheTime, 60)}`,
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
    // filterAdult=true 只返回非成人源；false 返回全部源
    const allSites = await getAvailableApiSites(!includeAdultSources);

    if (!allSites || allSites.length === 0) {
      return addCorsHeaders(emptyResult(cacheTime));
    }

    const ordered = rotateSites(allSites, query);
    const batch = ordered.slice(offset, offset + MAX_SOURCES_PER_REQUEST);

    if (batch.length === 0) {
      return addCorsHeaders(emptyResult(cacheTime));
    }

    // 全局时间预算：超时后中止所有未完成的上游请求
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_BUDGET_MS);
    const collected: SearchResult[] = [];

    try {
      await Promise.allSettled(
        batch.map(async (site) => {
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

    // 按来源是否成人分组，而不是把结果混在一起
    const regular: SearchResult[] = [];
    const adult: SearchResult[] = [];
    for (const item of collected) {
      if (item.is_adult) adult.push(item);
      else regular.push(item);
    }

    const payload = JSON.stringify({
      regular_results: regular,
      adult_results: adult,
      total_sources: ordered.length,
      queried_sources: batch.length,
      offset,
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
          'Cache-Control': `private, max-age=${Math.min(cacheTime, 60)}`,
          'X-Search-Cache': 'MISS',
        },
      })
    );
  } catch (error) {
    const response = NextResponse.json(
      {
        regular_results: [],
        adult_results: [],
        total_sources: 0,
        queried_sources: 0,
        offset,
        error: '搜索失败',
      },
      { status: 500 }
    );
    return addCorsHeaders(response);
  }
}
