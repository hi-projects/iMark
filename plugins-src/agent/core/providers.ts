/**
 * Agent provider 注册表。
 *
 * provider 不是 Core 的静态依赖，而是同一宿主里的其它扩展：它们在自己的清单里
 * 声明 `contributes["imark.agentProviders"]`，激活后从 `activate()` 返回
 * `{ apiVersion, providers }`。Core 通过 `imark.extensions` 找到并激活它们。
 *
 * 死锁约束：Core 的 `activate()` 绝不能等这张表。注册表在 Core 激活结束前
 * 保持关闭（`list()` 会等待），激活末尾由入口调用 `markReady()`。所有 `list()`
 * 调用都来自命令 / webview 请求 / 会话执行等激活之后才可能发生的路径。
 */

import * as imark from 'imark'
import {
  AGENT_CORE_EXTENSION_ID,
  AGENT_PROVIDERS_CONTRIBUTION,
  AGENT_PROVIDER_API_VERSION,
  type AgentError,
  type AgentProvider,
  type AgentProviderModule
} from '@shared/agentProvider'

export interface ProviderSnapshot {
  providers: AgentProvider[]
  errors: AgentError[]
}

function declaredIds(manifest: imark.ExtensionPackageJSON): string[] {
  const contributes = manifest.contributes
  if (!contributes || typeof contributes !== 'object') return []
  const raw = (contributes as Record<string, unknown>)[AGENT_PROVIDERS_CONTRIBUTION]
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

function asProviderModule(exports: unknown): AgentProviderModule | null {
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return null
  const candidate = exports as Partial<AgentProviderModule>
  if (!Array.isArray(candidate.providers)) return null
  return candidate as AgentProviderModule
}

function usableProvider(value: unknown): value is AgentProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<AgentProvider>
  return (
    Boolean(provider.info) &&
    typeof provider.info?.id === 'string' &&
    typeof provider.detect === 'function' &&
    typeof provider.createSession === 'function'
  )
}

export class ProviderRegistry {
  private readonly ready: Promise<void>
  private resolveReady: (() => void) | null = null

  constructor(private readonly context: imark.ExtensionContext) {
    this.ready = new Promise(resolve => {
      this.resolveReady = resolve
    })
  }

  /** Core 激活结束后调用；此后 list() 不再等待 */
  markReady(): void {
    this.resolveReady?.()
    this.resolveReady = null
  }

  async list(): Promise<ProviderSnapshot> {
    await this.ready
    const providers: AgentProvider[] = []
    const errors: AgentError[] = []
    const seen = new Set<string>()

    for (const ext of imark.extensions.all) {
      if (ext.id === this.context.extension.id) continue
      const declared = declaredIds(ext.packageJSON)
      if (declared.length === 0) continue

      const dependencies = ext.packageJSON.extensionDependencies
      if (!Array.isArray(dependencies) || !dependencies.includes(AGENT_CORE_EXTENSION_ID)) {
        errors.push({
          code: 'config-invalid',
          message: `扩展 ${ext.id} 声明了 ${AGENT_PROVIDERS_CONTRIBUTION}，但没有通过 extensionDependencies 依赖 ${AGENT_CORE_EXTENSION_ID}`
        })
        continue
      }

      try {
        await ext.activate()
      } catch (err) {
        errors.push({
          code: 'provider-unavailable',
          message: `Agent 后端 ${ext.id} 激活失败：${err instanceof Error ? err.message : String(err)}`
        })
        continue
      }

      const module = asProviderModule(ext.exports)
      if (!module) {
        errors.push({
          code: 'protocol-error',
          message: `Agent 后端 ${ext.id} 的 activate() 没有返回 { providers }`
        })
        continue
      }
      if (module.apiVersion !== AGENT_PROVIDER_API_VERSION) {
        errors.push({
          code: 'protocol-error',
          message: `Agent 后端 ${ext.id} 的协议版本不匹配（需要 ${AGENT_PROVIDER_API_VERSION}，实际 ${String(module.apiVersion)}）`
        })
        continue
      }

      for (const value of module.providers) {
        if (!usableProvider(value)) {
          errors.push({
            code: 'protocol-error',
            message: `Agent 后端 ${ext.id} 导出了无效的 provider`
          })
          continue
        }
        const id = value.info.id
        if (!declared.includes(id)) {
          errors.push({
            code: 'config-invalid',
            message: `Agent 后端 ${ext.id} 导出了未声明的 provider「${id}」`
          })
          continue
        }
        if (seen.has(id)) {
          errors.push({
            code: 'config-invalid',
            message: `Agent provider ID「${id}」被多个扩展重复声明`
          })
          continue
        }
        seen.add(id)
        providers.push(value)
      }
    }

    return { providers, errors }
  }
}
