import { NextResponse } from 'next/server';

import { addCorsHeaders, handleOptionsRequest } from '@/lib/cors';

export const runtime = 'edge';

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const FETCH_TIMEOUT_MS = 8000;

/**
 * 只放行位图格式。此前用 `startsWith('image/')` 判断，等于把 image/svg+xml
 * 原样回传本站源——访客打开一条构造好的链接就能在本站执行脚本，
 * 进而以登录者身份调用 /api/admin/*。SVG 一律拒绝。
 */
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

// 处理OPTIONS预检请求（OrionTV客户端需要）
export async function OPTIONS() {
  return handleOptionsRequest();
}

/** 判断主机名是否为内网/保留地址，防止 SSRF */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0') {
    return true;
  }

  // 通配 DNS 服务可以把任意 IP 编码进域名（例如 127.0.0.1.nip.io），
  // 只做字面量判断挡不住它们，这里按后缀拦掉
  const BLOCKED_SUFFIXES = [
    '.localhost',
    '.local',
    '.internal',
    '.home.arpa',
    '.localtest.me',
    '.lvh.me',
    '.nip.io',
    '.sslip.io',
    '.xip.io',
  ];
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
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

/**
 * 按文件头魔数判断是否为受支持的位图。
 * 上游的 Content-Type 不可信：豆瓣对疑似异常的出口 IP 会返回 13 字节的
 * "cdn error 001" 文本，Content-Type 却写着 image/jpeg——只信声明就会把
 * 这段垃圾当图片缓存 7 天，前端只能显示裂图。
 */
function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d) return true;
  // ICO
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return true;
  // RIFF....WEBP
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return true;
  }
  // ISO-BMFF（avif / heic）: 第 4-8 字节是 'ftyp'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;
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
        // 注意：豆瓣图床对带 movie.douban.com Referer 的请求返回 403，
        // 因此这里刻意不设置 Referer。
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
    });

    // 跟随重定向后再次校验最终地址，防止跳转到内网
    if (!validateTarget(imageResponse.url)) {
      return addCorsHeaders(
        NextResponse.json({ error: '重定向目标不合法' }, { status: 400 })
      );
    }

    const rawContentType = imageResponse.headers.get('content-type') || '';
    const contentType = rawContentType.split(';')[0].trim().toLowerCase();

    // 豆瓣图床对无 Referer 请求会返回 418 但 body 仍是图片，按成功处理
    const okStatus = imageResponse.ok || imageResponse.status === 418;

    if (!okStatus) {
      return addCorsHeaders(
        NextResponse.json({ error: imageResponse.statusText }, { status: imageResponse.status })
      );
    }

    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return addCorsHeaders(
        NextResponse.json({ error: '不支持的图片类型' }, { status: 415 })
      );
    }

    const declaredLength = Number(imageResponse.headers.get('content-length') || '0');
    if (declaredLength > MAX_BYTES) {
      return addCorsHeaders(
        NextResponse.json({ error: '图片超过大小限制' }, { status: 413 })
      );
    }

    // 流式读取并即时截断：原先先 arrayBuffer() 再判断体积，
    // 没有 Content-Length 的流可以在判断之前就把 isolate 内存撑爆
    const body = imageResponse.body;
    if (!body) {
      return addCorsHeaders(NextResponse.json({ error: '图片响应为空' }, { status: 502 }));
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return addCorsHeaders(
            NextResponse.json({ error: '图片超过大小限制' }, { status: 413 })
          );
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return addCorsHeaders(NextResponse.json({ error: '读取图片失败' }, { status: 502 }));
    }

    const merged = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      merged.set(chunk, cursor);
      cursor += chunk.byteLength;
    }

    // 声明是图片不等于内容是图片，按魔数再校验一次
    if (!looksLikeImage(merged)) {
      return addCorsHeaders(
        NextResponse.json({ error: '目标返回的不是图片内容' }, { status: 502 })
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Length', String(total));
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    // 位图内容稳定，交给浏览器缓存 7 天并允许 Cloudflare 边缘共享缓存
    headers.set('Cache-Control', 'public, max-age=604800, s-maxage=604800, immutable');

    return addCorsHeaders(new Response(merged, { status: 200, headers }));
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
