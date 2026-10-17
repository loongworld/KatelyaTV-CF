import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { timingSafeEqualString } from '@/lib/secure';
import { getTvboxToken } from '@/lib/session';

// 强制使用 Edge Runtime 以支持 Cloudflare Pages
export const runtime = 'edge';

// TVBox源格式接口
interface TVBoxSource {
  key: string;
  name: string;
  type: number; // 0=XML, 1=JSON
  api: string;
  searchable?: number;
  quickSearch?: number;
  filterable?: number;
  ext?: string;
  timeout?: number;
  categories?: string[];
}

interface TVBoxConfig {
  spider?: string;
  wallpaper?: string;
  sites: TVBoxSource[];
  parses?: Array<{
    name: string;
    type: number;
    url: string;
    ext?: Record<string, unknown>;
  }>;
  flags?: string[];
  ads?: string[];
}

const ADS_RULES = [
  'mimg.0c1q0l.cn',
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'hm.baidu.com',
  'cnzz.mmstat.com',
  'c.cnzz.com',
];

/**
 * 校验订阅令牌。令牌由会话密钥派生（见 lib/session.getTvboxToken），
 * 轮换 SESSION_SECRET / AUTH_PASSWORD 即失效。
 */
async function checkToken(request: NextRequest): Promise<NextResponse | null> {
  const expected = await getTvboxToken();
  if (!expected) {
    return NextResponse.json(
      { error: '服务端未配置订阅令牌（缺少 SESSION_SECRET / AUTH_PASSWORD）' },
      { status: 503 }
    );
  }
  const { searchParams } = new URL(request.url);
  const provided =
    searchParams.get('token') || request.headers.get('x-tvbox-token') || '';
  if (!provided || !timingSafeEqualString(provided, expected)) {
    return NextResponse.json({ error: '订阅令牌无效' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await checkToken(request);
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') || 'json';
    const host = request.headers.get('host') || 'localhost:3000';
    const protocol = request.headers.get('x-forwarded-proto') || 'https';
    const baseUrl = `${protocol}://${host}`;

    const config = await getConfig();

    // 只输出启用中的源，禁用源不下发给 TVBox
    const sourceConfigs = (config.SourceConfig || []).filter((s) => !s.disabled);

    if (sourceConfigs.length === 0) {
      return NextResponse.json({ error: '没有配置任何可用的视频源' }, { status: 500 });
    }

    const tvboxConfig: TVBoxConfig = {
      spider: '',
      wallpaper: `${baseUrl}/screenshot1.png`,
      sites: sourceConfigs.map((source) => {
        // api 以 .xml / at/xml 结尾按 XML 源处理，其余按 JSON 源处理
        const apiLower = source.api.toLowerCase();
        const type =
          apiLower.includes('at/xml') || apiLower.endsWith('.xml') ? 0 : 1;
        return {
          key: source.key || source.name,
          name: source.name,
          type,
          api: source.api,
          searchable: 1,
          quickSearch: 1,
          filterable: 1,
          ext: source.detail || '',
          timeout: 30,
          categories: ['电影', '电视剧', '综艺', '动漫', '纪录片', '短剧'],
        };
      }),
      // 仅保留 TVBox 内置的两种通用解析调度方式；
      // 站点自带的 /api/parse 需要登录 Cookie，下发给 TVBox 无法使用，故不输出。
      parses: [
        { name: 'Json并发', type: 2, url: 'Parallel' },
        { name: 'Json轮询', type: 2, url: 'Sequence' },
      ],
      flags: [
        'youku', 'qq', 'iqiyi', 'qiyi', 'letv', 'sohu', 'mgtv', 'wasu', 'bilibili', 'xigua', '1905',
      ],
      ads: ADS_RULES,
    };

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
      // 订阅含令牌，不做公开 CDN 缓存
      'Cache-Control': 'private, max-age=300',
    };

    if (format === 'txt') {
      const configStr = JSON.stringify(tvboxConfig, null, 2);
      const base64Config = Buffer.from(configStr).toString('base64');
      return new NextResponse(base64Config, {
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return NextResponse.json(tvboxConfig, { headers });
  } catch (error) {
    return NextResponse.json(
      { error: 'TVBox配置生成失败', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-TVBox-Token',
    },
  });
}
