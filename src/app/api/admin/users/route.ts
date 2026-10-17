/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import { User } from '@/lib/types';

export const runtime = 'edge';

const SETTINGS_FIELDS = [
  'filter_adult_content',
  'can_disable_filter',
  'managed_by_admin',
] as const;

/** 仅站长可访问；未配置 USERNAME 时不存在站长（避免普通用户名被误判） */
async function requireOwner(request: NextRequest): Promise<NextResponse | null> {
  const authInfo = await getAuthInfoFromCookie(request);
  if (!authInfo) {
    return NextResponse.json({ error: '需要认证' }, { status: 401 });
  }
  if (!process.env.USERNAME || authInfo.username !== process.env.USERNAME) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOwner(request);
    if (denied) return denied;

    const storage = getStorage();
    const users: User[] = await storage.getAllUsers();
    const usersWithSettings = await Promise.all(
      users.map(async (user) => {
        const settings = await storage.getUserSettings(user.username);
        return {
          username: user.username,
          role: user.role || 'user',
          created_at: user.created_at,
          filter_adult_content: settings?.filter_adult_content ?? true,
          can_disable_filter: settings?.can_disable_filter ?? true,
          managed_by_admin: settings?.managed_by_admin ?? false,
          last_filter_change: settings?.last_filter_change,
        };
      })
    );

    return NextResponse.json(
      { users: usersWithSettings, total: usersWithSettings.length },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('获取用户列表失败:', error);
    return NextResponse.json({ error: '获取用户列表失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOwner(request);
    if (denied) return denied;

    const storage = getStorage();
    const { action, username, settings } = (await request.json()) as {
      action?: string;
      username?: unknown;
      settings?: Record<string, unknown>;
    };
    if (typeof username !== 'string' || !username) {
      return NextResponse.json({ error: '缺少目标用户名' }, { status: 400 });
    }

    switch (action) {
      case 'update_settings': {
        // 只允许修改白名单字段，防止写入任意键
        const patch: Record<string, unknown> = {};
        for (const field of SETTINGS_FIELDS) {
          if (settings && field in settings) patch[field] = settings[field];
        }
        const currentSettings = await storage.getUserSettings(username);
        await storage.setUserSettings(username, {
          ...currentSettings,
          ...patch,
          last_filter_change: new Date().toISOString(),
        } as any);
        return NextResponse.json({ success: true, message: `已更新用户 ${username} 的设置` });
      }

      case 'force_filter': {
        const currentSettings: any = (await storage.getUserSettings(username)) || {
          filter_adult_content: true,
          theme: 'auto',
          language: 'zh-CN',
          auto_play: false,
          video_quality: 'auto',
        };
        await storage.setUserSettings(username, {
          ...currentSettings,
          filter_adult_content: true,
          can_disable_filter: false,
          managed_by_admin: true,
          last_filter_change: new Date().toISOString(),
        } as any);
        return NextResponse.json({ success: true, message: `已强制开启用户 ${username} 的成人内容过滤` });
      }

      case 'allow_disable': {
        const existing: any = (await storage.getUserSettings(username)) || {
          filter_adult_content: true,
          theme: 'auto',
          language: 'zh-CN',
          auto_play: false,
          video_quality: 'auto',
        };
        await storage.setUserSettings(username, {
          ...existing,
          filter_adult_content: existing.filter_adult_content ?? true,
          theme: existing.theme || 'auto',
          language: existing.language || 'zh-CN',
          auto_play: existing.auto_play ?? false,
          video_quality: existing.video_quality || 'auto',
          can_disable_filter: true,
          managed_by_admin: false,
          last_filter_change: new Date().toISOString(),
        } as any);
        return NextResponse.json({ success: true, message: `已允许用户 ${username} 自己管理过滤设置` });
      }

      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }
  } catch (error) {
    console.error('用户管理操作失败:', error);
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
}
