/**
 * 源码查看器 —— 在装之前把包里要跑的代码给用户看。
 *
 * 与 README 的区别值得说清楚:README 是**作者写的散文**,详情页是**市场给的元信息**,
 * 而这里是作者真正要执行的那段字节。一个扩展完全可以有漂亮的 README 和一段
 * 顺手读 ~/.ssh 的 main.js,前者不能替代后者。
 *
 * 因此这里刻意不做「另取一份参考源码」这种事:显示的内容与真要装进去的那份
 * **来自同一个下载、过了同一套校验**(validateEnvelope + 逐文件 sha256 + integrity
 * 与响应头比对)。界面上那句「这就是将要在你电脑上跑的东西」才站得住。
 *
 * 数据只在主进程里流转,渲染层拿到的已经是解码后的文本,而且只拿得到文本 ——
 * 二进制文件根本不会出现在结果里。
 */

import type { MarketSource, MarketSourceFile } from '@shared/market'
import { isTextFile, type ExtensionPackageEnvelope } from '@shared/extensionPackage'
import { getRegistryUrl } from './config'
import { detail, fetchEnvelope } from './registry'
import { previewEnvelope } from './installer'

/**
 * 源码查看器里单个文件最多显示多少字节。
 * 入口文件的上限是 8 MiB,一整个塞进 `<pre>` 会让界面卡住;超出的部分截断并明确标注。
 */
const SOURCE_TEXT_BYTES = 256 * 1024

/**
 * 读某个版本包里的文本文件。
 *
 * 版本号是必给的(允许为 null 表示「详情页当前那一版」),而不是用选项对象包起来:
 * 这个参数**必须**传对,包成对象后一个位置参数写错就会静默地退化成「读最新版」——
 * 那正好会让「你以为在读 1.0.0 的源码、其实读到的是 1.2.0」这种事发生。
 */
export async function fetchSource(id: string, version: string | null = null): Promise<MarketSource> {
  const registry = await getRegistryUrl()
  // 下载接口要的是精确版本号,所以 null 得先解析一次 —— 与安装路径的解析方式一致
  // (取详情里的 version,而不是「最新非下架」,免得下架状态下两者指向不同版本)
  const resolved = version ?? (await detail(id)).version

  const fetched = await fetchEnvelope(id, resolved)

  // 与安装路径用**同一个**校验函数:这里放过去的东西,安装时也一定放得过去
  const checked = previewEnvelope(fetched.envelope, { kind: 'market', label: registry }, null)
  if (!checked.ok) {
    throw new Error(`扩展包校验失败:${checked.errors.slice(0, 4).join(';')}`)
  }
  const integrity = checked.value.integrity

  // 响应头说的和自算的对不上,说明路上被换过 —— 那么下面读到的文本也不可信
  if (fetched.integrity && fetched.integrity !== integrity) {
    throw new Error('下载到的扩展包与市场声明的不一致(sha256 对不上),已拒绝显示')
  }

  const envelope = fetched.envelope as ExtensionPackageEnvelope
  const files: MarketSourceFile[] = []
  let truncated = false

  for (const info of checked.value.files) {
    if (!isTextFile(info.name)) continue
    const b64 = envelope.data[info.name] as string | undefined
    if (typeof b64 !== 'string') continue
    const buf = Buffer.from(b64, 'base64')
    // 按字节截断会把多字节字符劈成半个,所以先解码再按字符切,并且只切在安全的地方。
    // 这里的取舍是:宁可少显示一点,也不要在界面上留一串乱码 U+FFFD
    const full = buf.toString('utf8')
    const cut = full.length > SOURCE_TEXT_BYTES
    if (cut) truncated = true
    // 截断处尽量退到最后一个换行(免得把一行代码拦腰截断);一行都没有就只能直接截断
    const breakAt = cut ? full.lastIndexOf('\n', SOURCE_TEXT_BYTES) + 1 : 0
    files.push({
      name: info.name,
      size: info.size,
      text: cut ? full.slice(0, breakAt > 0 ? breakAt : SOURCE_TEXT_BYTES) : full,
      truncated: cut
    })
  }

  return {
    id: checked.value.id,
    // 清单里的版本号才是权威 —— 响应头可能是空的。界面上要显示它,好让用户能核对
    // 「我读到的确实是我想读的那一版」
    version: checked.value.version,
    integrity,
    files,
    truncated
  }
}
