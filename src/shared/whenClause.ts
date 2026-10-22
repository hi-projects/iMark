/**
 * `when` 子句的解析与求值。
 *
 * 支持的是 VS Code when 子句的一个**刻意很小的子集**:
 *
 *   expr      := or
 *   or        := and ( '||' and )*
 *   and       := unary ( '&&' unary )*
 *   unary     := '!' unary | primary
 *   primary   := '(' expr ')' | comparison | value
 *   comparison:= value ( '==' | '!=' ) value
 *   value     := key | string | number | true | false
 *
 * 不支持 `=~`、`in`、`key =~ /re/` 与数组值 —— 这些在 iMark 的贡献点里用不到,
 * 而每多一种语法,主进程就要多一份“如何在扩展未激活时求值”的语义。
 *
 * 求值规则与 VS Code 一致:
 * - 未定义的上下文键视为 false;
 * - 单独的键做真值判断,非空字符串、非零数字、true 为真;
 * - `==` / `!=` 对布尔/数字/字符串做宽松比较(与 VS Code 的 `==` 行为一致)。
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

export interface WhenLiteral {
  type: 'literal'
  value: string | number | boolean
}

export interface WhenKey {
  type: 'key'
  key: string
}

export type WhenValue = WhenLiteral | WhenKey

export type WhenNode =
  | { type: 'or'; left: WhenNode; right: WhenNode }
  | { type: 'and'; left: WhenNode; right: WhenNode }
  | { type: 'not'; value: WhenNode }
  | { type: 'compare'; op: '==' | '!='; left: WhenValue; right: WhenValue }
  | { type: 'truthy'; value: WhenValue }

export interface WhenParseResult {
  ok: boolean
  error?: string
  node?: WhenNode
  /** 表达式里出现过的上下文键(去重,按出现顺序) */
  keys: string[]
}

interface Token {
  type: 'lp' | 'rp' | 'and' | 'or' | 'not' | 'eq' | 'neq' | 'string' | 'number' | 'key' | 'eof'
  value?: string | number
  pos: number
}

function tokenize(input: string): { tokens: Token[]; error?: string } {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(') {
      tokens.push({ type: 'lp', pos: i })
      i += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'rp', pos: i })
      i += 1
      continue
    }
    if (ch === '&') {
      if (input[i + 1] !== '&') return { tokens, error: `位置 ${i}:单个 & 不是运算符(应为 &&)` }
      tokens.push({ type: 'and', pos: i })
      i += 2
      continue
    }
    if (ch === '|') {
      if (input[i + 1] !== '|') return { tokens, error: `位置 ${i}:单个 | 不是运算符(应为 ||)` }
      tokens.push({ type: 'or', pos: i })
      i += 2
      continue
    }
    if (ch === '!') {
      if (input[i + 1] === '=') {
        tokens.push({ type: 'neq', pos: i })
        i += 2
      } else {
        tokens.push({ type: 'not', pos: i })
        i += 1
      }
      continue
    }
    if (ch === '=') {
      if (input[i + 1] !== '=') return { tokens, error: `位置 ${i}:单个 = 不是运算符(应为 ==)` }
      tokens.push({ type: 'eq', pos: i })
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let value = ''
      let closed = false
      i += 1
      while (i < input.length) {
        const c = input[i]!
        if (c === '\\' && i + 1 < input.length) {
          const next = input[i + 1]!
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
          continue
        }
        if (c === quote) {
          closed = true
          i += 1
          break
        }
        value += c
        i += 1
      }
      if (!closed) return { tokens, error: '字符串字面量没有闭合' }
      tokens.push({ type: 'string', value, pos: i })
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const start = i
      i += 1
      while (i < input.length && /[0-9.]/.test(input[i]!)) i += 1
      const value = Number(input.slice(start, i))
      if (!Number.isFinite(value)) return { tokens, error: `位置 ${start}:数字非法` }
      tokens.push({ type: 'number', value, pos: start })
      continue
    }
    if (KEY_RE.test(ch)) {
      const start = i
      i += 1
      while (i < input.length && /[A-Za-z0-9_.-]/.test(input[i]!)) i += 1
      const value = input.slice(start, i)
      tokens.push({ type: 'key', value, pos: start })
      continue
    }
    return { tokens, error: `位置 ${i}:不认识的字符「${ch}」` }
  }
  tokens.push({ type: 'eof', pos: input.length })
  return { tokens }
}

