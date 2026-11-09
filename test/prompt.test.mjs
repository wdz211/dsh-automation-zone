// @ts-check
/**
 * prompt.test.mjs —— 覆盖 CONTRACT.md §2.4 / §3.5 与验收 A8
 * 「注入内容含 { 时，会话仍能正常组装 prompt（不触发插值致死）」。
 *
 * 断言方式：把 dsh-system-prompt 的 interpolate() 扫描器**逐字复刻**到本文件，
 * 把中和后的文本喂进去，要求不抛。这比「用正则近似判断」强得多——它验的是
 * 真实抛错条件本身。
 *
 * 源码依据（本机实测）：
 *   node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:59  VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
 *   同文件 :61  GROUP_AT = /^\{\{([^{}]*)\}\}/
 *   同文件 :153 interpolate() 的循环起点是 text.indexOf("{{") —— **单花括号永不进入扫描器**
 *   :158 group === null 且后面还有 "}}" → throw（malformed）
 *   :166 名字不合法 → throw；:167 变量未注册 → throw；:173 值为 undefined → throw
 *
 * 因此「安全」的准确判据是：中和后不存在任何会命中的 `{{` 起点。
 * 对单花括号 `{cwd}` 判失败是错的——它在框架里是纯字面文本（见下方对照片例）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeExports, loadImpl } from './_harness.mjs'

const impl = await loadImpl('prompt')

// --- 逐字复刻的框架插值器（只用于本文件，不依赖任何外部模块）----------------

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/**
 * @param {string} text
 * @param {Record<string, unknown>} [variables] 默认空表：模拟"什么都没注册"的最坏情况
 * @returns {string}
 */
