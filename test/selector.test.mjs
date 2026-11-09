// @ts-check
/**
 * selector.test.mjs —— 覆盖 CONTRACT.md §2.2 / §3.3 步骤 1 与验收 A5
 * 「六个 selector 里恰好一个，否则 invalid_selector」。
 *
 * 纯内存用例，无文件系统副作用。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  callAny,
  describeExports,
  loadImpl,
  normalizeSelectorResult,
  SEL_KEYS,
  bindSelector,
} from './_harness.mjs'

const impl = await loadImpl('selector')
const bound = impl.ok ? bindSelector(impl.mod) : null

const SKIP_REASON = !impl.ok
  ? `selector: ${impl.reason}`
  : `selector: 未找到可识别的选择器函数（可用导出：${describeExports(impl.mod)}）`

/** 六个 selector 各自的合法样例 */
const SAMPLES = {
  daily: { daily: { time: '09:00', time_zone: 'Asia/Shanghai' } },
  weekly: { weekly: { time: '09:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3, 5] } },
  every_seconds: { every_seconds: 3600 },
  after_seconds: { after_seconds: 600 },
  at: { at: '2026-10-20T09:00:00+08:00' },
  cron: { cron: { expression: '0 9 * * *', time_zone: 'Asia/Shanghai' } },
}

const BASE = { title: '每日巡检', prompt: '跑一遍自检' }

async function evaluate(args) {
  // 实现的调用签名不确定：先按 (args) 调，失败再补一个 ctx 参数重试。
  const outcome = await callAny(bound.fn, [[args], [args, { cwd: 'D:\\proj' }]])
  return normalizeSelectorResult(outcome)
}

function countSelectors(obj) {
  if (!obj || typeof obj !== 'object') return 0
  return SEL_KEYS.filter((k) => k in obj).length
}

// ---------------------------------------------------------------------------

if (!bound) {
  test('selector: 实现未落地/不可识别，4 个用例全部跳过', (t) => {
    t.skip(SKIP_REASON)
  })
} else {
  test('selector: 六个里恰好一个 —— 逐个验证都能通过', async (t) => {
    for (const key of SEL_KEYS) {
      const args = { ...BASE, ...SAMPLES[key] }
      const r = await evaluate(args)

      assert.equal(
        r.ok,
        true,
        `只给 ${key} 时应当通过，实际 ok=${r.ok} code=${r.code ?? '(none)'} raw=${JSON.stringify(r.raw)?.slice(0, 300)}`,
      )
      assert.notEqual(r.code, 'invalid_selector', `只给 ${key} 时不该报 invalid_selector`)

      const n = countSelectors(r.selector)
      assert.equal(n, 1, `${key} 的场景里，结果中应恰好含 1 个 selector 字段，实际 ${n}（${JSON.stringify(r.selector)?.slice(0, 300)}）`)

      const chosen = SEL_KEYS.find((k) => r.selector && k in r.selector)
      assert.equal(chosen, key, `选中的 selector 应该是 ${key}，实际是 ${chosen}`)
      assert.deepEqual(r.selector[chosen], SAMPLES[key][chosen], `${key} 的取值被改写了`)
    }
    t.diagnostic(`六个 selector 全部单选用例通过（${SEL_KEYS.join(', ')}）`)
  })

  test('selector: 零个 —— 返回 invalid_selector', async () => {
    const r = await evaluate({ ...BASE })
    assert.equal(r.ok, false, `没给任何 selector 时不应通过，实际返回 ${JSON.stringify(r.raw)?.slice(0, 300)}`)
    assert.equal(r.code, 'invalid_selector', `没给任何 selector 时应返回 invalid_selector，实际 code=${r.code ?? '(none)'}（${r.raw ?? ''}）`)
  })

  test('selector: 两个 —— 返回 invalid_selector（多组组合都要拦住）', async () => {
    const combos = [
      ['daily', 'weekly'],
      ['weekly', 'every_seconds'],
      ['at', 'cron'],
      ['daily', 'cron'],
    ]
    for (const [a, b] of combos) {
      const args = { ...BASE, ...SAMPLES[a], ...SAMPLES[b] }
      const r = await evaluate(args)
      assert.equal(
        r.ok,
        false,
        `同时给 ${a}+${b} 时不应通过，实际返回 ${JSON.stringify(r.raw)?.slice(0, 300)}`,
      )
      assert.equal(
        r.code,
        'invalid_selector',
        `同时给 ${a}+${b} 时应返回 invalid_selector，实际 code=${r.code ?? '(none)'}（${r.raw ?? ''}）`,
      )
    }
  })

  test('selector: 额外字段被忽略或透传，且不计入 selector 个数', async (t) => {
    // title / prompt 是 §3.3 参数表里的正常字段，foo / unknown_flag 是无关字段。
    const args = {
      ...BASE,
      ...SAMPLES.daily,
      foo: 'bar',
      unknown_flag: true,
      cwd: 'D:\\proj',
    }
    const r = await evaluate(args)

    assert.equal(r.ok, true, `带额外字段时应当仍然通过，实际 ${JSON.stringify(r.raw)?.slice(0, 300)}`)

    const n = countSelectors(r.selector)
    assert.equal(n, 1, `额外字段不得被当成 selector，实际计数 ${n}（${JSON.stringify(r.selector)?.slice(0, 300)}）`)
    assert.ok(r.selector?.daily, '选中的 selector 应保留 daily')
    assert.deepEqual(r.selector.daily, SAMPLES.daily.daily, 'daily 的取值被改写了')

    // 「忽略或透传」都允许：这里只记录实际行为，不做强制断言。
    const extraKept = []
    if (r.selector && 'foo' in r.selector) extraKept.push('foo')
    if (r.selector && 'cwd' in r.selector) extraKept.push('cwd')
    t.diagnostic(`额外字段的实际处理方式：${extraKept.length ? `透传（${extraKept.join(', ')}）` : '忽略'}`)
  })
}
