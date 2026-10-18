/**
 * 发布:目录 → 打包 → 预览 → 上传。
 *
 * 预览这一步**必须联网**,这不是偷懒:预览要回答的核心问题是
 * 「这个 id 是不是已经被人占了」「这个版本号是不是已经发过了」,
 * 而这两个答案只有在服务端才有。如果连不上就把它们填成「没有」,
 * 用户会在一个假的前提上按下发布,然后再吃一个 403/409。
 * 与其那样,不如预览阶段就直说连不上 —— 反正发布本来也要联网。
 */

import type { PublishPreview, PublishResult } from '@shared/market'
import { packDirectory } from './pack'
import { publish as upload, detail } from './registry'
import { verifyEnvelope } from './verify'

/**
 * 打包一个目录并生成发布预览。不写盘、不上传。
 * 抛出的错误消息直接可以展示。
 */
export async function previewPublish(dir: string): Promise<PublishPreview> {
  const packed = await packDirectory(dir)

  // 自己打出来的包也要过一遍校验器 —— 打包端与校验端是两份实现,
  // 让它们在这里对一次账,比等服务端回一句「插件包校验失败」再排查强得多
  const verified = verifyEnvelope(packed.envelope)
  if (!verified.ok) {
    throw new Error(`打包结果未通过校验:${verified.errors.slice(0, 4).join(';')}`)
  }
  const { manifest, envelope, mainSha256, renderSha256 } = verified.value

  let existingVersion: string | null = null
  let existingOwner: string | null = null
  let versionExists = false
  let identical = false

  try {
    const remote = await detail(manifest.id)
    existingVersion = remote.version
    existingOwner = remote.publisher
    const same = remote.versions.find(v => v.version === manifest.version)
    versionExists = Boolean(same)
    identical = Boolean(same && same.integrity === envelope.integrity)
  } catch (err) {
    // 404 = 这个 id 还没人发布过,这是最常见的情况,不是错误
    if ((err as { kind?: string }).kind !== 'not-found') throw err
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    mainMode: manifest.main?.mode ?? null,
    hasRender: Boolean(manifest.render),
    capability: manifest.capability ?? null,
    integrity: envelope.integrity,
    mainSha256,
    renderSha256,
    fileCount: packed.files.length,
    totalBytes: packed.totalBytes,
    files: packed.files,
    permissions: manifest.permissions ?? [],
    existingVersion,
    existingOwner,
    versionExists,
    identical
  }
}

/**
 * 真正上传。**重新打包一遍**而不是复用预览时的信封:
 * 预览与上传之间用户可能改了目录里的文件,而复用预览的字节会让
 * 「界面上显示的 sha256」与「传上去的字节」不是同一份 —— 那正是这一步
 * 唯一要保证的事情。
 */
export async function publishDirectory(dir: string): Promise<PublishResult> {
  const packed = await packDirectory(dir)
  return upload(packed.envelope)
}