class Parser {
  private index = 0
  readonly keys: string[] = []
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index]!
  }

  private next(): Token {
    const token = this.tokens[this.index]!
    this.index += 1
    return token
  }

  parse(): WhenNode {
    const node = this.parseOr()
    if (this.peek().type !== 'eof') {
      throw new Error(`位置 ${this.peek().pos}:多余的内容`)
    }
    return node
  }

  private parseOr(): WhenNode {
    let left = this.parseAnd()
    while (this.peek().type === 'or') {
      this.next()
      left = { type: 'or', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): WhenNode {
    let left = this.parseUnary()
    while (this.peek().type === 'and') {
      this.next()
      left = { type: 'and', left, right: this.parseUnary() }
    }
    return left
  }

  private parseUnary(): WhenNode {
    if (this.peek().type === 'not') {
      this.next()
      return { type: 'not', value: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): WhenNode {
    if (this.peek().type === 'lp') {
      this.next()
      const node = this.parseOr()
      if (this.peek().type !== 'rp') throw new Error('缺少右括号')
      this.next()
      return node
    }
    const left = this.parseValue()
    const op = this.peek()
    if (op.type === 'eq' || op.type === 'neq') {
      this.next()
      const right = this.parseValue()
      return { type: 'compare', op: op.type === 'eq' ? '==' : '!=', left, right }
    }
    return { type: 'truthy', value: left }
  }

  private parseValue(): WhenValue {
    const token = this.next()
    if (token.type === 'string') return { type: 'literal', value: token.value as string }
    if (token.type === 'number') return { type: 'literal', value: token.value as number }
    if (token.type === 'key') {
      const raw = token.value as string
      if (raw === 'true') return { type: 'literal', value: true }
      if (raw === 'false') return { type: 'literal', value: false }
      if (raw === 'undefined' || raw === 'null') return { type: 'literal', value: false }
      if (!this.keys.includes(raw)) this.keys.push(raw)
      return { type: 'key', key: raw }
    }
    throw new Error(`位置 ${token.pos}:这里需要一个值`)
  }
}

const parseCache = new Map<string, WhenParseResult>()

export function parseWhenClause(input: string | undefined): WhenParseResult {
  const text = (input ?? '').trim()
  if (text.length === 0) {
    return { ok: true, node: { type: 'truthy', value: { type: 'literal', value: true } }, keys: [] }
  }
  const cached = parseCache.get(text)
  if (cached) return cached
  const tokenized = tokenize(text)
  if (tokenized.error) {
    const result: WhenParseResult = { ok: false, error: tokenized.error, keys: [] }
    parseCache.set(text, result)
    return result
  }
  const parser = new Parser(tokenized.tokens)
  try {
    const node = parser.parse()
    const result: WhenParseResult = { ok: true, node, keys: parser.keys }
    parseCache.set(text, result)
    return result
  } catch (error) {
    const result: WhenParseResult = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      keys: parser.keys
    }
    parseCache.set(text, result)
    return result
  }
}

export type WhenContext = Readonly<Record<string, unknown>>

function truthy(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  return Boolean(value)
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return truthy(a) === truthy(b)
  }
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) === Number(b)
  }
  if (a === undefined || b === undefined || a === null || b === null) return false
  return String(a) === String(b)
}

function evaluateValue(value: WhenValue, context: WhenContext): unknown {
  return value.type === 'literal' ? value.value : context[value.key]
}

export function evaluateWhenNode(node: WhenNode, context: WhenContext): boolean {
  switch (node.type) {
    case 'or':
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context)
    case 'and':
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context)
    case 'not':
      return !evaluateWhenNode(node.value, context)
    case 'compare': {
      const equal = looseEqual(evaluateValue(node.left, context), evaluateValue(node.right, context))
      return node.op === '==' ? equal : !equal
    }
    case 'truthy':
      return truthy(evaluateValue(node.value, context))
  }
}

/**
 * 求值一个 when 子句。
 *
 * 解析失败的表达式一律视为 **false**:一个写错的 when 不应该让命令/菜单莫名其妙
 * 地始终可用;清单校验阶段会把解析错误作为警告报给作者。
 */
export function evaluateWhenClause(input: string | undefined, context: WhenContext): boolean {
  const parsed = parseWhenClause(input)
  if (!parsed.ok || !parsed.node) return false
  return evaluateWhenNode(parsed.node, context)
}
