/**
 * 扩展的外部设置字段:按清单声明的 JSON 指针读写包外配置文件。
 *
 * 渲染层只提交「扩展 ID + 字段短键」;文件、指针、环境变量替换规则全部来自
 * 已安装扩展的清单。这样设置表单能直接编辑 `~/.claude/settings.json` 这类
 * CLI 自己的配置文件,又不会把任意路径的读写能力暴露给渲染层。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { extensionIdOf, flattenConfiguration, type ExtensionManifest } from '@shared/extensionPackage'
import { writeFileAtomic } from '../files'
import { readManifestAt } from './installedStore'
import { extensionDir, isValidExtensionId } from './paths'

interface ExternalTarget {
  file: string
  pointer: string
  dirEnv?: string
  secret?: boolean
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function targetOfManifest(manifest: ExtensionManifest, fieldKey: string): ExternalTarget | null {
  const id = extensionIdOf(manifest)
  const found = flattenConfiguration(manifest).find(item => item.key === `${id}.${fieldKey}`)
  const meta = found?.property.imark
  if (
    !meta ||
    meta.kind !== 'external' ||
    typeof meta.file !== 'string' ||
    typeof meta.pointer !== 'string'
  ) {
    return null
  }
  return {
    file: meta.file,
    pointer: meta.pointer,
    ...(meta.dirEnv !== undefined ? { dirEnv: meta.dirEnv } : {}),
    ...(meta.secret !== undefined ? { secret: meta.secret } : {})
  }
}

async function targetOf(id: unknown, key: unknown): Promise<ExternalTarget> {
  if (!isValidExtensionId(id)) throw new Error('扩展 ID 不合法')
  if (typeof key !== 'string' || !key) throw new Error('设置字段不合法')
  const manifest = await readManifestAt(extensionDir(id))
  if (!manifest) throw new Error('扩展未安装')
  const target = targetOfManifest(manifest, key)
  if (!target) throw new Error('这个字段不是外部设置')
  return target
}

function inside(root: string, path: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const a = normalize(root)
  const b = normalize(path)
  return b === a || b.startsWith(`${a}${sep}`)
}

/** 展开 `~`;清单声明了 dirEnv 且环境变量存在时,用它替换文件的父目录 */
function resolveFile(target: ExternalTarget): string {
  const home = resolve(homedir())
  const envDir = target.dirEnv ? process.env[target.dirEnv] : undefined
  if (envDir && envDir.trim()) {
    const root = resolve(envDir)
    return join(root, basename(target.file))
  }
  const tilde = target.file === '~' || target.file.startsWith('~/') || target.file.startsWith('~\\')
  const path = tilde ? resolve(home, target.file.slice(2)) : resolve(target.file)
  if (!inside(home, path)) throw new Error('外部设置文件必须在用户目录内')
  return path
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/') || pointer === '/') throw new Error('JSON 指针不合法')
  const parts = pointer
    .slice(1)
    .split('/')
    .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (parts.some(part => !part || FORBIDDEN_KEYS.has(part))) throw new Error('JSON 指针不合法')
  return parts
}

function readPointer(root: Record<string, unknown>, parts: string[]): string {
  let current: unknown = root
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return ''
    current = (current as Record<string, unknown>)[part]
  }
  if (typeof current === 'string') return current
  if (typeof current === 'number' || typeof current === 'boolean') return String(current)
  return ''
}

function writePointer(root: Record<string, unknown>, parts: string[], value: string): void {
  let current: Record<string, unknown> = root
  for (const part of parts.slice(0, -1)) {
    const next = current[part]
    if (next === undefined) current[part] = {}
    else if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`设置文件的 ${part} 不是对象，未修改`)
    }
    current = current[part] as Record<string, unknown>
  }
  const key = parts[parts.length - 1]!
  if (value === '') delete current[key]
  else current[key] = value
}

async function loadJson(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`读取设置文件失败：${path}`)
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`设置文件不是合法 JSON，未修改：${path}`)
  }
}

export async function readExternalSetting(id: unknown, key: unknown): Promise<string> {
  const target = await targetOf(id, key)
  const path = resolveFile(target)
  const parts = pointerParts(target.pointer)
  const root = await loadJson(path)
  return readPointer(root, parts)
}

export async function writeExternalSetting(
  id: unknown,
  key: unknown,
  value: unknown
): Promise<void> {
  const target = await targetOf(id, key)
  const path = resolveFile(target)
  const parts = pointerParts(target.pointer)
  if (typeof value !== 'string') throw new Error('设置值必须是字符串')
  const root = await loadJson(path)
  writePointer(root, parts, value)
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, `${JSON.stringify(root, null, 2)}\n`)
}

/**
 * 用系统默认程序打开外部设置文件。
 *
 * 文件可能还没被写过:先落一个空 JSON,免得 openPath 返回「文件不存在」,
 * 让用户以为扩展坏了。
 */
export async function openExternalSettingFile(id: unknown, key: unknown): Promise<void> {
  const target = await targetOf(id, key)
  const path = resolveFile(target)
  await mkdir(dirname(path), { recursive: true })
  if (!existsSync(path)) await writeFile(path, '{}\n', 'utf8')
  const problem = await shell.openPath(path)
  if (problem) throw new Error(`打开设置文件失败：${problem}`)
}
