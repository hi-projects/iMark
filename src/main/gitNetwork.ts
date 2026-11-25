/**
 * 应用级的 git 网络能力:读代理设置、准备 `-c http.proxy=…` 参数、检测代理。
 *
 * 这是**应用**的能力,不是某个扩展的私有实现:
 * - 仓库选择页的「从远端克隆」在主进程里直接调用;
 * - 「远程同步」扩展通过 `imark.git.networkSetup()` / `imark.git.detectProxy()`
 *   向宿主请求,宿主转到这里。
 *
 * 两边必须走同一套规则,否则会出现「同步能连、克隆却超时」这种无解的现象。
 * 代理设置仍然沿用扩展设置页里的「网络代理」字段(用户只看到一份配置),克隆
 * 也读同一份;扩展被禁用/卸载时退回自动检测。
 */

import type { GitNetworkSetup, GitProxyConfig, GitProxyReport } from '@shared/extensionApi'
import type { Settings } from '@shared/types'
import { detectSystemProxy, normalizeProxyUrl, probeProxy, proxyForUrl, redactUrl } from './gitProxy'
import { loadSettings } from './settings'

/** 与扩展清单里的 publisher.name 一致 */
const GIT_SYNC_EXTENSION = 'imark.git-sync'
/** 与扩展清单 `imark.git-sync.proxyUrl` 的默认值一致 */
const DEFAULT_PROXY_URL = 'http://127.0.0.1:7890'

interface ResolvedProxyConfig {
  mode: 'auto' | 'manual'
  proxyUrl: string
}

/** 从应用设置里取出「网络代理」的两项;缺失时按扩展声明的默认值 */
export function readProxySettings(settings: Settings | null): ResolvedProxyConfig {
  const config = settings?.extensions?.[GIT_SYNC_EXTENSION]?.config ?? {}
  const mode: 'auto' | 'manual' =
    config[`${GIT_SYNC_EXTENSION}.proxyMode`] === 'manual' ? 'manual' : 'auto'
  const raw = config[`${GIT_SYNC_EXTENSION}.proxyUrl`]
  return { mode, proxyUrl: typeof raw === 'string' ? raw : DEFAULT_PROXY_URL }
}

/**
 * 扩展传来的是它设置里的两项;没传(克隆)就读应用设置。
 *
 * 显式传 `proxyUrl: ''` 表示「手动模式但地址为空」,按直连处理,不能把它
 * 当成「没传」而回退到默认地址。
 */
async function resolveConfig(
  config: GitProxyConfig | null | undefined,
  settings: Settings | null | undefined
): Promise<ResolvedProxyConfig> {
  if (config) {
    return {
      mode: config.mode === 'manual' ? 'manual' : 'auto',
      proxyUrl: typeof config.proxyUrl === 'string' ? config.proxyUrl : DEFAULT_PROXY_URL
    }
  }
  return readProxySettings(settings ?? (await loadSettings()))
}

/** 自动模式需要探测代理时用的协议;SSH / 本地路径返回 null,不必白跑一次查询 */
function schemeOf(url: string): 'http' | 'https' | null {
  if (/^https:/i.test(url.trim())) return 'https'
  if (/^http:/i.test(url.trim())) return 'http'
  return null
}

/**
 * 为一次 git 网络操作准备代理参数。
 *
 * auto 模式只对 HTTP(S) 地址探测;SSH / 本地路径(如 harness 里的 file://)
 * 没有 HTTP 代理可走,直接直连。
 */
export async function gitNetworkSetup(
  url: string,
  config?: GitProxyConfig | null,
  settings?: Settings | null
): Promise<GitNetworkSetup> {
  const cfg = await resolveConfig(config, settings)

  let detected = null
  if (cfg.mode === 'manual') {
    const normalized = normalizeProxyUrl(cfg.proxyUrl)
    if (normalized) detected = { url: normalized, source: '扩展设置', bypass: [] }
  } else {
    const scheme = schemeOf(url)
    if (scheme) detected = await detectSystemProxy(scheme)
  }

  const effective = proxyForUrl(url, detected)
  if (!effective) {
    // 没有可用代理就直连;显式清空,避免宿主环境里的 HTTP_PROXY 又被 git 捡起来。
    return {
      args: ['-c', 'http.proxy='],
      env: { NO_PROXY: '*', no_proxy: '*' },
      proxyUrl: null,
      proxySource: null
    }
  }

  const env: Record<string, string> = {}
  if (detected && detected.bypass.length > 0) {
    const bypass = detected.bypass.join(',')
    env.NO_PROXY = bypass
    env.no_proxy = bypass
  }
  return {
    args: ['-c', `http.proxy=${effective}`],
    env,
    proxyUrl: redactUrl(effective),
    proxySource: detected?.source ?? null
  }
}

/** auto 模式实际检查了哪些来源(给用户看的说明,平台相关) */
function checkedSources(): string {
  if (process.platform === 'win32') return '环境变量与 Windows 系统代理'
  if (process.platform === 'linux') return '环境变量与 GNOME 系统代理'
  return '环境变量'
}

/**
 * 「检测代理」应用能力:只探测、不改设置,结果交给扩展决定怎么展示。
 *
 * - 手动模式地址无法识别时返回 `invalidManualUrl`(原样,未脱敏前的字符串);
 * - `reachable` 只在检测到代理时有意义:null = 没有代理可测。
 */
export async function detectProxyReport(
  config?: GitProxyConfig | null,
  settings?: Settings | null
): Promise<GitProxyReport> {
  const cfg = await resolveConfig(config, settings)

  if (cfg.mode === 'manual') {
    const url = normalizeProxyUrl(cfg.proxyUrl)
    if (!url) {
      return {
        mode: 'manual',
        invalidManualUrl: cfg.proxyUrl.trim(),
        proxyUrl: null,
        proxySource: null,
        reachable: null,
        checked: '扩展设置'
      }
    }
    return {
      mode: 'manual',
      proxyUrl: redactUrl(url),
      proxySource: '扩展设置',
      reachable: await probeProxy(url),
      checked: '扩展设置'
    }
  }

  // 大多数远端是 HTTPS,先按它探;没有再按 HTTP 探(只设了 HTTP_PROXY 的情况)
  const found = (await detectSystemProxy('https')) ?? (await detectSystemProxy('http'))
  if (!found) {
    return {
      mode: 'auto',
      proxyUrl: null,
      proxySource: null,
      reachable: null,
      checked: checkedSources()
    }
  }
  return {
    mode: 'auto',
    proxyUrl: redactUrl(found.url),
    proxySource: found.source,
    reachable: await probeProxy(found.url),
    checked: checkedSources()
  }
}
