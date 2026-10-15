/**
 * 安装器:校验过的信封 → 磁盘上的插件目录。
 *
 * 这条路径有**三个**调用方,它们是刻意共用同一份代码的:
 *   - 从市场下载安装(installer 自己下载字节),
 *   - 从本地 .imkpkg.json 文件安装,
 *   - 应用启动时补装内置兜底包(见 bundled.ts)。
 * 内置包也走完整校验,所以「内置」不是一个可以绕过校验的特殊通道 ——
 * 内置包如果坏了,表现与下载到的包坏掉完全一样。
 *
 * 安装永远是「先解到 .staging/,再交给宿主原子就位」。暂存目录只在
 * `host.install()` 成功之后才消失;任何一步抛异常都会把它清掉,
 * 绝不留下半成品目录冒充一个已安装的插件。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { app } from 'electron'
import {
  descriptorFromManifest,
  isNewerVersion,
  LIMITS,
  satisfiesRange,
  type PluginManifest,
  type PluginPermission
} from '@shared/pluginPackage'
import type { MarketProgress, PackagePreview } from '@shared/market'
import type { PluginSource } from '@shared/plugins'
import { checkAgainstCapability, getCapability } from '../plugins/capabilities'
import { getRecord, newStagingDir, safeJoin, cleanupStaging } from '../plugins/installed'
import type { PluginHost } from '../plugins/host'
import { computeIntegrity, verifyEnvelope, type VerifiedPackage } from './verify'

export interface InstallOptions {
  source: PluginSource
  /** 发布者用户名;本地文件安装为 null */
  publisher: string | null
  /** 从哪个市场装的,升级时要去那儿问新版本 */
  registryUrl: string | null
  /** 用户在确认框里实际同意的权限集合(可能大于清单声明的) */
  grantedPermissions: PluginPermission[]
  /** 下载时从响应头拿到的期望 integrity;本地文件安装不传 */
  expectedIntegrity?: string | null
  onProgress?: (p: MarketProgress) => void
}

export interface InstallOutcome {
  id: string
  name: string
  version: string
  /** 是否是一次升级(装之前已存在同 id 的插件) */
  upgraded: boolean
  /** 是否发生了降级安装 */
  downgraded: boolean
}

/**
 * 把一个**未校验**的信封装成插件。
 * 抛出的错误消息是给用户看的中文,直接可以显示在界面上。
 */
export async function installFromEnvelope(
  host: PluginHost,
  raw: unknown,
  opts: InstallOptions
): Promise<InstallOutcome> {
  const report = (p: MarketProgress): void => opts.onProgress?.(p)

  report({ id: '', phase: 'verify', percent: 50, message: '正在校验插件包…' })
  const result = verifyEnvelope(raw, opts.expectedIntegrity)
  if (!result.ok) {
    const message = `插件包校验失败:${result.errors.slice(0, 4).join(';')}`
    report({ id: '', phase: 'error', percent: 100, message: '插件包校验失败', detail: message })
    throw new Error(message)
  }
  const pkg = result.value

  const { id } = pkg.manifest
  const problems = checkAgainstCapability(pkg.manifest)
  if (problems.length > 0) {
    const message = `插件与内置能力不匹配:${problems.join(';')}`
    report({ id, phase: 'error', percent: 100, message: '插件不兼容', detail: message })
    throw new Error(message)
  }
  // 版本要求是同一类事(「结构合法但在这台机器上装不上」),但要说清是版本的问题 ——
  // 把它混进上面那句「与内置能力不匹配」里,用户会去翻能力表,而问题在版本号上
  const engines = checkEngines(pkg.manifest)
  if (engines.length > 0) {
    const message = `插件不兼容:${engines.join(';')}`
    report({ id, phase: 'error', percent: 100, message: '插件不兼容', detail: message })
    throw new Error(message)
  }

  const previous = await getRecord(id)
  const upgraded = Boolean(previous)
  const downgraded = Boolean(previous && isNewerVersion(previous.version, pkg.manifest.version))

  const staged = await extractToStaging(pkg, report)
  try {
    report({ id, phase: 'load', percent: 90, message: '正在加载插件…' })
    await host.install(id, staged, {
      version: pkg.manifest.version,
      integrity: computeIntegrity(pkg.manifest, pkg.envelope.files),
      mainSha256: pkg.mainSha256,
      publisher: opts.publisher,
      source: opts.source,
      registryUrl: opts.registryUrl,
      installedAt: Date.now(),
      grantedPermissions: opts.grantedPermissions
    })
  } catch (err) {
    await cleanupStaging(staged)
    const detail = err instanceof Error ? err.message : String(err)
    report({ id, phase: 'error', percent: 100, message: '插件加载失败', detail })
    throw err instanceof Error ? err : new Error(detail)
  }

  report({
    id,
    phase: 'done',
    percent: 100,
    message: `${pkg.manifest.name} ${pkg.manifest.version} 安装完成`
  })
  return {
    id,
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    upgraded,
    downgraded
  }
}

/**
 * 解包到暂存目录。
 *
 * **manifest.json 由这里写出,而不是包里的一个文件。**
 * 包里的清单只有一份(envelope.manifest),磁盘上的那一份是它的投影 ——
 * 假如包里也带一份 manifest.json,就会出现「两份清单谁说了算」的问题,
 * 而两份不可能永远一致。
 */
