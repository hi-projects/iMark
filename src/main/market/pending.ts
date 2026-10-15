/**
 * 「待确认的安装」暂存区。
 *
 * 为什么要有它:确认框显示的东西(清单、权限、体积、sha256)与最终装进去的东西
 * 必须是**同一份字节**。如果让渲染层先把包读出来展示、再把路径传回来安装,
 * 中间就有两个窗口:文件可能被换掉;而且渲染层还能传一个它自己编的路径,
 * 让主进程去读任意文件。
 *
 * 所以流程是:主进程读包 → 校验 → 算好预览 → 发一个**随机令牌**给渲染层展示;
 * 用户点确认时只回传令牌,主进程按令牌取回那份已经校验过的信封。
 * 渲染层从头到尾没碰过字节,也没机会指定路径。
 *
 * 令牌一次性、5 分钟过期、进程内存储(不落盘)。
 */

import { randomBytes } from 'node:crypto'
import type { PluginSource } from '@shared/plugins'

/** 待安装项的有效期:用户可能对着确认框想很久,但不能无限期挂着 */
const TTL = 5 * 60_000

interface Pending {
  envelope: unknown
  source: PluginSource
  publisher: string | null
  registryUrl: string | null
  /** 下载时从市场拿到的期望 integrity;本地文件为 null */
  expectedIntegrity: string | null
  createdAt: number
}

const pending = new Map<string, Pending>()

function sweep(): void {
  const now = Date.now()
  for (const [token, item] of pending) {
    if (now - item.createdAt > TTL) pending.delete(token)
  }
}

export function putPending(item: Omit<Pending, 'createdAt'>): string {
  sweep()
  const token = randomBytes(16).toString('base64url')
  pending.set(token, { ...item, createdAt: Date.now() })
  return token
}

/** 取出并**消费**令牌:确认框只能点一次 */
export function takePending(token: string): Pending | null {
  sweep()
  const item = pending.get(token)
  if (!item) return null
  pending.delete(token)
  return item
}

/** 用户点「取消」:不消费也要清掉,免得留在内存里 */
export function dropPending(token: string): void {
  pending.delete(token)
}
