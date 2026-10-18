import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

export interface SearchOptions {
  /** 每个源最多抓取的页数，默认取站点配置 */
  maxPages?: number;
  /** 外部中断信号（全局搜索预算用） */
  signal?: AbortSignal;
}

const SEARCH_TIMEOUT_MS = 8000;
const MAX_DESC_LENGTH = 160;

/**
 * 苹果 CMS 播放页地址补全。
 * 形如 /play/<token>（结尾无扩展名）的地址实际是播放页，其 HLS 直链为
 * /play/<token>/index.m3u8（2026-10-18 实测：红牛、新浪、速博、金鹰等源
 * 均为此形态，补全后可正常拉流；share/<token> 形态实测补全无效、不处理）。
 */
function normalizePlayUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (/\/play\/[A-Za-z0-9_-]+$/.test(u.pathname)) {
      return `${trimmed.replace(/\/+$/, '')}/index.m3u8`;
    }
  } catch {
    // 非法 URL 原样返回
  }
  return trimmed;
}

/**
 * 从 vod_play_url 原始串提取播放地址（搜索与详情共用）。
 * 格式：多线路以 $$$ 分隔；线路内以 # 分隔集；每集为 "名称$地址"（名称可缺省）。
 * 注意：不要求地址以 .m3u8 结尾——历史上用 /\.m3u8/ 正则提取，
 * 会把 /play/<token> 形态（补全后可用）的整批集直接丢弃（2026-10-18 修复）。
 * 多线路时选集数最多的一条。
 */
function extractPlayUrls(vodPlayUrl: string): string[] {
  let best: string[] = [];
  for (const line of vodPlayUrl.split('$$$')) {
    const urls = line
      .split('#')
      .map((seg) => {
        const u = seg
          .split('$')
          .map((s) => s.trim())
          .find((s) => /^https?:\/\//i.test(s));
        if (!u) return '';
        const parenIndex = u.indexOf('(');
        return parenIndex > 0 ? u.substring(0, parenIndex) : u;
      })
      .filter(Boolean)
      .map(normalizePlayUrl);
    if (urls.length > best.length) best = urls;
  }
  return Array.from(new Set(best));
}

/** 列表结果中的简介截断，避免搜索结果体积过大 */
function truncateDesc(raw?: string): string {
  const text = cleanHtmlTags(raw || '');
  return text.length > MAX_DESC_LENGTH ? text.slice(0, MAX_DESC_LENGTH) : text;
}

function mapSearchItems(list: ApiSearchItem[], apiSite: ApiSite): SearchResult[] {
  return list.map((item) => {
    const episodes = item.vod_play_url ? extractPlayUrls(item.vod_play_url) : [];

    return {
      id: item.vod_id.toString(),
      title: item.vod_name.trim().replace(/\s+/g, ' '),
      poster: item.vod_pic,
      episodes,
      source: apiSite.key,
      source_name: apiSite.name,
      class: item.vod_class,
      year: item.vod_year ? item.vod_year.match(/\d{4}/)?.[0] || '' : 'unknown',
      desc: truncateDesc(item.vod_content),
      type_name: item.type_name,
      douban_id: item.vod_douban_id,
      is_adult: apiSite.is_adult === true,
    };
  });
}

async function fetchSearchPage(
  apiBaseUrl: string,
  query: string,
  page: number,
  apiSite: ApiSite,
  outerSignal?: AbortSignal
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timeoutId);
      return [];
    }
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const pageUrl =
      apiBaseUrl +
      API_CONFIG.search.pagePath
        .replace('{query}', encodeURIComponent(query))
        .replace('{page}', page.toString());

    const response = await fetch(pageUrl, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (!data || !data.list || !Array.isArray(data.list)) return [];
    return mapSearchItems(data.list, apiSite);
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutId);
      return [];
    }
    options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const apiBaseUrl = apiSite.api;
    const apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);

    const response = await fetch(apiUrl, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
      return [];
    }

    const results = mapSearchItems(data.list, apiSite);

    const config = await getConfig();
    const maxPages = options.maxPages ?? config.SiteConfig.SearchDownstreamMaxPage;

    // 获取总页数
    const pageCount = data.pagecount || 1;
    // 确定需要获取的额外页数
    const pagesToFetch = Math.min(pageCount - 1, Math.max(0, maxPages - 1));

    if (pagesToFetch > 0) {
      const additionalResults = await Promise.all(
        Array.from({ length: pagesToFetch }, (_, i) =>
          fetchSearchPage(apiBaseUrl, query, i + 2, apiSite, controller.signal)
        )
      );
      additionalResults.forEach((pageResults) => {
        if (pageResults.length > 0) {
          results.push(...pageResults);
        }
      });
    }

    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

