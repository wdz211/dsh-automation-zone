// @ts-check
/**
 * inspect-cache.test.mjs —— 「会话历史读缓存」的守卫。
 *
 * 被测对象：src/tools.js 的 minutesSinceLastUserMessageOf(sessionController, sessionId, log, nowMs, opts)。
 *
 * 为什么这层必须有测试：缓存是**唯一一个会让「同一个输入算出不同输出」的地方**。它错了不会
 * 抛错，只会让判定器悄悄偏向某一侧。所以每条用例都要能证明「实现被改坏 → 这条变红」：
 *
 *   - 命中必须原样返回缓存时刻的分钟数（若改成按 now 重算 → 结论往「更容易开口」偏）；
 *   - 两种 undefined 不许缓存（若缓存 → 时机因子被按 1 算，而真实值可能 0.15）；
 *   - TTL 可注入且 0 = 每次都真读（否则用例只能靠等 60 秒）；
 *   - 键必须是 sessionId 而不是 cwd（否则两个会话互相串味）；
 *   - Map 必须有上限（否则长期活着就等于内存泄漏）。
 *
 * 时钟全部用注入值（NOW 是 2023 年的时间戳，与真实 now 差着数量级）——任何读裸 Date.now()
 * 的实现都会在这里立刻暴露成「分钟数上万」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeExports, loadImpl, makeLogger } from './_harness.mjs'

const impl = await loadImpl('tools')

const SKIP_REASON = impl.ok
  ? ''
  : `tools: ${impl.reason || '未找到实现'}（可用导出：${impl.ok ? '' : describeExports(impl.mod)}）`

// 任意一个固定时刻，离真实现在极远：读裸 Date.now() 会让分钟数变成六位数。
const NOW = 1_700_000_000_000
const MIN = 60_000
/** 缓存上限（与实现里的 INSPECT_CACHE_MAX 对齐；测试自己写死，防止实现悄悄改大）。 */
const CACHE_MAX = 64

/** 一条真人消息事件（source.kind === 'user' 才算真人，见 isInjectedUserMessage）。 */
function realUserEvent(time) {
  return { type: 'user/message', time, data: { source: { kind: 'user' }, content: 'hi' } }
}

/** 一条被插件注入的 user 角色消息（必须被排掉）。 */
function injectedUserEvent(time) {
  return { type: 'user/message', time, data: { source: { kind: 'plugin', pluginId: 'x' }, content: 'ctx snapshot' } }
}

/** 一条 assistant 消息（不是「用户说话」）。 */
function assistantEvent(time) {
  return { type: 'assistant/message', time, data: { content: 'ok' } }
}

/**
 * sessionController mock：**每次 inspect 都记一笔**，用例的判据全落在这份记录上。
 * @param {(sessionId: string, callNo: number) => any} produce
 */
function makeController(produce) {
  const calls = []
  return {
    calls,
    async inspect(sessionId) {
      calls.push(sessionId)
      return produce(sessionId, calls.length)
    },
  }
}

/** 固定返回同一份报告的 controller */
function fixedController(report) {
  return makeController(() => report)
}

