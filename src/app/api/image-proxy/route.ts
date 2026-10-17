import { NextResponse } from 'next/server';

import { addCorsHeaders, handleOptionsRequest } from '@/lib/cors';

export const runtime = 'edge';

const MAX_BYTES = 8 * 1024 * 1024; // 8MB
const FETCH_TIMEOUT_MS = 8000;

// 处理OPTIONS预检请求（OrionTV客户端需要）
export async function OPTIONS() {
  return handleOptionsRequest();
}

/** 判断主机名是否为内网/保留地址，防止 SSRF */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host === '0.0.0.0'
  ) {
    return true;
  }

  // IPv4 字面量
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // IPv6 字面量
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
    // IPv4-mapped ::ffff:a.b.c.d
    const mapped = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedHost(mapped[1]);
  }
  return false;
}

function validateTarget(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isBlockedHost(url.hostname)) return null;
  return url;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return addCorsHeaders(NextResponse.json({ error: 'Missing image URL' }, { status: 400 }));
  }

  const target = validateTarget(imageUrl);
  if (!target) {
    return addCorsHeaders(
      NextResponse.json({ error: 'URL 不合法（仅支持公网 http/https 图片地址）' }, { status: 400 })
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const imageResponse = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    });

    // 跟随重定向后再次校验最终地址，防止跳转到内网
    if (!validateTarget(imageResponse.url)) {
      return addCorsHeaders(
        NextResponse.json({ error: '重定向目标不合法' }, { status: 400 })
      );
    }

    if (!imageResponse.ok) {
      return addCorsHeaders(
        NextResponse.json({ error: imageResponse.statusText }, { status: imageResponse.status })
      );
    }

    const contentType = imageResponse.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      return addCorsHeaders(
        NextResponse.json({ error: '目标不是图片' }, { status: 415 })
      );
    }

    const declaredLength = Number(imageResponse.headers.get('content-length') || '0');
    if (declaredLength > MAX_BYTES) {
      return addCorsHeaders(
        NextResponse.json({ error: '图片超过大小限制' }, { status: 413 })
      );
    }

    const buffer = await imageResponse.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return addCorsHeaders(
        NextResponse.json({ error: '图片超过大小限制' }, { status: 413 })
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Length', String(buffer.byteLength));
    // 站点已要求登录，不使用公开 CDN 缓存
    headers.set('Cache-Control', 'private, max-age=604800');

    return addCorsHeaders(new Response(buffer, { status: 200, headers }));
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return addCorsHeaders(
      NextResponse.json(
        { error: aborted ? '图片获取超时' : 'Error fetching image' },
        { status: aborted ? 504 : 500 }
      )
    );
  } finally {
    clearTimeout(timer);
  }
}
