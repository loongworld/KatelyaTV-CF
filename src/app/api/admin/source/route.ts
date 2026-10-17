/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig, invalidateConfigCache } from '@/lib/config';
import { getStorage } from '@/lib/db';
import { IStorage } from '@/lib/types';

export const runtime = 'edge';

type Action = 'add' | 'disable' | 'enable' | 'delete' | 'sort';
const ACTIONS: Action[] = ['add', 'disable', 'enable', 'delete', 'sort'];
const MAX_BATCH_OPS = 200;

interface SourceOp {
  action?: Action;
  key?: string;
  name?: string;
  api?: string;
  detail?: string;
  is_adult?: boolean;
  order?: string[];
}

/** 对内存中的配置应用一条操作，返回错误信息（成功则为 null） */
function applySourceOp(adminConfig: AdminConfig, op: SourceOp): string | null {
  switch (op.action) {
    case 'add': {
      if (!op.key || !op.name || !op.api) return '缺少必要参数';
      if (adminConfig.SourceConfig.some((s) => s.key === op.key)) return '该源已存在';
      adminConfig.SourceConfig.push({
        key: op.key,
        name: op.name,
        api: op.api,
        detail: op.detail,
        from: 'custom',
        disabled: false,
        is_adult: op.is_adult || false,
      });
      return null;
    }
    case 'disable':
    case 'enable': {
      if (!op.key) return '缺少 key 参数';
      const entry = adminConfig.SourceConfig.find((s) => s.key === op.key);
      if (!entry) return '源不存在';
      entry.disabled = op.action === 'disable';
      return null;
    }
    case 'delete': {
      if (!op.key) return '缺少 key 参数';
      const idx = adminConfig.SourceConfig.findIndex((s) => s.key === op.key);
      if (idx === -1) return '源不存在';
      if (adminConfig.SourceConfig[idx].from === 'config') return '该源不可删除';
      adminConfig.SourceConfig.splice(idx, 1);
      return null;
    }
    case 'sort': {
      if (!Array.isArray(op.order)) return '排序列表格式错误';
      const map = new Map(adminConfig.SourceConfig.map((s) => [s.key, s]));
      const newList: typeof adminConfig.SourceConfig = [];
      op.order.forEach((k) => {
        const item = map.get(k);
        if (item) {
          newList.push(item);
          map.delete(k);
        }
      });
      adminConfig.SourceConfig.forEach((item) => {
        if (map.has(item.key)) newList.push(item);
      });
      adminConfig.SourceConfig = newList;
      return null;
    }
    default:
      return '未知操作';
  }
}

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json({ error: '不支持本地存储进行管理员配置' }, { status: 400 });
  }

  try {
    const body = (await request.json()) as Record<string, any>;
    const authInfo = await getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminConfig = await getConfig();
    const storage: IStorage | null = getStorage();

    // 权限：站长或 role=admin 的用户
    if (authInfo.role !== 'owner' && authInfo.username !== process.env.USERNAME) {
      const userEntry = adminConfig.UserConfig.Users.find((u) => u.username === authInfo.username);
      if (!userEntry || userEntry.role !== 'admin') {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
    }

    // 批量：一次读取、一次写入，避免流水线多次读改写造成丢更新
    if (body.action === 'batch') {
      const ops = body.ops as SourceOp[];
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_BATCH_OPS) {
        return NextResponse.json({ error: 'ops 必须为 1-200 条的数组' }, { status: 400 });
      }
      const errors: Array<{ index: number; error: string }> = [];
      ops.forEach((op, index) => {
        if (!op || !ACTIONS.includes(op.action as Action)) {
          errors.push({ index, error: '参数格式错误' });
          return;
        }
        const err = applySourceOp(adminConfig, op);
        if (err) errors.push({ index, error: err });
      });
      if (errors.length === ops.length) {
        return NextResponse.json({ error: '全部操作失败', errors }, { status: 400 });
      }
      if (storage && typeof (storage as any).setAdminConfig === 'function') {
        await (storage as any).setAdminConfig(adminConfig);
      }
      invalidateConfigCache();
      return NextResponse.json(
        { ok: true, applied: ops.length - errors.length, errors },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const action = body.action as Action | undefined;
    if (!action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }
    const err = applySourceOp(adminConfig, body as SourceOp);
    if (err) {
      const status = err === '源不存在' ? 404 : 400;
      return NextResponse.json({ error: err }, { status });
    }

    if (storage && typeof (storage as any).setAdminConfig === 'function') {
      await (storage as any).setAdminConfig(adminConfig);
    }
    invalidateConfigCache();

    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    invalidateConfigCache();
    console.error('视频源管理操作失败:', error);
    return NextResponse.json(
      { error: '视频源管理操作失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