function frameworkInterpolate(text, variables = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…"`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) throw new Error(`malformed prompt variable reference "{{${name}}}"`)
    if (!Object.hasOwn(variables, name)) throw new Error(`unknown prompt variable "{{${name}}}"`)
    const value = variables[name]
    if (value === undefined) throw new Error(`prompt variable "{{${name}}}" has no value`)
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

function bindNeutralizer(mod) {
  for (const n of ['neutralizeBraces', 'neutralize', 'sanitizeBraces', 'escapeBraces', 'neutralizeText']) {
    if (typeof mod?.[n] === 'function') return { fn: mod[n], name: n }
  }
  if (typeof mod?.default === 'function') return { fn: mod.default, name: 'default' }
  return null
}

const bound = impl.ok ? bindNeutralizer(impl.mod) : null

const SKIP_REASON = !impl.ok
  ? `prompt: ${impl.reason}`
  : `prompt: 未找到可识别的中和函数（可用导出：${describeExports(impl.mod)}）`

/** 去掉全部空白后的可见字符，用于"等价"比较 */
const stripWhitespace = (text) => text.replace(/\s+/g, '')

const CASES = [
  { name: '单个合法变量名（框架里是字面文本，但也要经得住）', text: '任务 {title} 已创建' },
  { name: '双花括号插值组', text: '当前工作区是 {{workspace}}，请检查' },
  { name: '多个变量混排', text: '{{sessionId}} 在 {cwd} 上跑了 {{count}} 次' },
  { name: '正常 JSON 片段', text: '{"a": 1, "b": [2, 3], "nested": {"ok": true}}' },
  { name: '变量名带下划线与数字', text: '{{session_id}} / {zone_2} / {{a1b2}}' },
  { name: '只有左花括号的散文', text: '这里只有一个 { 号，没有闭合' },
  { name: '只有右花括号的散文', text: '这里只有一个 } 号，没有配对' },
  { name: '未闭合的 {{ 后面又有 }}', text: '危险：{{ 中间什么都没有 }} 之后' },
  { name: '三连花括号', text: '{{{deep}}}' },
  { name: '中英文混排 + 变量', text: 'CWD={cwd}；title={{title}}；这是中文说明。' },
]

// ---------------------------------------------------------------------------

if (!bound) {
  test('prompt: 无法运行，5 个用例全部跳过', (t) => {
    t.skip(SKIP_REASON)
  })
} else {
  test(`prompt: 已绑定 neutralizer = ${bound.name}`, (t) => {
    t.diagnostic(bound.name)
  })

  test('prompt: 中和后的文本喂进框架插值器不抛（A8 的因果断言）', async (t) => {
    for (const { name, text } of CASES) {
      const out = await bound.fn(text)
      assert.equal(typeof out, 'string', `${name}：中和结果应为字符串，实际 ${typeof out}`)

      let interpolated
      try {
        interpolated = frameworkInterpolate(out, {})
      } catch (err) {
        assert.fail(
          `${name}：中和后仍会让插值器抛错 → 会话会在每轮 prompt 组装期死掉\n` +
            `  抛错：${err?.message}\n  输入：${JSON.stringify(text)}\n  输出：${JSON.stringify(out)}`,
        )
      }

      // 中和只允许插入空白，所以去掉空白后应当还原成原文
      assert.equal(
        stripWhitespace(interpolated),
        stripWhitespace(text),
        `${name}：可见字符被改变了\n  输入：${JSON.stringify(text)}\n  输出：${JSON.stringify(out)}`,
      )
      t.diagnostic(`${name}: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`)
    }
  })

  test('prompt: 对照片例 —— 未中和的 {{name}} 确实会抛（证明上面的断言有分辨力）', () => {
    // 如果这条不抛，说明复刻的扫描器或判据失效，上面那个"不抛"的断言就没有意义。
    assert.throws(
      () => frameworkInterpolate('当前工作区是 {{workspace}}，请检查', {}),
      /unknown prompt variable|malformed/,
      '未经中和的 {{workspace}} 本应抛错；没抛说明本文件的插值器复刻失效',
    )
    assert.throws(
      () => frameworkInterpolate('危险：{{ 中间什么都没有 }} 之后', {}),
      /malformed/,
      '未闭合的 {{ ... }} 本应抛 malformed；没抛说明复刻失效',
    )
  })

  test('prompt: 中和后不存在完整的 {{name}} 插值组（可读的二次检查）', async () => {
    const groupRe = /\{\{([^{}]*)\}\}/g
    for (const { name, text } of CASES) {
      const out = await bound.fn(text)
      const found = [...out.matchAll(groupRe)].map((m) => m[0])
      assert.deepEqual(found, [], `${name}：中和后仍残留完整插值组 ${JSON.stringify(found)}（输出：${JSON.stringify(out)}）`)
    }
  })

  test('prompt: 单花括号是框架的字面文本，不该被当成危险形态', async (t) => {
    // 源码依据：interpolate() 的循环起点是 text.indexOf("{{")，单个 { 根本不会被看到。
    const text = '任务 {title} 已创建，cwd={cwd}'
    assert.equal(frameworkInterpolate(text, {}), text, '单花括号在框架里应原样返回')

    const out = await bound.fn(text)
    // 允许实现什么都不做（因为确实不需要做），也允许它顺手拆开；两种都安全。
    assert.doesNotThrow(() => frameworkInterpolate(out, {}), '中和结果无论如何都不该让插值器抛错')
    t.diagnostic(`单花括号输入 -> ${JSON.stringify(out)}`)
  })

  test('prompt: 无花括号的文本原样返回（不误伤）', async () => {
    const plain = '自动化任务请用 automation_task_create 工具创建，不要用 schedule_create。'
    const out = await bound.fn(plain)
    assert.equal(out, plain, '不含花括号的文本不应被改动')
  })

  test('prompt: 注入规则文本 + 动态内容一起中和后仍然安全（A8 组合场景）', async (t) => {
    const rule =
      typeof impl.mod.INJECT_RULE_TEXT === 'string'
        ? impl.mod.INJECT_RULE_TEXT
        : typeof impl.mod.INJECT_RULE === 'string'
          ? impl.mod.INJECT_RULE
          : ''
    const dynamic = '\n\n当前 zone：cwd={cwd}，sessionId={{session_id}}，tasks={"count": 2}'
    const combined = `${rule}${dynamic}`

    // 规则正文本身也必须在插值器下安全（它决定 A8 的默认路径）
    assert.doesNotThrow(() => frameworkInterpolate(rule, {}), 'INJECT_RULE_TEXT 本身就让插值器抛错了')

    const out = await bound.fn(combined)
    assert.doesNotThrow(
      () => frameworkInterpolate(out, {}),
      `规则+动态内容组合后仍会让插值器抛错（输出：${JSON.stringify(out)?.slice(0, 400)}）`,
    )
    assert.equal(stripWhitespace(out), stripWhitespace(combined), '组合场景下可见字符被改动')
    t.diagnostic(rule ? `INJECT_RULE_TEXT 长度 ${rule.length}` : '实现未导出规则正文，本用例只验动态部分')
  })
}
