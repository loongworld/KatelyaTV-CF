import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import { EpisodeSkipConfig } from '@/lib/types';

// 配置 Edge Runtime - Cloudflare Pages 要求
export const runtime = 'edge';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // 注意：不接受请求体中的 username，身份只来自签名 Cookie，防止越权读写他人配置
    const { action, key, config } = body;

    if (!action) {
      return NextResponse.json({ error: '缺少操作类型' }, { status: 400 });
    }

    const authInfo = await getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: '用户未登录' }, { status: 401 });
    }
    const finalUsername = authInfo.username;

    const storage = getStorage();

    switch (action) {
      case 'get': {
        if (!key) {
          return NextResponse.json({ error: '缺少配置键' }, { status: 400 });
        }
        const skipConfig = await storage.getSkipConfig(finalUsername, key);
        return NextResponse.json({ config: skipConfig });
      }

      case 'set': {
        if (!key || !config) {
          return NextResponse.json({ error: '缺少配置键或配置数据' }, { status: 400 });
        }

        if (!config.source || !config.id || !config.title || !Array.isArray(config.segments)) {
          return NextResponse.json({ error: '配置数据格式错误' }, { status: 400 });
        }

        if (config.segments.length > 20) {
          return NextResponse.json({ error: '片段数量超出上限' }, { status: 400 });
        }
        for (const segment of config.segments) {
          if (
            typeof segment.start !== 'number' ||
            typeof segment.end !== 'number' ||
            segment.start >= segment.end ||
            !['opening', 'ending'].includes(segment.type)
          ) {
            return NextResponse.json({ error: '片段数据格式错误' }, { status: 400 });
          }
        }

        await storage.setSkipConfig(finalUsername, key, config as EpisodeSkipConfig);
        return NextResponse.json({ success: true });
      }

      case 'getAll': {
        const allConfigs = await storage.getAllSkipConfigs(finalUsername);
        return NextResponse.json({ configs: allConfigs });
      }

      case 'delete': {
        if (!key) {
          return NextResponse.json({ error: '缺少配置键' }, { status: 400 });
        }
        await storage.deleteSkipConfig(finalUsername, key);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: '不支持的操作类型' }, { status: 400 });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('跳过配置 API 错误:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}