// 匹配 m3u8 链接的正则
const M3U8_PATTERN = /(https?:\/\/[^"'\s]+?\.m3u8)/g;

export async function getDetailFromApi(
  apiSite: ApiSite,
  id: string
): Promise<SearchResult> {
  if (apiSite.detail) {
    return handleSpecialSourceDetail(id, apiSite);
  }

  const detailUrl = `${apiSite.api}${API_CONFIG.detail.path}${id}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情请求失败: ${response.status}`);
  }

  const data = await response.json();

  if (
    !data ||
    !data.list ||
    !Array.isArray(data.list) ||
    data.list.length === 0
  ) {
    throw new Error('获取到的详情内容无效');
  }

  const videoDetail = data.list[0];
  let episodes: string[] = [];

  // 处理播放源拆分（与搜索结果共用提取逻辑）
  if (videoDetail.vod_play_url) {
    episodes = extractPlayUrls(videoDetail.vod_play_url);
  }

  // 如果播放源为空，则尝试从内容中解析 m3u8
  if (episodes.length === 0 && videoDetail.vod_content) {
    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
    episodes = matches.map((link: string) => link.replace(/^\$/, ''));
  }

  return {
    id: id.toString(),
    title: videoDetail.vod_name,
    poster: videoDetail.vod_pic,
    episodes,
    source: apiSite.key,
    source_name: apiSite.name,
    class: videoDetail.vod_class,
    year: videoDetail.vod_year
      ? videoDetail.vod_year.match(/\d{4}/)?.[0] || ''
      : 'unknown',
    desc: cleanHtmlTags(videoDetail.vod_content),
    type_name: videoDetail.type_name,
    douban_id: videoDetail.vod_douban_id,
  };
}

async function handleSpecialSourceDetail(
  id: string,
  apiSite: ApiSite
): Promise<SearchResult> {
  const detailUrl = `${apiSite.detail}/index.php/vod/detail/id/${id}.html`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情页请求失败: ${response.status}`);
  }

  const html = await response.text();
  let matches: string[] = [];

  if (apiSite.key === 'ffzy') {
    const ffzyPattern =
      /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
    matches = html.match(ffzyPattern) || [];
  }

  if (matches.length === 0) {
    const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
    matches = html.match(generalPattern) || [];
  }

  // 去重并清理链接前缀
  matches = Array.from(new Set(matches)).map((link: string) => {
    link = link.substring(1); // 去掉开头的 $
    const parenIndex = link.indexOf('(');
    return parenIndex > 0 ? link.substring(0, parenIndex) : link;
  });

  // 提取标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const titleText = titleMatch ? titleMatch[1].trim() : '';

  // 提取描述
  const descMatch = html.match(
    /<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/
  );
  const descText = descMatch ? cleanHtmlTags(descMatch[1]) : '';

  // 提取封面
  const coverMatch = html.match(/(https?:\/\/[^"'\s]+?\.jpg)/g);
  const coverUrl = coverMatch ? coverMatch[0].trim() : '';

  // 提取年份
  const yearMatch = html.match(/>(\d{4})</);
  const yearText = yearMatch ? yearMatch[1] : 'unknown';

  return {
    id,
    title: titleText,
    poster: coverUrl,
    episodes: matches,
    source: apiSite.key,
    source_name: apiSite.name,
    class: '',
    year: yearText,
    desc: descText,
    type_name: '',
    douban_id: 0,
  };
}
