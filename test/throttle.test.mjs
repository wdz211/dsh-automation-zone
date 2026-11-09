// @ts-check
/**
 * throttle.test.mjs —— 主动开口判定器（掷骰节流曲线）的离线验收。
 *
 * 覆盖四段：
 *   A. 纯函数（峰谷边界 / 跨午夜安静时段 / 命中线公式 / 时机因子）
 *   B. 硬闸顺序（disabled > quiet-hours > cooldown，三种 blocked 都不动记账）
 *   C. 掷骰记账（掷中清零 / 没中 +1，随机数注入到钉死）
 *   D. 状态文件往返（专防 serialize 漏字段把 throttle 节静默写丢）
 *
 * 为什么每条都要能"改坏实现就变红"：
 *   节流曲线最容易错的地方都不是"完全不工作"，而是**看起来在工作但方向反了**——
 *   比如先加加成再乘因子（差一倍）、跨午夜判反、冷却时也把 streak +1。
 *   这类错不会报错，只会让开口频率悄悄变成另一个值，所以断言必须钉死具体数字。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureParentDir, loadImpl, makeLogger, makeTmpDir, parseStateFile, rmTmp } from './_harness.mjs'

const throttleImpl = await loadImpl('throttle')
const storageImpl = await loadImpl('storage')
const toolsImpl = await loadImpl('tools')

/** 本地时区的 Date（与上游同口径：只看本机时区，不换算 UTC）。 */
function at(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

const CWD = makeTmpDir('azone-cwd')
const ZONE_ID = 'session-zone-gate-0001'

// ---------------------------------------------------------------------------
// A. 纯函数
// ---------------------------------------------------------------------------

if (!throttleImpl.ok) {
  test('throttle: 实现缺失（src/throttle.js 必须存在）', () => {
    assert.fail(`找不到 throttle 模块：${throttleImpl.reason}`)
  })
} else {
  const T = throttleImpl.mod
  const D = T.THROTTLE_DEFAULTS
  const { isPeak, isQuietHour, timingFactor, computeLine, lineEquation, decide, normalizeThrottle, normalizeThrottleState } = T

  /** 「开着 + 不启用安静时段 + 不冷却」的基准配置（把干扰项全部归零，只测要测的那条）。 */
  const OPEN = { ...D, enabled: true, quietFrom: 0, quietTo: 0, cooldownMinutes: 0 }

  test('throttle A0: 默认值逐格钉死（字面量，不从 THROTTLE_DEFAULTS 取值比对）', () => {
    // 为什么必须写死数字：`assert.equal(timingFactor(5, D), D.nearFactor)` 这种写法两边都取 `D`，
    // 把默认值从 0.15 改成 0.2 时断言跟着一起变，永远绿——那测的是「D 等于它自己」。
    // 这里每一格都是上游 speak-up 的口径，改任何一格都必须先改这条断言并在 PR 里说明理由。
    assert.deepEqual(
      { ...D },
      {
        enabled: false,
        peakLine: 20,
        valleyLine: 60,
        missBonus: 10,
        bonusCap: 40,
        quietFrom: 1,
        quietTo: 8,
        nearThresholdMinutes: 20,
        nearFactor: 0.15,
        farThresholdMinutes: 360,
        farFactor: 1.5,
        cooldownMinutes: 20,
        intervalMinutes: 30,
        dryRun: true,
      },
      'THROTTLE_DEFAULTS 与上游口径不一致（改默认值必须同步改这条字面量断言）',
    )

    // 再走一遍真实归一化路径：默认值必须是**从 normalizeThrottle(undefined) 里出来的那一份**，
    // 而不是只写在常量里、实际装配时被别处覆盖掉（本机踩过「默认值两处定义」的坑）。
    const clean = normalizeThrottle(undefined)
    assert.equal(clean.peakLine, 20, `峰时命中线默认应为 20，实际 ${clean.peakLine}`)
    assert.equal(clean.valleyLine, 60, `谷时命中线默认应为 60，实际 ${clean.valleyLine}`)
    assert.equal(clean.missBonus, 10, `没中加成默认应为 10，实际 ${clean.missBonus}`)
    assert.equal(clean.bonusCap, 40, `加成上限默认应为 40，实际 ${clean.bonusCap}`)
    assert.equal(clean.nearFactor, 0.15, `近因子默认应为 0.15，实际 ${clean.nearFactor}`)
    assert.equal(clean.farFactor, 1.5, `远因子默认应为 1.5，实际 ${clean.farFactor}`)
    assert.equal(clean.nearThresholdMinutes, 20, `近阈值默认应为 20，实际 ${clean.nearThresholdMinutes}`)
    assert.equal(clean.farThresholdMinutes, 360, `远阈值默认应为 360，实际 ${clean.farThresholdMinutes}`)
    assert.equal(clean.cooldownMinutes, 20, `冷却默认应为 20，实际 ${clean.cooldownMinutes}`)
    assert.equal(clean.quietFrom, 1, `安静起默认应为 1，实际 ${clean.quietFrom}`)
    assert.equal(clean.quietTo, 8, `安静止默认应为 8，实际 ${clean.quietTo}`)
    assert.equal(clean.intervalMinutes, 30, `间隔分钟默认应为 30，实际 ${clean.intervalMinutes}`)
    assert.equal(clean.enabled, false, '判定器默认必须是关的（装上不改变任何既有行为）')
  })

  test('throttle A1: 峰谷边界（周一 09/12/14/18，周末全天谷）', () => {
    // 先自证构造出来的日期就是那几天：周几算错的话下面每条断言都会"通过得莫名其妙"
    assert.equal(at(2026, 10, 26, 9).getDay(), 1, '2026-10-26 不是周一')
    assert.equal(at(2026, 10, 24, 9).getDay(), 6, '2026-10-24 不是周六')
    assert.equal(at(2026, 10, 25, 9).getDay(), 0, '2026-10-25 不是周日')

    assert.equal(isPeak(at(2026, 10, 26, 9, 0)), true, '周一 09:00 应是峰时（含起）')
    assert.equal(isPeak(at(2026, 10, 26, 11, 59)), true, '周一 11:59 应是峰时')
    assert.equal(isPeak(at(2026, 10, 26, 12, 0)), false, '周一 12:00 应是谷时（不含止）')
    assert.equal(isPeak(at(2026, 10, 26, 13, 59)), false, '周一 13:59 应是谷时（午休）')
    assert.equal(isPeak(at(2026, 10, 26, 14, 0)), true, '周一 14:00 应是峰时')
    assert.equal(isPeak(at(2026, 10, 26, 17, 59)), true, '周一 17:59 应是峰时')
    assert.equal(isPeak(at(2026, 10, 26, 18, 0)), false, '周一 18:00 应是谷时')
    assert.equal(isPeak(at(2026, 10, 26, 8, 59)), false, '周一 08:59 应是谷时')

    // 周末直接谷时：周六的 10:00 与周日的 15:00 都在工作日窗口里，但必须是谷时
    assert.equal(isPeak(at(2026, 10, 24, 10, 0)), false, '周六全天应是谷时')
    assert.equal(isPeak(at(2026, 10, 25, 15, 0)), false, '周日全天应是谷时')

    // 不是"只有周一"：周五 10:00 照样峰时
    assert.equal(at(2026, 10, 30, 10).getDay(), 5, '2026-10-30 不是周五')
    assert.equal(isPeak(at(2026, 10, 30, 10, 0)), true, '周五 10:00 应是峰时')
  })

  test('throttle A2: 安静时段跨午夜（23→7 两边都算，起===止不启用）', () => {
    // 跨午夜：起 > 止
    assert.equal(isQuietHour(23, 23, 7), true, '23 点在 23~7 里')
    assert.equal(isQuietHour(0, 23, 7), true, '0 点在 23~7 里（跨午夜的另一半）')
    assert.equal(isQuietHour(6, 23, 7), true, '6 点在 23~7 里')
    assert.equal(isQuietHour(7, 23, 7), false, '7 点是止（不含），不在里')
    assert.equal(isQuietHour(12, 23, 7), false, '12 点不在 23~7 里')
    assert.equal(isQuietHour(22, 23, 7), false, '22 点不在 23~7 里')

    // 不跨午夜：默认的 1~8
    assert.equal(isQuietHour(1, 1, 8), true, '1 点应在 1~8 里')
    assert.equal(isQuietHour(7, 1, 8), true, '7 点应在 1~8 里')
    assert.equal(isQuietHour(8, 1, 8), false, '8 点是止（不含）')
    assert.equal(isQuietHour(0, 1, 8), false, '0 点不在 1~8 里')

    // 起 === 止 = 不启用（否则 0~0 会变成全天静音，很难查）
    assert.equal(isQuietHour(0, 0, 0), false, '起===止 应表示不启用')
    assert.equal(isQuietHour(3, 5, 5), false, '起===止 应表示不启用')
  })

  test('throttle A3: 命中线 = 先乘因子再加加成、夹 0~100、加成封顶', () => {
    // 顺序：60 × 0.15 + 10 = 19。若写成 (60+10) × 0.15 会得到 10.5 —— 差一倍
    const ordered = computeLine({ base: 60, factor: 0.15, streak: 1, missBonus: 10, bonusCap: 40 })
    assert.equal(ordered.bonus, 10, '加成应是 1 × 10')
    assert.equal(ordered.line, 19, '命中线应是 60 × 0.15 + 10 = 19（先乘因子再加加成）')

    // 加成封顶：streak 放大到 20（20 × 10 = 200）也只能加 cap
    const capped = computeLine({ base: 20, factor: 1, streak: 20, missBonus: 10, bonusCap: 40 })
    assert.equal(capped.bonus, 40, '加成必须封顶在 bonusCap=40')
    assert.equal(capped.line, 60, '峰时 20 + 封顶 40 = 60')

    // 上夹 100
    assert.equal(
      computeLine({ base: 60, factor: 1.5, streak: 4, missBonus: 10, bonusCap: 40 }).line,
      100,
      '60 × 1.5 + 40 = 130 应被夹到 100',
    )

    // 下夹 0：**必须用负值入口**，不能用 0×0+0=0（那种输入夹不夹都一样，改坏 clamp 也照样绿）
    assert.equal(
      computeLine({ base: -50, factor: 1, streak: 0, missBonus: 10, bonusCap: 40 }).line,
      0,
      '负 base 必须夹到 0，不许把线算成负数',
    )
    assert.equal(
      computeLine({ base: 60, factor: -2, streak: 0, missBonus: 10, bonusCap: 40 }).line,
      0,
      '负 factor 必须夹到 0',
    )

    // 加成侧三格各自夹 0：这是唯一能**从 bonus 上观测到**这三条兜底的地方
    // （line 会被外层 clamp 兜住，所以只断言 line 抓不到 streak/missBonus/bonusCap 的负值兜底）。
    assert.equal(
      computeLine({ base: 60, factor: 1, streak: -3, missBonus: 10, bonusCap: 40 }).bonus,
      0,
      '负 streak 必须夹到 0（不是拿 -3×10=-30 去减线）',
    )
    assert.equal(
      computeLine({ base: 60, factor: 1, streak: 2, missBonus: -10, bonusCap: 40 }).bonus,
      0,
      '负 missBonus 必须夹到 0',
    )
    assert.equal(
      computeLine({ base: 60, factor: 1, streak: 2, missBonus: 10, bonusCap: -5 }).bonus,
      0,
      '负 bonusCap 必须夹到 0',
    )

    // 脏输入不许把公式算成 NaN，也不许漏出负数
    const dirty = computeLine({ base: 'x', factor: undefined, streak: -3, missBonus: 'y', bonusCap: null })
    assert.equal(Number.isFinite(dirty.line), true, `脏输入算出了非有限数：${dirty.line}`)
    const sweep = [
      { base: -1, factor: -1, streak: -1, missBonus: -1, bonusCap: -1 },
      { base: -1e9, factor: 1e9, streak: 1e9, missBonus: 1e9, bonusCap: 1e9 },
      { base: 60, factor: -0, streak: -0, missBonus: 10, bonusCap: 40 },
      { base: NaN, factor: NaN, streak: NaN, missBonus: NaN, bonusCap: NaN },
      { base: Infinity, factor: -Infinity, streak: 0, missBonus: 10, bonusCap: 40 },
    ]
    for (const input of sweep) {
      const out = computeLine(input)
      assert.equal(Number.isFinite(out.line), true, `脏输入 ${JSON.stringify(input)} 算出了 ${out.line}`)
      assert.ok(out.line >= 0 && out.line <= 100, `脏输入 ${JSON.stringify(input)} 的线值越界：${out.line}`)
      assert.ok(out.bonus >= 0, `脏输入 ${JSON.stringify(input)} 的加成成了负数：${out.bonus}`)
    }
  })

  test('throttle A3b: clamp 的上/下界（直接断言，别退化成单边 Math.min）', () => {
    // 为什么必须直接断：`base/factor/streak/missBonus/bonusCap` 在到达 clamp 之前已经被逐个
    // `Math.max(0, …)` 夹过，所以**线值永远取不到负数** —— 把 clamp 里的下界删成
    // `Math.min(max, …)` 之后，任何 `line` 断言都会照样绿（等价变异）。
    // 所以这里直接钉住 clamp 本身，并且再钉一条它在运行时的**可观测出口**：掷值消毒。
    assert.equal(typeof T.clamp, 'function', 'clamp 必须导出（下界没有别的观测点）')
    assert.equal(T.clamp(-5, 0, 100), 0, '下界必须夹到 0')
    assert.equal(T.clamp(0, 0, 100), 0, '边界 0 保持 0')
    assert.equal(T.clamp(50, 0, 100), 50, '区间内原样返回')
    assert.equal(T.clamp(100, 0, 100), 100, '边界 100 保持 100')
    assert.equal(T.clamp(150, 0, 100), 100, '上界必须夹到 100')

    // 行为层：注入的掷值也要被同一把 clamp 夹住（这是下界在运行时唯一能看见的地方）
    const noon = at(2026, 10, 26, 12)
    assert.equal(
      decide({ cfg: OPEN, now: noon, streak: 0, roll: -0.5 }).roll,
      0,
      '负掷值必须夹到 0（否则 result.roll 会漏出 -0.5，掷点变成 -50）',
    )
    assert.equal(
      decide({ cfg: OPEN, now: noon, streak: 0, roll: 1.7 }).roll,
      1,
      '大于 1 的掷值必须夹到 1（否则掷点会超过 100）',
    )
  })

  test('throttle A4: 时机因子三档 + 拿不到时间按 1，边界严格不等', () => {
    // 期望值一律写字面量（不写 D.nearFactor）：从 D 取值的话，改默认值这条断言会跟着变绿。
    assert.equal(timingFactor(5, D), 0.15, '5 分钟（< 近阈值 20）应走近因子 0.15')
    assert.equal(timingFactor(100, D), 1, '100 分钟在两个阈值之间应走 1')
    assert.equal(timingFactor(400, D), 1.5, '400 分钟（> 远阈值 360）应走远因子 1.5')
    assert.equal(timingFactor(undefined, D), 1, '拿不到距上次说话时必须按 1（不是按近因子）')

    // 边界是严格不等：正好等于阈值都不算
    assert.equal(timingFactor(20, D), 1, '正好 20 分钟不算"近"')
    assert.equal(timingFactor(360, D), 1, '正好 360 分钟不算"远"')

    // 走完整 decide 时也要一致（防止 decide 里又自己写一遍三条 if）
    const noon = at(2026, 10, 26, 12)
    assert.equal(decide({ cfg: OPEN, now: noon, streak: 0, minutesSinceLastUserMessage: 5, roll: 0.99 }).factor, 0.15)
    assert.equal(decide({ cfg: OPEN, now: noon, streak: 0, minutesSinceLastUserMessage: 400, roll: 0.99 }).factor, 1.5)
    assert.equal(decide({ cfg: OPEN, now: noon, streak: 0, roll: 0.99 }).factor, 1)
  })

  test('throttle A5: 人话等式（说清这个数怎么来的）', () => {
    const text = lineEquation({ line: 62, tier: 'valley', base: 60, factor: 1, minutes: 41, bonus: 2 })
    assert.match(text, /^命中线 62\.0 = 谷时 60 × 因子 1\.0/, `等式开头不对：${text}`)
    assert.match(text, /\+ 加成 2\.0/, `加成项应出现：${text}`)
    assert.match(text, /距上次说话 41\.0 分钟/, `距离项应出现：${text}`)

    // 加成为 0 时不写这一项（空着比" + 加成 0.0"干净）
    const noBonus = lineEquation({ line: 9, tier: 'peak', base: 20, factor: 0.45, minutes: undefined, bonus: 0 })
    assert.equal(noBonus.includes('加成'), false, `加成为 0 时不该出现加成项：${noBonus}`)
    assert.match(noBonus, /时间不明/, `拿不到距离时应说"时间不明"：${noBonus}`)

    // 峰时要真的说峰时（别两边写反）
    assert.match(noBonus, /峰时 20/, `峰时那档没写对：${noBonus}`)
  })

  test('throttle A6: 归一化（坏值用兜底、数字夹区间、enabled 只认真布尔）', () => {
    const clean = normalizeThrottle(undefined)
    assert.equal(clean.enabled, false, '判定器默认必须是关的')
    assert.equal(clean.peakLine, 20, `峰时命中线默认必须是字面量 20，实际 ${clean.peakLine}`)

    const clamped = normalizeThrottle({ peakLine: 999, valleyLine: -5, quietFrom: 99, quietTo: -3, cooldownMinutes: 1e9 })
    assert.equal(clamped.peakLine, 100, '峰时命中线必须夹到 100')
    assert.equal(clamped.valleyLine, 0, '谷时命中线必须夹到 0')
    assert.equal(clamped.quietFrom, 23, '安静起必须夹到 23')
    assert.equal(clamped.quietTo, 0, '安静止必须夹到 0')
    assert.equal(clamped.cooldownMinutes, 1440, '冷却必须夹到 1440')

    // 字符串数字要认（YAML 里可能写成 '60'），'false' 这种假值不能被当成开
    assert.equal(normalizeThrottle({ peakLine: '30' }).peakLine, 30, '字符串数字应被接受')
    assert.equal(normalizeThrottle({ enabled: 'false' }).enabled, false, "'false' 不能被当成开着")
    assert.equal(normalizeThrottle({ enabled: 'true' }).enabled, true, "'true' 应被当成开着")

    // 状态节：streak 必须是非负安全整数，时间戳是正整数或 null
    assert.deepEqual(normalizeThrottleState({ streak: -2, lastSpokeAt: 0 }), { streak: 0, lastSpokeAt: null })
    assert.deepEqual(normalizeThrottleState({ streak: 1.5, lastSpokeAt: 'x' }), { streak: 0, lastSpokeAt: null })
    assert.deepEqual(normalizeThrottleState({ streak: 3, lastSpokeAt: 1690000000000 }), {
      streak: 3,
      lastSpokeAt: 1690000000000,
    })
  })

  test('throttle A7: 硬闸顺序（disabled > quiet-hours > cooldown），blocked 一律没掷骰子', () => {
    const night = at(2026, 10, 26, 23)
    const cooldownCfg = { ...D, enabled: true, quietFrom: 23, quietTo: 7, cooldownMinutes: 20 }
    const lastSpokeRecently = night.getTime() - 60_000

    // 1) 总开关关着：即使同时命中安静时段与冷却，也必须报 disabled
    const disabled = decide({
      cfg: { ...cooldownCfg, enabled: false },
      now: night,
      streak: 3,
      lastSpokeAt: lastSpokeRecently,
      roll: 0.01,
    })
    assert.equal(disabled.decision, 'blocked')
    assert.equal(disabled.code, 'disabled', `同时命中三道闸时应先报 disabled，实际 ${disabled.code}`)
    assert.equal(disabled.roll, null, '被硬闸拦下时不该有掷值')

    // 2) 安静时段优先于冷却
    const quiet = decide({ cfg: cooldownCfg, now: night, streak: 3, lastSpokeAt: lastSpokeRecently, roll: 0.01 })
    assert.equal(quiet.code, 'quiet-hours', `安静时段应优先于冷却，实际 ${quiet.code}`)

    // 3) 冷却
    const noon = at(2026, 10, 26, 12)
    const cool = decide({
      cfg: { ...OPEN, cooldownMinutes: 20 },
      now: noon,
      streak: 3,
      lastSpokeAt: noon.getTime() - 5 * 60_000,
      roll: 0.01,
    })
    assert.equal(cool.code, 'cooldown', `5 分钟前刚开过口应报冷却，实际 ${cool.code}`)

    // 4) 冷却过期就该继续掷（不是"开了冷却就永远闭嘴"）
    const warm = decide({
      cfg: { ...OPEN, cooldownMinutes: 20 },
      now: noon,
      streak: 0,
      lastSpokeAt: noon.getTime() - 21 * 60_000,
      roll: 0.2,
    })
    assert.notEqual(warm.decision, 'blocked', '冷却已过必须放行到掷骰')
    assert.equal(warm.code, 'hit')
  })

  test('throttle A7b: 冷却边界（正好等于 cooldownMinutes 必须放行，< 改成 <= 会在这里红）', () => {
    const noon = at(2026, 10, 26, 12) // 谷时，基准线 60；roll 0.2 → 掷中
    const cfg = { ...OPEN, cooldownMinutes: 20 }

    // 正好 20 分钟：`elapsed < 20` 为 false → 放行到掷骰（code 是 hit，不是 cooldown）
    const exact = decide({ cfg, now: noon, streak: 0, lastSpokeAt: noon.getTime() - 20 * 60_000, roll: 0.2 })
    assert.notEqual(exact.code, 'cooldown', `正好 20 分钟应放行，实际 code=${exact.code}`)
    assert.equal(exact.code, 'hit', `正好 20 分钟应一路走到掷骰并掷中，实际 code=${exact.code}`)
    assert.equal(exact.decision, 'speak')

    // 边界两侧各钉一格：19:59.999 仍拦、20:00.001 就放
    const justUnder = decide({ cfg, now: noon, streak: 0, lastSpokeAt: noon.getTime() - (20 * 60_000 - 1), roll: 0.2 })
    assert.equal(justUnder.code, 'cooldown', `19 分 59.999 秒仍应在冷却里，实际 code=${justUnder.code}`)
    const justOver = decide({ cfg, now: noon, streak: 0, lastSpokeAt: noon.getTime() - (20 * 60_000 + 1), roll: 0.2 })
    assert.equal(justOver.code, 'hit', `20 分 0.001 秒应放行，实际 code=${justOver.code}`)

    // cooldownMinutes = 0 = 不冷却（哪怕 1 毫秒前刚开口）
    const off = decide({ cfg: { ...OPEN, cooldownMinutes: 0 }, now: noon, streak: 0, lastSpokeAt: noon.getTime() - 1, roll: 0.2 })
    assert.equal(off.code, 'hit', `cooldownMinutes=0 表示不冷却，实际 code=${off.code}`)
  })

  test('throttle A8: 掷骰口径（掷值 >= 线 → 没中；< 线 → 掷中）', () => {
    const noon = at(2026, 10, 26, 12) // 谷时，基准线 60
    // roll 0.2 → 掷值 20 < 60 → 掷中
    const hit = decide({ cfg: OPEN, now: noon, streak: 0, roll: 0.2 })
    assert.equal(hit.decision, 'speak')
    assert.equal(hit.code, 'hit')
    assert.equal(hit.line, 60)
    assert.equal(hit.roll, 0.2, 'roll 字段应是注入的原始 0~1 随机数')

    // roll 0.99 → 掷值 99 >= 60 → 没中
    const miss = decide({ cfg: OPEN, now: noon, streak: 0, roll: 0.99 })
    assert.equal(miss.decision, 'hold')
    assert.equal(miss.code, 'miss')

    // 边界：掷值正好等于命中线算没中（上游是 >=）
    const edge = decide({ cfg: OPEN, now: noon, streak: 0, roll: 0.6 })
    assert.equal(edge.decision, 'hold', '掷值 == 命中线时应算没中')

    // nextLine 是"如果这次没中，下次线会变成多少" —— 用 streak+1 算
    assert.equal(miss.nextLine, 70, '没中后下次线应是 60 + 10')
  })

  // -------------------------------------------------------------------------
  // B/C/D. 工具层与状态文件（需要 tools + storage 也齐）
  // -------------------------------------------------------------------------

  const ready = toolsImpl.ok && storageImpl.ok

  if (!ready) {
    test('throttle B/C/D: tools 或 storage 未落地，工具层用例跳过', (t) => {
      t.skip(`tools=${toolsImpl.ok} storage=${storageImpl.ok}`)
    })
  } else {
    const toolsMod = toolsImpl.mod
    const storageMod = storageImpl.mod

    /**
     * 造一个绑定到临时状态文件的判定器。
     * 随机数与时钟都一律注入（不掷真随机、不读真钟点）：**断言「命中线是多少」这类
     * 具体数值的用例必须传 `now`**，否则按真实钟点算——09-12 / 14-18 是峰时（基准线 20），
     * 其余是谷时（60），同一个用例上午跑是 50、晚上跑是 90，看起来像实现坏了。
     * 只用「相对现在」的量的用例可以不传（不传就是 Date.now）。
     */
    function makeGate(t, options = {}) {
      const dir = makeTmpDir('azone-gate')
      const file = ensureParentDir(join(dir, 'automation-zone.json'))
      t.after(() => rmTmp(dir))
      storageMod.saveState(file, {
        version: 1,
        zones: { [CWD]: { sessionId: ZONE_ID } },
        throttle: options.throttleState ?? {},
      })
      const logger = makeLogger()
      const sessionController = {
        async inspect() {
          if (options.inspectThrows === true) throw new Error('inspect boom')
          return { meta: { id: ZONE_ID, cwd: CWD }, inheritedEventCount: 0, events: options.events ?? [] }
        },
      }
      const tool = toolsMod.createProactiveGateTool({
        sessionController,
        loadState: () => storageMod.loadState(file, logger),
        stateFile: file,
        log: logger,
        throttle: options.throttle ?? { ...D, enabled: true, quietFrom: 0, quietTo: 0, cooldownMinutes: 0 },
        random: options.random ?? (() => 0.5),
        now: options.now,
      })
      const exec = { agent: { id: ZONE_ID } }
      return {
        tool,
        exec,
        file,
        logger,
        /** 状态文件的 mtime：用来验「被硬闸拦下时连写都没发生」（值相等不代表没写） */
        mtime() {
          return statSync(file).mtimeMs
        },
        /** 读回盘上的 throttle[cwd]（比读内存对象更硬：serialize 漏字段也会被抓到） */
        readEntry() {
          const parsed = parseStateFile(file)
          return (parsed.throttle ?? {})[CWD]
        },
      }
    }

    test('throttle B1: 三种 blocked 都不改动 streak 与 lastSpokeAt（而且根本不写盘）', async (t) => {
      const recent = Date.now() - 60_000
      const seeded = { [CWD]: { streak: 5, lastSpokeAt: recent } }

      // 1) disabled
      {
        const gate = makeGate(t, { throttleState: seeded, throttle: { ...D, enabled: false } })
        const before = gate.mtime()
        const out = await gate.tool.execute({ action: 'check' }, gate.exec)
        assert.equal(out.ok, true)
        assert.equal(out.code, 'disabled')
        assert.equal(out.wrote, false, '被硬闸拦下时不该写盘')
        assert.equal(out.streak, 5, 'disabled 时返回体里的 streak 也必须等于盘上的值（变异：nextStreak 对 blocked 误 +1 时在这里露馅）')
        const entry = gate.readEntry()
        assert.equal(entry.streak, 5, 'disabled 不许改动 streak')
        assert.equal(entry.lastSpokeAt, recent, 'disabled 不许改动 lastSpokeAt')
        assert.equal(gate.mtime(), before, 'disabled 时连写都不该发生（文件 mtime 变了 = 写了）')
      }

      // 2) quiet-hours（把安静时段设成「当前这一小时」，与运行时的钟点无关）
      {
        const hour = new Date().getHours()
        const gate = makeGate(t, {
          throttleState: seeded,
          throttle: { ...D, enabled: true, quietFrom: hour, quietTo: (hour + 1) % 24, cooldownMinutes: 0 },
        })
        const before = gate.mtime()
        const out = await gate.tool.execute({ action: 'check' }, gate.exec)
        assert.equal(out.code, 'quiet-hours', `当前 ${hour} 点应落在安静时段里`)
        assert.equal(out.wrote, false)
        assert.equal(out.streak, 5, 'quiet-hours 时返回体里的 streak 也必须等于盘上的值')
        const entry = gate.readEntry()
        assert.equal(entry.streak, 5, 'quiet-hours 不许改动 streak')
        assert.equal(entry.lastSpokeAt, recent, 'quiet-hours 不许改动 lastSpokeAt')
        assert.equal(gate.mtime(), before, 'quiet-hours 时连写都不该发生')
      }

      // 3) cooldown
      {
        const gate = makeGate(t, {
          throttleState: seeded,
          throttle: { ...D, enabled: true, quietFrom: 0, quietTo: 0, cooldownMinutes: 20 },
        })
        const before = gate.mtime()
        const out = await gate.tool.execute({ action: 'check' }, gate.exec)
        assert.equal(out.code, 'cooldown')
        assert.equal(out.wrote, false)
        assert.equal(out.streak, 5, 'cooldown 时返回体里的 streak 也必须等于盘上的值')
        const entry = gate.readEntry()
        assert.equal(entry.streak, 5, 'cooldown 不许改动 streak')
        assert.equal(entry.lastSpokeAt, recent, 'cooldown 不许改动 lastSpokeAt')
        assert.equal(gate.mtime(), before, 'cooldown 时连写都不该发生')
      }
    })

    test('throttle C1: 掷中清零 / 没中 +1（随机数与时钟都注入到钉死）', async (t) => {
      // 时钟钉在工作日谷时（12:00 → 基准线 60），否则命中线会随真实峰谷变成 20/60
      const valley = at(2026, 10, 26, 12)
      // 掷中：streak 3 → 线 60+30=90；roll 0.2 → 掷值 20 < 90 → speak → streak 0
      const hitGate = makeGate(t, {
        throttleState: { [CWD]: { streak: 3, lastSpokeAt: null } },
        random: () => 0.2,
        now: () => valley.getTime(),
      })
      const hit = await hitGate.tool.execute({ action: 'check' }, hitGate.exec)
      assert.equal(hit.decision, 'speak')
      assert.equal(hit.line, 90, 'streak=3 时命中线应是 90')
      assert.equal(hit.streak, 0, '掷中后连没中必须清零')
      assert.equal(hit.wrote, true)
      assert.equal(hitGate.readEntry().streak, 0, '掷中后盘上的 streak 必须是 0（写回失败会在这里露馅）')

      // 没中：streak 0 → 线 60；roll 0.99 → 掷值 99 >= 60 → hold → streak 1
      const missGate = makeGate(t, {
        throttleState: { [CWD]: { streak: 0, lastSpokeAt: null } },
        random: () => 0.99,
        now: () => valley.getTime(),
      })
      const miss = await missGate.tool.execute({ action: 'check' }, missGate.exec)
      assert.equal(miss.decision, 'hold')
      assert.equal(miss.streak, 1, '没中后连没中必须 +1')
      assert.equal(missGate.readEntry().streak, 1, '没中后盘上的 streak 必须是 1')
    })

    test('throttle C2: record 只动 lastSpokeAt，不动 streak；且冷却立刻生效', async (t) => {
      const gate = makeGate(t, {
        throttleState: { [CWD]: { streak: 2, lastSpokeAt: null } },
        random: () => 0.2,
        throttle: { ...D, enabled: true, quietFrom: 0, quietTo: 0, cooldownMinutes: 20 },
      })
      const recorded = await gate.tool.execute({ action: 'record' }, gate.exec)
      assert.equal(recorded.ok, true)
      assert.equal(recorded.streak, 2, 'record 不许动连没中')
      const entry = gate.readEntry()
      assert.equal(entry.streak, 2, '盘上的 streak 必须还是 2')
      assert.equal(Number.isFinite(entry.lastSpokeAt), true, 'record 必须写下 lastSpokeAt')

      // 记完立刻问门 → 必须被冷却拦住（这正是 record 存在的理由）
      const after = await gate.tool.execute({ action: 'check' }, gate.exec)
      assert.equal(after.code, 'cooldown', `record 之后应立刻进入冷却，实际 ${after.code}`)
    })

    test('throttle C3: 读不到状态文件时拒绝写入（state-unreadable）', async (t) => {
      const gate = makeGate(t, { throttleState: { [CWD]: { streak: 4, lastSpokeAt: null } } })
      // 用「loadState 报 readError」的形态模拟 EACCES / EBUSY：盘上可能有一整份别人的记录
      const guarded = toolsMod.createProactiveGateTool({
        sessionController: { async inspect() { return { meta: { cwd: CWD }, events: [] } } },
        loadState: () => ({ version: 1, zones: {}, throttle: {}, readError: 'EACCES: permission denied' }),
        stateFile: gate.file,
        log: gate.logger,
        throttle: { ...D, enabled: true, quietFrom: 0, quietTo: 0, cooldownMinutes: 0 },
        random: () => 0.2,
      })
      const out = await guarded.execute({ action: 'check' }, gate.exec)
      assert.equal(out.ok, false, '读不到状态文件时必须拒绝，而不是假装判定成功')
      assert.equal(out.code, 'state-unreadable')
      // 盘上原记录必须原样（这里连文件都没被碰过）
      const entry = gate.readEntry()
      assert.equal(entry.streak, 4, '拒绝写入时盘上的 streak 必须原样')
    })

    test('throttle C4: 距上次说话取不到时因子按 1（inspect 抛错也只降级、不失败）', async (t) => {
      const gate = makeGate(t, {
        throttleState: { [CWD]: { streak: 0, lastSpokeAt: null } },
        inspectThrows: true,
        random: () => 0.99,
      })
      // inspect 全挂，所以 cwd 只能用参数兜底（这是既有 resolveCallerCwd 的口径，不是本工具的取舍）
      const out = await gate.tool.execute({ action: 'check', cwd: CWD }, gate.exec)
      assert.equal(out.ok, true, 'inspect 失败不该让判定整体失败')
      assert.equal(out.factor, 1, '拿不到距上次说话时因子必须是 1')
      assert.equal(out.minutesSinceLastUserMessage, undefined)
      // 降级必须留痕（否则"为什么它这么难开口"永远查不出来）
      assert.equal(
        gate.logger.lines.some((line) => line.includes('[warn]') && line.includes('判定器读会话')),
        true,
        `inspect 抛错时应记一条 warn，实际日志：${gate.logger.lines.join(' | ')}`,
      )
    })

    test('throttle C5: 因子真的取到了（user/message 的时间被用上，注入的消息被排掉）', async (t) => {
      const now = Date.now()
      // 最后一条是「插件灌进来的」（source.kind = plugin），倒数第二条才是真人 3 分钟前说的
      const events = [
        { type: 'user/message', time: now - 60 * 60_000, data: { source: { kind: 'user' } } },
        { type: 'assistant/message', time: now - 30_000 },
        { type: 'user/message', time: now - 3 * 60_000, data: { source: { kind: 'user' } } },
        { type: 'user/message', time: now - 1000, data: { source: { kind: 'plugin', pluginId: 'x' } } },
      ]
      const gate = makeGate(t, {
        throttleState: { [CWD]: { streak: 0, lastSpokeAt: null } },
        events,
        random: () => 0.99,
      })
      const out = await gate.tool.execute({ action: 'check' }, gate.exec)
      assert.equal(out.ok, true)
      assert.equal(typeof out.minutesSinceLastUserMessage, 'number', '应当算出距上次说话')
      assert.ok(
        out.minutesSinceLastUserMessage >= 2.5 && out.minutesSinceLastUserMessage <= 3.5,
        `应取真人那条（约 3 分钟），实际 ${out.minutesSinceLastUserMessage}`,
      )
      assert.equal(out.factor, 0.15, `3 分钟 < 20 分钟应走近因子 0.15，实际 ${out.factor}`)
    })

    test('throttle C6: 非法 action / 缺 cwd 一律 {ok:false}，绝不抛', async (t) => {
      const gate = makeGate(t, {})
      const bad = await gate.tool.execute({ action: 'nope' }, gate.exec)
      assert.equal(bad.ok, false)
      assert.equal(bad.code, 'invalid_action')

      // 会话 id 不在状态文件里，但 inspect 能返回 meta.cwd —— 也就是「照常判定成功、cwd 从会话解出来」。
      // （原来的断言是 `typeof missing === 'object'`，而 execute 永远返回对象，所以它恒真、什么都没测。）
      const missing = await gate.tool.execute({ action: 'check' }, { agent: { id: 'session-unknown' } })
      assert.equal(missing.ok, true, `应当照常判定成功，实际 ${JSON.stringify(missing)}`)
      assert.equal(missing.action, 'check', `action 应回显 check，实际 ${JSON.stringify(missing.action)}`)
      assert.equal(missing.cwd, CWD, `cwd 应从会话 inspect 解出 ${CWD}，实际 ${missing.cwd}`)
      assert.equal(
        ['blocked', 'hit', 'miss'].includes(missing.code),
        true,
        `code 必须是判定器的已知取值，实际 ${JSON.stringify(missing.code)}`,
      )
      assert.equal(typeof missing.decision, 'string', `decision 必须是字符串，实际 ${JSON.stringify(missing.decision)}`)

      const noCwd = await toolsMod.createProactiveGateTool({
        sessionController: undefined,
        loadState: () => ({ version: 1, zones: {}, throttle: {} }),
        stateFile: gate.file,
        log: gate.logger,
        throttle: { ...D, enabled: true },
        random: () => 0.5,
      }).execute({ action: 'check' }, {})
      assert.equal(noCwd.ok, false, '没有任何 cwd 来源时必须明确失败')
      assert.equal(noCwd.code, 'no_cwd', `实际 code=${noCwd.code}`)
    })

    test('throttle C7: 状态文件解析失败时必须 state-unreadable 且一个字节都不改（B 的核心）', async (t) => {
      const dir = makeTmpDir('azone-gate')
      const file = ensureParentDir(join(dir, 'automation-zone.json'))
      t.after(() => rmTmp(dir))

      // 一份「别的项目还好好记着」的状态文件，只把结尾截断成坏 JSON（真实故障形态：写一半被杀）
      const healthy = JSON.stringify(
        {
          version: 1,
          zones: {
            'D:\\other-project': { sessionId: 'session-other-0001' },
            [CWD]: { sessionId: ZONE_ID },
          },
          throttle: {
            'D:\\other-project': { streak: 7, lastSpokeAt: 1690000000000 },
            [CWD]: { streak: 2, lastSpokeAt: null },
          },
        },
        null,
        2,
      )
      writeFileSync(file, healthy.slice(0, healthy.length - 12), 'utf8')

      const beforeBytes = readFileSync(file)
      const beforeHash = createHash('sha256').update(beforeBytes).digest('hex')
      const logger = makeLogger()

      const tool = toolsMod.createProactiveGateTool({
        sessionController: { async inspect() { return { meta: { id: ZONE_ID, cwd: CWD }, events: [] } } },
        loadState: () => storageMod.loadState(file, logger),
        stateFile: file,
        log: logger,
        throttle: { ...D, enabled: true, quietFrom: 0, quietTo: 0, cooldownMinutes: 0 },
        random: () => 0.2,
      })
      const exec = { agent: { id: ZONE_ID } }

      // check 与 record 都必须被同一道闸拦住（record 是无条件写盘的，最容易漏）
      for (const action of ['check', 'record']) {
        const out = await tool.execute({ action }, exec)
        assert.equal(out.ok, false, `action=${action}：解析失败时必须拒绝，实际 ${JSON.stringify(out)}`)
        assert.equal(out.code, 'state-unreadable', `action=${action}：必须走 state-unreadable 闸，实际 ${out.code}`)
        assert.match(String(out.message), /parse/i, `action=${action}：文案要带真实原因，实际 ${out.message}`)
        assert.ok(String(out.message).includes(file), `action=${action}：文案要带文件路径，实际 ${out.message}`)
      }

      // 文件必须逐字节没变（改前/改后 sha256 相等）——这就是 B 要防的「整表覆盖」
      const afterBytes = readFileSync(file)
      assert.equal(afterBytes.equals(beforeBytes), true, `坏文件被改写了：${beforeBytes.length}B → ${afterBytes.length}B`)
      assert.equal(
        createHash('sha256').update(afterBytes).digest('hex'),
        beforeHash,
        `坏文件内容变了（sha256 不等）：改前 ${beforeHash}`,
      )
      // 而且真的没写：别的项目那条记录还在盘上（哪怕读不出来）
      assert.ok(afterBytes.toString('utf8').includes('session-other-0001'), '别的项目的记录被写丢了')
      t.diagnostic(`parse 失败时残留字数=${afterBytes.length}B / sha256=${beforeHash.slice(0, 12)}`)
    })

    test('throttle D1: 状态文件往返后 throttle 节仍在（专防 serialize 丢字段）', async (t) => {
      const dir = makeTmpDir('azone-throttle')
      const file = ensureParentDir(join(dir, 'automation-zone.json'))
      t.after(() => rmTmp(dir))

      const lastSpokeAt = 1690000000000
      storageMod.saveState(file, {
        version: 1,
        zones: { [CWD]: { sessionId: ZONE_ID, title: '⚙ 自动化任务' } },
        throttle: { [CWD]: { streak: 2, lastSpokeAt } },
      })

      // 1) 落盘文本里就必须有这一节（serialize 是白名单重建，漏掉它这里立刻为空）
      const onDisk = parseStateFile(file)
      assert.ok(onDisk.throttle && typeof onDisk.throttle === 'object', '落盘的 JSON 里没有 throttle 节')
      assert.equal(onDisk.throttle[CWD]?.streak, 2, '落盘的 streak 丢了')

      // 2) 读回来还在（且 zones 也没被这节挤掉）
      const back = storageMod.loadState(file)
      assert.ok(back.throttle && typeof back.throttle === 'object', 'loadState 没读回 throttle 节')
      assert.equal(back.throttle[CWD]?.streak, 2, '读回的 streak 不对')
      assert.equal(back.throttle[CWD]?.lastSpokeAt, lastSpokeAt, '读回的 lastSpokeAt 不对')
      assert.equal(back.zones[CWD]?.sessionId, ZONE_ID, 'throttle 存在时 zones 不该丢')

      // 3) 只改 zones 的 upsert 不许把 throttle 冲掉（这是同一个坑的第二种形态）
      const afterZone = storageMod.upsertZone(back, 'D:\\other-project', { sessionId: 'session-other' })
      assert.equal(afterZone.throttle?.[CWD]?.streak, 2, 'upsertZone 把 throttle 节丢了')
      storageMod.saveState(file, afterZone)
      const reloaded = storageMod.loadState(file)
      assert.equal(reloaded.throttle?.[CWD]?.streak, 2, 'upsertZone 之后落盘再读，throttle 丢了')
      assert.equal(reloaded.zones['D:\\other-project']?.sessionId, 'session-other', '新 zone 应写入')

      // 4) cwd key 原样保留（不做路径规范化）
      assert.deepEqual(
        Object.keys(reloaded.throttle),
        [CWD],
        `throttle 的 key 被改写了：${JSON.stringify(Object.keys(reloaded.throttle))}`,
      )
    })

    test('throttle D2: emptyState() 必须带 throttle 节（缺了它 serialize 会把这一节静默吞掉）', () => {
      const empty = storageMod.emptyState()
      assert.ok(empty && typeof empty === 'object', 'emptyState 必须返回对象')
      assert.equal('throttle' in empty, true, `emptyState 缺 throttle 键：${JSON.stringify(empty)}`)
      assert.deepEqual(empty.throttle, {}, 'throttle 初始必须是空表（不是 undefined）')
      assert.deepEqual(empty.zones, {}, 'zones 初始必须是空表')
      assert.equal(empty.version, 1, 'emptyState 必须带状态文件版本')
    })

    test('throttle D3: zones 被手改坏时，throttle 里的记账不许跟着丢', async (t) => {
      const dir = makeTmpDir('azone-throttle')
      const file = ensureParentDir(join(dir, 'automation-zone.json'))
      t.after(() => rmTmp(dir))

      // 手改坏的典型形态：zones 被写成字符串，但 throttle 那一节还完好记着 streak。
      // normalizeState 必须**先洗 throttle、再判 zones**，否则这一整节会被一起丢掉。
      const lastSpokeAt = 1690000000000
      writeFileSync(
        file,
        JSON.stringify({ version: 1, zones: 'oops', throttle: { [CWD]: { streak: 3, lastSpokeAt } } }, null, 2),
        'utf8',
      )

      const back = storageMod.loadState(file)
      assert.deepEqual(back.zones, {}, 'zones 坏掉时应退化成空表')
      assert.equal(back.readError, undefined, '结构不对（但能解析）不该带 readError，实际 ' + JSON.stringify(back.readError))
      assert.equal(
        back.throttle?.[CWD]?.streak,
        3,
        `throttle 的 streak 跟着 zones 一起丢了：${JSON.stringify(back.throttle)}`,
      )
      assert.equal(back.throttle?.[CWD]?.lastSpokeAt, lastSpokeAt, 'throttle 的 lastSpokeAt 也丢了')
    })
  }
}
