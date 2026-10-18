/* eslint-disable no-console */
import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { fetchDoubanWithRetry, getDefaultCache } from '@/lib/doubanHttp';
import { DoubanItem, DoubanResult } from '@/lib/types';

interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

async function fetchDoubanData(
  url: string
): Promise<DoubanCategoryApiResponse> {
  const response = await fetchDoubanWithRetry(url);

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  return await response.json();
}

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const kind = searchParams.get('kind') || 'movie';
  const category = searchParams.get('category');
  const type = searchParams.get('type');
  const pageLimit = parseInt(searchParams.get('limit') || '20');
  const pageStart = parseInt(searchParams.get('start') || '0');

  // 验证参数
  if (!kind || !category || !type) {
    return NextResponse.json(
      { error: '缺少必要参数: kind 或 category 或 type' },
      { status: 400 }
    );
  }

  if (!['tv', 'movie'].includes(kind)) {
    return NextResponse.json(
      { error: 'kind 参数必须是 tv 或 movie' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart < 0) {
    return NextResponse.json(
      { error: 'pageStart 不能小于 0' },
      { status: 400 }
    );
  }

  // URLSearchParams 负责对 category / type 等中文参数做百分号编码
  const query = new URLSearchParams({
    start: String(pageStart),
    limit: String(pageLimit),
    category,
    type,
  });
  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?${query}`;

  try {
    // 服务端缓存（10 分钟）：榜单数据变化不频繁，多标签 / 多设备浏览时
    // 避免把所有请求都打到豆瓣上游（上游偶发限流/慢响应是 500 的主要来源）
    const cache = getDefaultCache();
    const cacheKey = new Request(
      `https://douban-cache.invalid/categories/${kind}/${encodeURIComponent(category)}/${encodeURIComponent(type)}/${pageStart}/${pageLimit}`
    );
    let doubanData: DoubanCategoryApiResponse | null = null;
    if (cache) {
      try {
        const hit = await cache.match(cacheKey);
        if (hit) doubanData = (await hit.json()) as DoubanCategoryApiResponse;
      } catch {
        // 缓存读取失败不影响主流程
      }
    }
    if (!doubanData) {
      doubanData = await fetchDoubanData(target);
      if (cache) {
        try {
          await cache.put(
            cacheKey,
            new Response(JSON.stringify(doubanData), {
              headers: { 'Cache-Control': 'public, max-age=600' },
            })
          );
        } catch {
          // 缓存写入失败不影响主流程
        }
      }
    }

    // 转换数据格式
    const list: DoubanItem[] = doubanData.items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    const cacheTime = await getCacheTime();
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      },
    });
  } catch (error) {
    // 记录真实原因，便于通过 `wrangler pages deployment tail` 定位
    console.error('[douban/categories] 上游请求失败:', (error as Error).message);
    return NextResponse.json(
      { error: '获取豆瓣数据失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