async function extractToStaging(
  pkg: VerifiedPackage,
  report: (p: MarketProgress) => void
): Promise<string> {
  const { id } = pkg.manifest
  report({ id, phase: 'extract', percent: 70, message: '正在解包…' })

  const dir = newStagingDir(id)
  await mkdir(dir, { recursive: true })
  try {
    // 清单先写,后面任何一步失败时残留目录里也有能看懂的线索
    await writeFile(
      safeJoin(dir, 'manifest.json'),
      JSON.stringify(pkg.manifest, null, 2),
      'utf8'
    )
    for (const name of Object.keys(pkg.envelope.files)) {
      const buf = Buffer.from(pkg.envelope.data[name] as string, 'base64')
      if (buf.byteLength > LIMITS.fileBytes) throw new Error(`${name} 超过单文件大小上限`)
      const target = safeJoin(dir, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buf)
    }
  } catch (err) {
    await cleanupStaging(dir)
    throw err
  }
  return dir
}

/**
 * 清单里声明的宿主版本要求(`engines.imark`)。
 *
 * 声明了就要有人检查 —— 一个写着 `>=2.0.0` 的插件装在 0.1.0 上,失败会发生在
 * 某个生命周期回调的深处,而那时候用户只会看到一句莫名其妙的运行时报错。
 *
 * 读不到当前版本(`app` 尚未就绪)时**不做判断**:宁可放过一个不兼容的插件,
 * 也不要因为宿主自己读不到版本号就把所有插件判为装不上。
 */
export function checkEngines(manifest: PluginManifest | null | undefined): string[] {
  const range = manifest?.engines?.imark
  if (!range) return []
  let current: string
  try {
    current = app.getVersion()
  } catch {
    return []
  }
  // 版本号读不出来或不成形状时同样放过:compareVersions 会把 `''` 当成 0.0.0,
  // 于是「宿主自己的版本号没拿到」会被翻译成「你装的插件全都太新」—— 那是个
  // 比误装一个插件严重得多的故障。
  if (!/^\d+\.\d+\.\d+/.test(current)) return []
  if (satisfiesRange(current, range)) return []
  return [`这个插件要求 iMark ${range},当前版本是 ${current}`]
}

/** 安装确认框要看到的东西 —— 一次给全,免得界面为了凑齐这些再跑一遍校验 */
export interface PreviewOrigin {
  kind: 'market' | 'local-file' | 'local-dir'
  /** 市场地址 / 文件路径 / 目录路径 */
  label: string
}

/**
 * 生成确认框用的预览。**不落盘**,只是把「将要装什么」说清楚。
 *
 * 权限扩大(新版本要求了本地尚未授权的新权限)是在这里算的,而不是安装时才拦 ——
 * 界面必须在用户按下按钮之前就把这件事摆出来。
 */
/**
 * 「结构合法的包」不等于「装得上的包」:声明式插件可能绑定一个本应用不认识的能力,
 * 或者少配了这个能力要的字段。
 *
 * 这件事要拦在**确认框之前**。让用户读完一整屏权限、勾上「我已了解风险」、按下安装,
 * 再告诉他这个包根本装不上 —— 那不只是白跑一趟:它会让人以为刚才那一眼授权已经生效了。
 *
 * 只读清单,不重跑校验:调用点都已经过了 `previewEnvelope` 的 `ok` 分支。
 */
export function assertInstallable(envelope: unknown): void {
  const manifest = (envelope as { manifest?: PluginManifest } | null)?.manifest
  if (!manifest) return
  const problems = [...checkAgainstCapability(manifest), ...checkEngines(manifest)]
  if (problems.length > 0) throw new Error(`这个插件装不上:${problems.join(';')}`)
}

export function previewEnvelope(
  raw: unknown,
  origin: PreviewOrigin,
  installed?: { version: string; integrity: string; permissions: PluginPermission[] } | null
): { ok: true; value: PackagePreview } | { ok: false; errors: string[] } {
  const result = verifyEnvelope(raw)
  if (!result.ok) return { ok: false, errors: result.errors }
  const { manifest, envelope, mainSha256 } = result.value
  const granted = new Set(installed?.permissions ?? [])
  const required = manifest.permissions ?? []
  return {
    ok: true,
    value: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author ?? null,
      description: manifest.description,
      kind: manifest.kind,
      // 声明式插件要告诉用户「它借的是哪只手」——「不含代码」这句话本身不构成判断依据
      capabilityName: manifest.capability
        ? (getCapability(manifest.capability)?.name ?? null)
        : null,
      permissions: required,
      descriptor: descriptorFromManifest(manifest),
      integrity: envelope.integrity,
      fileCount: Object.keys(envelope.files).length,
      totalBytes: Object.values(envelope.files).reduce((n, f) => n + f.size, 0),
      files: Object.entries(envelope.files)
        .map(([name, meta]) => ({ name, size: meta.size }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      mainSha256,
      installed: installed
        ? { version: installed.version, integrity: installed.integrity }
        : null,
      installedVersion: installed?.version ?? null,
      downgraded: Boolean(installed && isNewerVersion(installed.version, manifest.version)),
      origin: origin.kind,
      originLabel: origin.label,
      // 只在**已经装过**时才谈「新权限」;全新安装时所有权限都是新的,由权限清单本身表达
      newPermissions: installed ? required.filter(p => !granted.has(p)) : []
    }
  }
}
