/* eslint-disable no-console */

'use client';

const CURRENT_VERSION = '20261018200000';

// 版本检查结果枚举
export enum UpdateStatus {
  HAS_UPDATE = 'has_update', // 有新版本
  NO_UPDATE = 'no_update', // 无新版本
  FETCH_FAILED = 'fetch_failed', // 获取失败
}

// 远程版本检查URL配置（只认环境变量）
// 原先这里还硬编码了两个默认地址，其中一个是第三方 GitHub 代理 ghfast.top：
// 结果是每个访客每次打开页面都向第三方发一次请求、把 IP 交出去，
// 而检查的又是上游 katelya77 仓库的版本号——对本 fork 没有意义。默认不再请求外部地址。
const ENV_PRIMARY = process.env.NEXT_PUBLIC_VERSION_URL_PRIMARY;
const ENV_BACKUP = process.env.NEXT_PUBLIC_VERSION_URL_BACKUP;
const VERSION_CHECK_URLS = [ENV_PRIMARY, ENV_BACKUP].filter(Boolean) as string[];

/**
 * 检查是否有新版本可用
 * @returns Promise<UpdateStatus> - 返回版本检查状态
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  // 没配置外部版本地址就返回「无更新」，不做任何外部请求
  if (VERSION_CHECK_URLS.length === 0) {
    return UpdateStatus.NO_UPDATE;
  }

  try {
    // 尝试从主要URL获取版本信息
    const primaryVersion = await fetchVersionFromUrl(VERSION_CHECK_URLS[0]);
    if (primaryVersion) {
      return compareVersions(primaryVersion);
    }

    // 如果主要URL失败，尝试备用URL
    const backupVersion = VERSION_CHECK_URLS[1]
      ? await fetchVersionFromUrl(VERSION_CHECK_URLS[1])
      : null;
    if (backupVersion) {
      return compareVersions(backupVersion);
    }

    // 如果两个URL都失败，返回获取失败状态
    return UpdateStatus.FETCH_FAILED;
  } catch (error) {
    console.error('版本检查失败:', error);
    return UpdateStatus.FETCH_FAILED;
  }
}

/**
 * 从指定URL获取版本信息
 * @param url - 版本信息URL
 * @returns Promise<string | null> - 版本字符串或null
 */
async function fetchVersionFromUrl(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const version = await response.text();
    return version.trim();
  } catch (error) {
    console.warn(`从 ${url} 获取版本信息失败:`, error);
    return null;
  }
}

/**
 * 比较版本号
 * @param remoteVersion - 远程版本号
 * @returns UpdateStatus - 返回版本比较结果
 */
function compareVersions(remoteVersion: string): UpdateStatus {
  try {
    // 将版本号转换为数字进行比较
    const current = parseInt(CURRENT_VERSION, 10);
    const remote = parseInt(remoteVersion, 10);

    return remote > current ? UpdateStatus.HAS_UPDATE : UpdateStatus.NO_UPDATE;
  } catch (error) {
    console.error('版本比较失败:', error);
    return UpdateStatus.FETCH_FAILED;
  }
}

// 导出当前版本号供其他地方使用
export { CURRENT_VERSION };