if (!impl.ok) {
  test('inspect-cache: 无法运行，全部用例跳过', (t) => {
    t.skip(SKIP_REASON)
  })
} else {
  const mod = impl.mod
  const missing = ['minutesSinceLastUserMessageOf', 'INSPECT_CACHE_TTL_MS', '__resetInspectCache', '__inspectCacheSize']
    .filter((n) => mod[n] === undefined)
  if (missing.length) {
    test('inspect-cache: 缺少必要导出', (t) => {
      t.skip(`tools: 未导出 ${missing.join(', ')}（可用导出：${describeExports(mod)}）`)
    })
  } else {
    const minutesOf = mod.minutesSinceLastUserMessageOf
    const resetCache = mod.__resetInspectCache
    const cacheSize = mod.__inspectCacheSize
    const log = makeLogger()

    /** 每个用例开头都清一次：缓存是模块级状态，用例之间不许互相污染。 */
    function fresh(produce) {
      resetCache()
      return makeController(produce)
    }

    test('导出形态：TTL 常量是 60 秒，三个测试钩子都是函数', () => {
      assert.equal(typeof mod.INSPECT_CACHE_TTL_MS, 'number', 'INSPECT_CACHE_TTL_MS 必须是数字')
      assert.equal(mod.INSPECT_CACHE_TTL_MS, 60_000, 'INSPECT_CACHE_TTL_MS 默认必须是 60 秒')
      assert.equal(typeof resetCache, 'function', '__resetInspectCache 必须是函数')
      assert.equal(typeof cacheSize, 'function', '__inspectCacheSize 必须是函数')
      assert.equal(typeof minutesOf, 'function', 'minutesSinceLastUserMessageOf 必须导出（便于测试）')
    })

    test('TTL 内连续 3 次（now 每次 +1s）→ inspect 只被调用 1 次，且 3 次返回值完全相同', async () => {
      const ctl = fresh(() => ({ events: [realUserEvent(NOW - 10 * MIN)] }))

      const first = await minutesOf(ctl, 'session-a', log, NOW)
      const second = await minutesOf(ctl, 'session-a', log, NOW + 1_000)
      const third = await minutesOf(ctl, 'session-a', log, NOW + 2_000)

      assert.equal(ctl.calls.length, 1, `TTL 内应当只 inspect 一次（实际 ${ctl.calls.length} 次）`)
      assert.equal(first, 10, `10 分钟前说过话 → 应当正好 10（实得 ${first}；若不是，说明读了真实 Date.now）`)
      assert.equal(second, first, '第二次必须原样返回缓存值')
      assert.equal(third, first, '第三次必须原样返回缓存值')
    })

    test('ttlMs: 0 → 每次都真的 inspect（3 次 → 3 次调用）', async () => {
      const ctl = fresh(() => ({ events: [realUserEvent(NOW - 10 * MIN)] }))

      const a = await minutesOf(ctl, 'session-a', log, NOW, { ttlMs: 0 })
      const b = await minutesOf(ctl, 'session-a', log, NOW + 1_000, { ttlMs: 0 })
      const c = await minutesOf(ctl, 'session-a', log, NOW + 2_000, { ttlMs: 0 })

      assert.equal(ctl.calls.length, 3, `ttlMs=0 时不许复用缓存（实际 inspect ${ctl.calls.length} 次）`)
      assert.ok(b > a && c > b, `关闭缓存后分钟数应当随时钟增长（实得 ${a} / ${b} / ${c}）`)
    })

    test('now 前进超过 TTL（61s）→ 重新 inspect 并返回新值', async () => {
      const ctl = fresh(() => ({ events: [realUserEvent(NOW - 5 * MIN)] }))

      const first = await minutesOf(ctl, 'session-a', log, NOW)
      const second = await minutesOf(ctl, 'session-a', log, NOW + 61_000)

      assert.equal(first, 5, `首次应当是 5 分钟（实得 ${first}）`)
      assert.equal(ctl.calls.length, 2, `超过 TTL 后必须重新 inspect（实际 ${ctl.calls.length} 次）`)
      assert.ok(second > first, `超过 TTL 后应当返回更大的新值（实得 ${first} → ${second}）`)
      assert.ok(Math.abs(second - (5 + 61 / 60)) < 1e-9, `新值应当是 5 + 61/60 分钟（实得 ${second}）`)
    })

    test('两个不同 sessionId → 各自独立 inspect，互不串味', async () => {
      const ctl = fresh((sessionId) => ({
        events: [realUserEvent(sessionId === 'session-a' ? NOW - 2 * MIN : NOW - 30 * MIN)],
      }))

      const a1 = await minutesOf(ctl, 'session-a', log, NOW)
      const b1 = await minutesOf(ctl, 'session-b', log, NOW)

      assert.equal(ctl.calls.length, 2, `不同 sessionId 必须各自 inspect 一次（实际 ${ctl.calls.length} 次）`)
      assert.equal(a1, 2, `session-a 应当是 2 分钟（实得 ${a1}）`)
      assert.equal(b1, 30, `session-b 应当是 30 分钟（实得 ${b1}）`)

      // 再问一次 session-a：必须命中它自己的缓存，不能被 session-b 的读数覆盖。
      const a2 = await minutesOf(ctl, 'session-a', log, NOW + 1_000)
      assert.equal(ctl.calls.length, 2, `两个会话各缓存一条，再问不应新增 inspect（实际 ${ctl.calls.length} 次）`)
      assert.equal(a2, 2, `session-a 复问必须还是它自己的 2 分钟（实得 ${a2}）`)
      assert.equal(cacheSize(), 2, `缓存里应当是 2 条（实得 ${cacheSize()}）`)
    })

    test('inspect 抛错 → 返回 undefined，且下次仍会 inspect（异常不写缓存）', async () => {
      let fail = true
      const ctl = fresh(() => {
        if (fail) {
          const error = new Error('boom')
          error.code = 'session_not_found'
          throw error
        }
        return { events: [realUserEvent(NOW - 7 * MIN)] }
      })

      const first = await minutesOf(ctl, 'session-a', log, NOW)
      assert.equal(first, undefined, 'inspect 抛错时应当返回 undefined')
      assert.equal(ctl.calls.length, 1, '第一次当然要 inspect')
      assert.equal(cacheSize(), 0, `抛错不许写缓存（实得 ${cacheSize()} 条）`)

      const second = await minutesOf(ctl, 'session-a', log, NOW + 1_000)
      assert.equal(second, undefined, '仍然抛错时还是 undefined')
      assert.equal(ctl.calls.length, 2, `上次的失败不许被缓存，必须再 inspect 一次（实际 ${ctl.calls.length} 次）`)

      // 恢复之后必须马上能拿到真值 —— 证明前面那两次 undefined 确实没被记下来。
      fail = false
      const third = await minutesOf(ctl, 'session-a', log, NOW + 2_000)
      // 真值是「事件在 NOW-7min、而这次 now 是 NOW+2s」→ 7 + 2/60 分钟。
      assert.ok(Math.abs(third - (7 + 2 / 60)) < 1e-9, `恢复后应当立刻拿到真值 7+2/60（实得 ${third}）`)
      assert.equal(ctl.calls.length, 3, '恢复后的这次也必须是真读')
    })

    test('inspect 成功但没有真人消息 → 返回 undefined，且下次仍会 inspect（不缓存「此刻没数据」）', async () => {
      let withReal = false
      const ctl = fresh(() => ({
        events: withReal
          ? [injectedUserEvent(NOW - 1 * MIN), assistantEvent(NOW - MIN), realUserEvent(NOW - 3 * MIN)]
          : [injectedUserEvent(NOW - 1 * MIN), assistantEvent(NOW - 2 * MIN)],
      }))

      const first = await minutesOf(ctl, 'session-a', log, NOW)
      assert.equal(first, undefined, '只有注入消息/assistant 消息时应当 undefined（不能被当成「用户刚说话」）')
      assert.equal(cacheSize(), 0, `「此刻没数据」不许写缓存（实得 ${cacheSize()} 条）`)

      const second = await minutesOf(ctl, 'session-a', log, NOW + 1_000)
      assert.equal(second, undefined, '仍然没数据时还是 undefined')
      assert.equal(ctl.calls.length, 2, `上次的 undefined 不许被缓存，必须再 inspect 一次（实际 ${ctl.calls.length} 次）`)

      withReal = true
      const third = await minutesOf(ctl, 'session-a', log, NOW + 2_000)
      // 真值是「事件在 NOW-3min、而这次 now 是 NOW+2s」→ 3 + 2/60 分钟。
      assert.ok(Math.abs(third - (3 + 2 / 60)) < 1e-9, `有真人消息后应当拿到 3+2/60 分钟（实得 ${third}）`)
      assert.equal(ctl.calls.length, 3, '这次也必须是真读')
    })

    test('保守方向守卫：缓存命中的 minutes 不随 now 增长（now 推进 30s 仍与首次完全相同）', async () => {
      const ctl = fresh(() => ({ events: [realUserEvent(NOW - 12 * MIN)] }))

      const first = await minutesOf(ctl, 'session-a', log, NOW)
      const later = await minutesOf(ctl, 'session-a', log, NOW + 30_000)

      assert.equal(ctl.calls.length, 1, '30s 内还在 TTL 里，不该重新 inspect')
      assert.equal(later, first, `命中时不许按 now 重算（实得首次 ${first}、30s 后 ${later}）`)
      // 反过来说：如果哪天有人把它改成 minutes + ageMinutes，这里会实得 12.5。
      assert.ok(
        Math.abs(later - (first + 0.5)) > 1e-9,
        `命中时的返回值里不许混进流逝时间（first=${first}, later=${later} 相差了 30 秒）`,
      )
    })

    test('Map 上限：连续查 100 个不同 sessionId，缓存条目数不超过 64', async () => {
      const ctl = fresh(() => ({ events: [realUserEvent(NOW - 4 * MIN)] }))

      for (let i = 0; i < 100; i++) {
        const value = await minutesOf(ctl, `session-${String(i).padStart(3, '0')}`, log, NOW)
        assert.equal(value, 4, `第 ${i} 个会话应当是 4 分钟（实得 ${value}）`)
      }

      assert.equal(ctl.calls.length, 100, `100 个不同会话都该各读一次（实际 ${ctl.calls.length} 次）`)
      const size = cacheSize()
      assert.ok(size <= CACHE_MAX, `缓存条目数必须 ≤ ${CACHE_MAX}（实得 ${size}）`)
      assert.equal(size, CACHE_MAX, `100 个不同会话之后缓存应当正好装满 ${CACHE_MAX} 条（实得 ${size}）`)
    })

    test('LRU 而不是 FIFO：热点条目被反复命中后不会被新会话挤掉', async () => {
      // 先把缓存灌满 64 条
      const ctl = fresh(() => ({ events: [realUserEvent(NOW - 4 * MIN)] }))
      for (let i = 0; i < CACHE_MAX; i++) {
        await minutesOf(ctl, `session-${String(i).padStart(3, '0')}`, log, NOW)
      }
      assert.equal(cacheSize(), CACHE_MAX, '灌满后应当是 64 条')

      // 反复命中第 0 条（把它刷成最新），再插一条新会话把它挤出淘汰位。
      await minutesOf(ctl, 'session-000', log, NOW + 1_000)
      const afterHit = ctl.calls.length
      await minutesOf(ctl, 'session-new', log, NOW + 1_000)
      assert.equal(ctl.calls.length, afterHit + 1, '新 sessionId 必须真读一次')
      assert.equal(cacheSize(), CACHE_MAX, `插入新会话后仍然应当是 ${CACHE_MAX} 条（实得 ${cacheSize()}）`)

      // 第 0 条刚刚被命中过（移到队尾）→ 仍然在缓存里，不该再 inspect。
      const callsBefore = ctl.calls.length
      await minutesOf(ctl, 'session-000', log, NOW + 2_000)
      assert.equal(ctl.calls.length, callsBefore, '刚被命中过的热点条目不许被淘汰（LRU），这里不该重新 inspect')
    })
  }
}
