/**
 * 市场安装器:已校验的信封 → 扩展服务。
 *
 * 所有落盘、登记、重载都在 `ExtensionService.installPackage()` 里完成。
 * 这一个文件只负责市场的**外层语义**:
 *   - 把校验/版本要求翻译成用户可以读懂的错误(带进度播报);
 *   - 生成安装确认框的预览;
 *   - 判断这次安装是升级还是降级。
 *
 * 内置包(见 bundled.ts)也走同一条路径 —— 「内置」不是一个可以绕过校验的
 * 特殊通道。
 */

import { app } from 'electron'
import {
  authorNameOf,
  contributesSummaryOf,
  descriptorFromManifest,
  displayNameOf,
  entryFileOf,
  extensionIdOf,
  isNewerVersion,
  type ExtensionManifest
} from '@shared/extensionPackage'
import type { MarketProgress, PackagePreview } from '@shared/market'
import type { ExtensionService } from '../extensions/service'
import { engineProblems } from '../extensions/installer'
import { verifyEnvelope } from './verify'

export interface InstallOptions {
  source: 'bundled' | 'market' | 'local'
  /** 从哪个市场装的,升级时要去那儿问新版本 */
  registryUrl: string | null
  /** 下载时从响应头拿到的期望 integrity;本地文件安装不传 */
  expectedIntegrity?: string | null
  /** 当前应用版本;留空用 app.getVersion()(验收里 Electron 自己报的是运行时版本) */
  appVersion?: string
  onProgress?: (p: MarketProgress) => void
}

export interface InstallOutcome {
  id: string
  name: string
  version: string
  /** 是否是一次升级(装之前已存在同 id 的扩展) */
  upgraded: boolean
  /** 是否发生了降级安装 */
  downgraded: boolean
}

/**
 * 把一个**未校验**的信封装成扩展。
 * 抛出的错误消息是给用户看的中文,直接可以显示在界面上。
 */
export async function installFromEnvelope(
  service: ExtensionService,
  raw: unknown,
  opts: InstallOptions
): Promise<InstallOutcome> {
  const report = (p: MarketProgress): void => opts.onProgress?.(p)

  report({ id: '', phase: 'verify', percent: 40, message: '正在校验扩展包…' })
  const result = verifyEnvelope(raw, opts.expectedIntegrity)
  if (!result.ok) {
    const message = `扩展包校验失败:${result.errors.slice(0, 4).join(';')}`
    report({ id: '', phase: 'error', percent: 100, message: '扩展包校验失败', detail: message })
    throw new Error(message)
  }
  const { manifest } = result.value
  const id = extensionIdOf(manifest)

  // 版本要求是「结构合法但在这台机器上装不上」,要和校验失败分开说 ——
  // 混在一起用户会去翻包内容,而问题在 engines.imark 上
  const currentVersion = opts.appVersion ?? appVersionOrNull()
  const engines = currentVersion ? engineProblems(manifest, currentVersion) : []
  if (engines.length > 0) {
    const message = `扩展不兼容:${engines.join(';')}`
    report({ id, phase: 'error', percent: 100, message: '扩展不兼容', detail: message })
    throw new Error(message)
  }

  report({ id, phase: 'install', percent: 80, message: '正在安装扩展…' })
  const outcome = await service.installPackage(raw, {
    source: opts.source,
    registryUrl: opts.registryUrl,
    expectedIntegrity: opts.expectedIntegrity ?? null,
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {})
  })

  report({
    id,
    phase: 'done',
    percent: 100,
    message: `${displayNameOf(manifest)} ${manifest.version} 安装完成`
  })
  return {
    id,
    name: displayNameOf(manifest),
    version: manifest.version,
    upgraded: outcome.previousVersion !== null,
    downgraded: Boolean(
      outcome.previousVersion && isNewerVersion(outcome.previousVersion, manifest.version)
    )
  }
}

/** 当前应用版本；`app` 尚未就绪时返回 null（此时不做引擎判断） */
function appVersionOrNull(): string | null {
  try {
    return app.getVersion()
  } catch {
    return null
  }
}

/** 安装确认框要看到的东西 —— 一次给全,免得界面为了凑齐这些再跑一遍校验 */
export interface PreviewOrigin {
  kind: 'market' | 'local-file' | 'local-dir'
  /** 市场地址 / 文件路径 / 目录路径 */
  label: string
  /** 市场发布者;本地安装为 null */
  publisher?: string | null
}

/**
 * 「结构合法的包」不等于「装得上的包」:清单可能要求一个新版本。
 *
 * 这件事要拦在**确认框之前**。让用户读完一整屏信息、勾上风险确认、按下安装,
 * 再告诉他这个包根本装不上 —— 那不只是白跑一趟:它会让人以为刚才那一眼授权已经生效了。
 */
export function assertInstallable(envelope: unknown): void {
  const manifest = (envelope as { manifest?: ExtensionManifest } | null)?.manifest
  if (!manifest) return
  const current = appVersionOrNull()
  if (!current) return
  const problems = engineProblems(manifest, current)
  if (problems.length > 0) throw new Error(`这个扩展装不上:${problems.join(';')}`)
}

/**
 * 生成确认框用的预览。**不落盘**,只是把「将要装什么」说清楚。
 */
export function previewEnvelope(
  raw: unknown,
  origin: PreviewOrigin,
  installed?: { version: string; integrity: string } | null
): { ok: true; value: PackagePreview } | { ok: false; errors: string[] } {
  const result = verifyEnvelope(raw)
  if (!result.ok) return { ok: false, errors: result.errors }
  const { manifest, envelope, mainSha256 } = result.value
  const descriptor = descriptorFromManifest(manifest)
  return {
    ok: true,
    value: {
      id: descriptor.id,
      name: descriptor.displayName,
      displayName: descriptor.displayName,
      version: manifest.version,
      author: authorNameOf(manifest),
      description: manifest.description ?? '',
      publisher: origin.publisher ?? null,
      descriptor,
      hasMain: Boolean(entryFileOf(manifest)),
      main: manifest.main ?? null,
      activationEvents: [...(manifest.activationEvents ?? [])],
      capabilities: { ...(manifest.capabilities ?? {}) },
      contributesSummary: contributesSummaryOf(manifest),
      integrity: envelope.integrity,
      fileCount: Object.keys(envelope.files).length,
      totalBytes: Object.values(envelope.files).reduce((n, f) => n + f.size, 0),
      files: Object.entries(envelope.files)
        .map(([name, meta]) => ({ name, size: meta.size }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      mainSha256,
      installed: installed ? { version: installed.version, integrity: installed.integrity } : null,
      downgraded: Boolean(installed && isNewerVersion(installed.version, manifest.version)),
      origin: origin.kind,
      originLabel: origin.label
    }
  }
}
