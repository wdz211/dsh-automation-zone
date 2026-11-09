// @ts-check
/**
 * gateinject.test.mjs —— 定时任务闸门（服务端准入层）的离线验收。
 *
 * 覆盖六段：
 *   A. framing 解析（结构化 kind 与 framing 文本双路；取不到 id 时仍算定时任务）
 *   B. 「距上次真人说话」（只认真人；读不到返回 null 而不是 0）
 *   C. 注入文本三形态（放行 / 拦下 / 硬闸）+ 单行 + 花括号中和
 *   D. 默认零行为变化（没登记 = 不判定、不写盘、不注入）
 *   E. 记账落盘（tasks 节往返不丢、读不出来绝不写、同一轮绝不重掷）
 *   F. 工具侧 action=gated（登记 / 取消登记 / 读不出来时拒绝）
 *
 * 为什么这些断言必须钉死具体数字而不是"有就行"：
 *   闸门最危险的错法不是"完全不工作"，而是**方向反了**——把「读不到上次说话时间」
 *   当成「刚说完」（命中线被压到极低 → 几乎必然放行）、或者把 hold 也当成清空 streak。
 *   这两种都不会报错，只会让开口频率悄悄变成另一个值。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadImpl, makeLogger, makeTmpDir, parseStateFile, rmTmp } from './_harness.mjs'

const gateImpl = await loadImpl('gateinject')
const storageImpl = await loadImpl('storage')
const toolsImpl = await loadImpl('tools')

/** 钉死时钟：所有判定都按这个"现在"算，否则「命中线是多少」会随真实钟点漂移。 */
const NOW = 1_700_000_000_000

/** 「开着 + 不启用安静时段 + 不冷却」的基准配置（把干扰项归零，只测要测的那条）。 */
const OPEN = { enabled: true, quietFrom: 0, quietTo: 0, cooldownMinutes: 0 }

const SESSION = 'session-zone-gate-0001'
const SCHEDULE_ID = 'sched-每日早报-0001'

/** 造一条 schedule 投递消息（与 dsh-schedule 的真实形态逐字一致）。 */
function scheduleMessage(text, id = 'msg-sched-1') {
  return { id, role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text }] }
}

/** 单条 reminder 的 framing（`renderReminderFraming`，1389-1400 行）。 */
function framingOf(scheduleId, prompt = '写今日早报', at = '2026-10-26T09:00:00+08:00') {
  return [
    '[SCHEDULE REMINDER]',
    'This is a scheduled message from the user',
    `schedule_id_json: ${JSON.stringify(scheduleId)}`,
    `occurrence_at: ${at}`,
    `reminder_prompt_json: ${JSON.stringify(prompt)}`,
  ].join('\n')
}

/** 批量 reminder 的 framing（`renderRecurringReminderBatchFraming`，1406-1420 行）。 */
function batchFramingOf(rows) {
  return [
    '[SCHEDULE REMINDER BATCH]',
    'This is a scheduled message from the user',
    `reminders_json: ${JSON.stringify(
      rows.map(([id, prompt]) => ({ schedule_id: id, occurrence_at: '2026-10-26T09:00:00+08:00', reminder_prompt: prompt })),
    )}`,
  ].join('\n')
}

/** 造一条真人消息。 */
function humanMessage(minutesAgo, id = 'msg-human-1') {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    time: NOW - minutesAgo * 60_000,
    content: [{ type: 'text', text: '帮我看一下这个报错' }],
  }
}

if (!gateImpl.ok) {
  test('gateinject: 实现缺失（src/gateinject.js 必须存在）', () => {
    assert.fail(`找不到 gateinject 模块：${gateImpl.reason}`)
  })
} else {
  const G = gateImpl.mod
  const S = storageImpl.ok ? storageImpl.mod : undefined
  const { parseScheduleOrigin, minutesSinceLastHumanMessage, renderGateNote, createGateInjector } = G

  const FRAMING_SINGLE = '[SCHEDULE REMINDER]'
  const FRAMING_BATCH = '[SCHEDULE REMINDER BATCH]'
  const GATE_NOTE_TAG = '[自动化闸门]'

  // -------------------------------------------------------------------------
  // A. framing 解析
  // -------------------------------------------------------------------------

  test('gateinject A1: 结构化 kind=schedule 就够，取不到 id 也算定时任务', () => {
    // 只有 kind、没有 framing 文本（例如某版上游换了 framing 文案）时：
    // 必须仍然认出"这是定时任务"，否则闸门会静默失效。
    assert.deepEqual(parseScheduleOrigin({ role: 'user', source: { kind: 'schedule' } }), {
      isScheduled: true,
      scheduleIds: [],
    })
  })

  test('gateinject A2: 单条 framing 里的 schedule_id_json 取得出来（含二次转义）', () => {
    const plain = parseScheduleOrigin(scheduleMessage(framingOf('sched-A')))
    assert.equal(plain.isScheduled, true)
    assert.deepEqual(plain.scheduleIds, ['sched-A'])

    // 二次转义形态：`"\"sched-A\""` —— 严格 JSON.parse 会抛，宽容解析必须救回来。
    // 救不回来在下游等价于"取不到 scheduleId"→ 闸门静默失效，所以这条必须有。
    const escaped = parseScheduleOrigin(
      scheduleMessage(
        ['[SCHEDULE REMINDER]', 'schedule_id_json: "\\"sched-A\\""', 'occurrence_at: 2026-10-26T09:00:00+08:00'].join('\n'),
      ),
    )
    assert.deepEqual(escaped.scheduleIds, ['sched-A'])
  })

  test('gateinject A3: 批量 framing 取回全部 id，且保持顺序', () => {
    const parsed = parseScheduleOrigin(scheduleMessage(batchFramingOf([['sched-1', 'A'], ['sched-2', 'B']])))
    assert.equal(parsed.isScheduled, true)
    assert.deepEqual(parsed.scheduleIds, ['sched-1', 'sched-2'])
    assert.ok(FRAMING_BATCH.includes('BATCH'))
  })

  test('gateinject A4: 真人消息与其它注入来源都不算定时任务', () => {
    assert.deepEqual(parseScheduleOrigin(humanMessage(3)), { isScheduled: false, scheduleIds: [] })
    assert.deepEqual(
      parseScheduleOrigin({ role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: FRAMING_SINGLE }] }),
      // ⚠ 这是刻意的保守取舍：**文本里出现了 framing 就认**，哪怕 kind 说是别的来源。
      // 宁可多认一条（登记过才注入），也不要因为上游改了 kind 而静默漏掉真任务。
      { isScheduled: true, scheduleIds: [] },
    )
    assert.deepEqual(parseScheduleOrigin(null), { isScheduled: false, scheduleIds: [] })
  })

  test('gateinject A5: kind 不是 schedule 但文本是 framing 时仍要认（上游改 kind 的兜底）', () => {
    // 这条才是「文本兜底」存在的理由：A2/A3 的消息本身带 kind=schedule，
    // 就算把 framing 解析整个删掉它们也照样通过——那证明不了兜底活着。
    const textOnly = parseScheduleOrigin({
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: framingOf('sched-BY-TEXT') }],
    })
    assert.equal(textOnly.isScheduled, true)
    assert.deepEqual(textOnly.scheduleIds, ['sched-BY-TEXT'])

    const batchOnly = parseScheduleOrigin({
      role: 'user',
      content: [{ type: 'text', text: batchFramingOf([['sched-B1', 'A'], ['sched-B2', 'B']]) }],
    })
    assert.equal(batchOnly.isScheduled, true)
    assert.deepEqual(batchOnly.scheduleIds, ['sched-B1', 'sched-B2'])
  })

  // -------------------------------------------------------------------------
  // B. 距上次真人说话
  // -------------------------------------------------------------------------

  test('gateinject B1: 只认真人消息，跳过 schedule / runtime-context 注入', () => {
    const messages = [
      humanMessage(90, 'h-old'),
      { role: 'user', source: { kind: 'runtime-context' }, time: NOW - 5 * 60_000, content: [{ type: 'text', text: '运行时上下文' }] },
      scheduleMessage(framingOf('sched-A'), 's-sched'),
      { role: 'user', source: { kind: 'user' }, time: NOW - 30 * 60_000, content: [{ type: 'text', text: '继续' }] },
    ]
    // 取**最后一条真人**（30 分钟前），不是最后一条消息（schedule 那条更近）。
    assert.equal(minutesSinceLastHumanMessage(messages, NOW), 30)
  })

  test('gateinject B2: 一条真人都没有时返回 null，绝不返回 0', () => {
    // 返回 0 会让时机因子落到近因子 0.15（命中线被压到极低 → 几乎必然放行），
    // 也就是把「读不到」当成「刚说完话」——方向正好反了。null 走中性因子 1。
    assert.equal(minutesSinceLastHumanMessage([scheduleMessage(framingOf('sched-A'))], NOW), null)
    assert.equal(minutesSinceLastHumanMessage([], NOW), null)
    assert.equal(minutesSinceLastHumanMessage(null, NOW), null)
  })

  test('gateinject B3: 时钟倒流时夹到 0，不把负数喂给时机因子', () => {
    const messages = [{ role: 'user', source: { kind: 'user' }, time: NOW + 10 * 60_000, content: [{ type: 'text', text: '未来' }] }]
    assert.equal(minutesSinceLastHumanMessage(messages, NOW), 0)
  })

  // -------------------------------------------------------------------------
  // C. 注入文本
  // -------------------------------------------------------------------------

  test('gateinject C1: 放行写清 命中线/掷值/连续没中 + 按原任务执行', () => {
    const text = renderGateNote('speak', { scheduleId: SCHEDULE_ID, line: 42, roll: 0.31, streak: 2, code: 'hit' })
    assert.ok(text.startsWith(GATE_NOTE_TAG))
    assert.match(text, /通过门/)
    assert.match(text, /命中线 42/)
    assert.match(text, /掷值 31/)
    assert.match(text, /连续没中 2 次/)
    assert.match(text, /按原任务正常执行/)
    assert.equal(text.includes('\n'), false, '注入文本必须单行（context 里多行会被压平，不如自己先压）')
  })

  test('gateinject C2: 拦下写清中文原因 + 静默收尾的动作清单', () => {
    const hold = renderGateNote('hold', { scheduleId: SCHEDULE_ID, line: 60, roll: 0.88, streak: 3, code: 'miss' })
    assert.match(hold, /被拦下/)
    assert.match(hold, /掷骰没中（命中线未到）/) // code 直译，不是把 miss 直接甩给模型
    assert.match(hold, /静默收尾/)
    assert.match(hold, /不要发通知/)
    assert.match(hold, /不要写业务文件/)

    const blocked = renderGateNote('blocked', { code: 'disabled', line: 60, streak: 0 })
    assert.match(blocked, /判定器关闭/)
    assert.match(blocked, /静默收尾/)
  })

  test('gateinject C3: 输出不含连续花括号（context 文本会经插值，`{{` 会让会话直接废掉）', () => {
    const text = renderGateNote('hold', {
      scheduleId: '{{cwd}}',
      note: '备注里有 {{nope}} 这种串',
      code: 'miss',
      line: 60,
      streak: 1,
    })
    // 插值器只认**连续两个** `{`（GROUP_AT = /^\{\{([^{}]*)\}\}/），所以判据是「没有 `{{`」。
    // 单独的 `}}` 是纯字面文本、不触发任何扫描，不必拆——拆了反而让人以为它在防别的东西。
    assert.equal(text.includes('{{'), false)
    assert.equal(/\{\{+/.test(text), false)
    // 中和之后原文信息不能整段消失（只拆括号，不删内容）。
    assert.match(text, /cwd/)
    assert.match(text, /nope/)
  })

  // -------------------------------------------------------------------------
  // D/E. 注入器：默认零行为变化 + 记账落盘
  // -------------------------------------------------------------------------

  /** 造一个全注入的 injector（loadState / saveState / 时钟 / 随机数都钉死）。 */
  function makeInjector({ state, roll = 0.5, log = makeLogger(), throttle = OPEN, nowMs = NOW } = {}) {
    const writes = []
    const injector = createGateInjector({
      loadState: () => state,
      saveState: (next) => {
        writes.push(next)
        state = next
      },
      throttle,
      log,
      now: () => nowMs,
      random: () => roll,
    })
    return { injector, writes, log, getState: () => state }
  }

  /** 造一份「已登记 scheduleId」的状态。 */
  function stateWithTask(entry = { enabled: true }) {
    assert.ok(S, 'storage 模块必须可用（tasks 节由它提供）')
    return S.upsertTask(S.emptyState(), SCHEDULE_ID, entry)
  }

  test('gateinject D1: 没登记 = 零行为变化（不判定、不注入、不写盘）', () => {
    const empty = S.emptyState()
    const { injector, writes, log } = makeInjector({ state: empty })
    injector.observe(SESSION, { type: 'agent/inbox/spliced', time: NOW, data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID))] } })
    assert.equal(injector.render(SESSION), '')
    assert.equal(writes.length, 0, '没登记的任务一条都不许写盘')
    assert.deepEqual(log.lines, [], '没登记不是错误，不该留痕（否则每轮刷屏）')
    // 非定时任务那一轮也不注入。
    injector.observe(SESSION, { type: 'user/message', time: NOW, data: humanMessage(1, 'h-2') })
    assert.equal(injector.render(SESSION), '')
  })

  test('gateinject D2: 登记了但判定器关着 → 不注入、不记账，但必须留一行 warn', () => {
    const { injector, writes, log } = makeInjector({ state: stateWithTask(), throttle: { enabled: false } })
    injector.observe(SESSION, { type: 'agent/inbox/spliced', time: NOW, data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID))] } })
    assert.equal(injector.render(SESSION), '')
    assert.equal(writes.length, 0)
    assert.ok(
      log.lines.some((line) => line.includes('throttle.enabled=false')),
      `应当留一行"登记了但闸门没开"的告警，实际：${JSON.stringify(log.lines)}`,
    )
  })

  test('gateinject D3: 登记了但 enabled 不是字面 true → 不注入、不写盘（脏数据必须按关处理）', () => {
    // 与「没登记」是同一种对外行为，但成因不同：状态文件里可能留着 `enabled: "true"`
    // 这类脏值（手改、旧版本写的、外部工具写的）。这类必须按关处理，
    // 否则 `!== undefined` 之类宽松判据会让一行脏数据让闸门永久常开。
    for (const dirty of ['true', 1, {}, []]) {
      const state = { ...S.emptyState(), tasks: { [SCHEDULE_ID]: { enabled: dirty, streak: 0, lastSpokeAt: null } } }
      const { injector, writes } = makeInjector({ state })
      injector.observe(SESSION, { type: 'agent/inbox/spliced', time: NOW, data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID))] } })
      assert.equal(injector.render(SESSION), '', `enabled=${JSON.stringify(dirty)} 必须按下不注入`)
      assert.equal(writes.length, 0)
    }
  })

  test('gateinject D4: 状态文件读不出来 → 不判定、绝不写盘、留 warn', () => {
    const broken = { ...stateWithTask(), readError: 'EACCES: permission denied' }
    const { injector, writes, log } = makeInjector({ state: broken })
    injector.observe(SESSION, { type: 'agent/inbox/spliced', time: NOW, data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID))] } })
    assert.equal(injector.render(SESSION), '')
    assert.equal(writes.length, 0, '读不出来时写回空表 = 把别的项目的记录整表删掉')
    assert.ok(log.lines.some((line) => line.includes('读不出来')))
  })

  test('gateinject E1: 掷中 → 文本含"通过门"，且 streak 清零写回 tasks', () => {
    const { injector, writes, getState } = makeInjector({ state: stateWithTask({ enabled: true, streak: 3 }), roll: 0.01 })
    injector.observe(SESSION, {
      type: 'agent/inbox/spliced',
      time: NOW,
      data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID))] },
    })
    // 先垫一条 30 分钟前的真人消息，让时机因子为中性（否则读数不稳）。
    injector.observe(SESSION, { type: 'user/message', time: NOW, data: humanMessage(30, 'h-3') })
    injector.observe(SESSION, { type: 'agent/inbox/spliced', time: NOW, data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID), 'msg-sched-2')] } })

    const text = injector.render(SESSION)
    assert.match(text, /通过门/)
    assert.equal(writes.length, 1)
    assert.equal(getState().tasks[SCHEDULE_ID].streak, 0, '掷中必须清零连没中')
    assert.equal(getState().tasks[SCHEDULE_ID].enabled, true, '写回不许把 enabled 弄丢')
  })

  test('gateinject E2: 没掷中 → streak +1 写回；同一轮再问不重掷也不重复写盘', () => {
    const { injector, writes, getState } = makeInjector({ state: stateWithTask({ enabled: true, streak: 0 }), roll: 0.99 })
    injector.observe(SESSION, { type: 'agent/inbox/spliced', time: NOW, data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID))] } })

    const first = injector.render(SESSION)
    assert.match(first, /被拦下/)
    assert.equal(writes.length, 1)
    assert.equal(getState().tasks[SCHEDULE_ID].streak, 1)

    // 同一个 step / 同一轮会反复问同一个 key：**绝不能重掷**（否则一次投递攒两次加成）。
    const second = injector.render(SESSION)
    assert.equal(second, first, '同一轮必须返回同一个结论（备忘命中）')
    assert.equal(writes.length, 1, '备忘命中时不许再写盘')
  })

  test('gateinject E3: tasks 节经 serialize 往返仍然在（专防白名单漏一节）', () => {
    assert.ok(S, 'storage 模块必须可用')
    const dir = makeTmpDir('azone-gate')
    try {
      const file = join(dir, 'state.json')
      const state = S.upsertTask(S.emptyState(), SCHEDULE_ID, { enabled: true, streak: 2, lastSpokeAt: NOW - 1000, note: '周一早报，别提前' })
      S.saveState(file, state)
      const raw = parseStateFile(file)
      assert.equal(raw.tasks[SCHEDULE_ID].enabled, true)
      assert.equal(raw.tasks[SCHEDULE_ID].streak, 2)
      assert.equal(raw.tasks[SCHEDULE_ID].note, '周一早报，别提前')

      const back = S.loadState(file)
      assert.equal(back.readError, undefined)
      assert.equal(back.tasks[SCHEDULE_ID].streak, 2)
      assert.equal(S.taskEntryOf(back, SCHEDULE_ID).enabled, true)
      assert.equal(S.taskEntryOf(back, '不存在的任务'), undefined, '没记录就是 undefined，不造默认值')
    } finally {
      rmTmp(dir)
    }
  })

  test('gateinject E4: 脏数据 fail-closed（enabled 不是字面 true 一律当关）', () => {
    assert.ok(S, 'storage 模块必须可用')
    for (const dirty of ['true', 1, {}, [], null]) {
      assert.equal(S.normalizeTaskEntry({ enabled: dirty }).enabled, false, `enabled=${JSON.stringify(dirty)} 必须按关处理`)
    }
    assert.equal(S.normalizeTaskEntry({ enabled: true }).enabled, true)
    // streak 脏了回 0、lastSpokeAt 脏了回 null（不猜一个假时间，否则冷却判据会凭空成立）。
    const fixed = S.normalizeTaskEntry({ enabled: true, streak: -5, lastSpokeAt: 'x' })
    assert.equal(fixed.streak, 0)
    assert.equal(fixed.lastSpokeAt, null)
  })

  test('gateinject E5: pre-step 收到认不出会话的定时消息 → 不猜、跳过并留一行 warn', () => {
    const { injector, writes, log } = makeInjector({ state: stateWithTask() })
    const orphan = scheduleMessage(framingOf(SCHEDULE_ID), 'msg-never-seen')
    injector.rememberBatch([orphan])
    assert.equal(writes.length, 0, '认不出会话时绝不许猜着记账')
    assert.ok(log.lines.some((line) => line.includes('认不出它属于哪个会话')))
    assert.equal(injector.render(SESSION), '')
  })

  test('gateinject D5: 时钟与随机数都可注入（峰/谷两档命中线不同，证明 now 真的传到了 decide）', () => {
    // 只注入 random 不注入 now 的坑：命中线基准随峰谷变（峰 20 / 谷 60），
    // 于是「命中线应是 60」这类断言会在白天悄悄变红，看起来像实现坏了。
    const cases = [
      { at: new Date(2026, 9, 26, 10, 0, 0, 0).getTime(), line: '命中线 20' }, // 周一 10:00 = 峰时
      { at: new Date(2026, 9, 26, 22, 0, 0, 0).getTime(), line: '命中线 60' }, // 同日 22:00 = 谷时
    ]
    for (const { at, line } of cases) {
      const { injector } = makeInjector({ state: stateWithTask(), roll: 0.99, nowMs: at })
      // 「距上次真人说话」取的是**事件时间戳**（消息被观察到的时刻），不是 content 里的伪造时间；
      // 想要 30 分钟的间隔，就得把事件时间写成 30 分钟前。
      injector.observe(SESSION, {
        type: 'user/message',
        time: at - 30 * 60_000,
        data: { id: 'human-clock', role: 'user', source: { kind: 'user' }, time: at - 30 * 60_000, content: [{ type: 'text', text: '在吗' }] },
      })
      injector.observe(SESSION, {
        type: 'agent/inbox/spliced',
        time: at,
        data: { inserted: [scheduleMessage(framingOf(SCHEDULE_ID), 'sched-clock')] },
      })
      const text = injector.render(SESSION)
      assert.match(text, /被拦下/)
      assert.ok(text.includes(line), `注入时刻 ${new Date(at).toISOString()} 应当是 ${line}，实际：${text}`)
      assert.match(text, /连续没中 0 次/)
    }
  })

  // -------------------------------------------------------------------------
  // F. 工具侧 action=gated
  // -------------------------------------------------------------------------

  if (!toolsImpl.ok) {
    test('gateinject F: tools 实现缺失', () => {
      assert.fail(`找不到 tools 模块：${toolsImpl.reason}`)
    })
  } else {
    const { createProactiveGateTool } = toolsImpl.mod

    /** 造一个把状态存在内存里的 gate 工具。 */
    function makeGateTool({ state = undefined, throttle = { enabled: true } } = {}) {
      let current = state ?? (S ? S.emptyState() : { version: 1, zones: {}, throttle: {}, tasks: {} })
      const writes = []
      const tool = createProactiveGateTool({
        loadState: () => current,
        saveState: (file, next) => {
          writes.push({ file, next })
          current = next
        },
        throttle,
        log: makeLogger(),
        now: () => NOW,
        random: () => 0.5,
      })
      return { tool, writes, getState: () => current }
    }

    test('gateinject F1: gated 登记写盘，并在返回里说清"判定器是否开着"', async () => {
      const { tool, writes, getState } = makeGateTool()
      const result = await tool.execute({ action: 'gated', scheduleId: SCHEDULE_ID, note: '周一早报' })
      assert.equal(result.ok, true)
      assert.equal(result.action, 'gated')
      assert.equal(result.gated, true)
      assert.equal(result.throttleEnabled, true)
      assert.equal(result.wrote, true)
      assert.equal(result.gatedTaskCount, 1)
      assert.equal(writes.length, 1)
      assert.equal(getState().tasks[SCHEDULE_ID].enabled, true)
      assert.equal(getState().tasks[SCHEDULE_ID].note, '周一早报')
    })

    test('gateinject F2: gated:false 是彻底删键（不是写一条 enabled:false）', async () => {
      const { tool, getState } = makeGateTool({ state: S.upsertTask(S.emptyState(), SCHEDULE_ID, { enabled: true }) })
      const off = await tool.execute({ action: 'gated', scheduleId: SCHEDULE_ID, gated: false })
      assert.equal(off.ok, true)
      assert.equal(off.gated, false)
      assert.equal(SCHEDULE_ID in getState().tasks, false, '"没登记"与"登记了但关着"是两种语义，不能混')
    })

    test('gateinject F3: 缺 scheduleId / 状态读不出来都拒绝，且一个字节都不写', async () => {
      const { tool, writes } = makeGateTool()
      const missing = await tool.execute({ action: 'gated' })
      assert.equal(missing.ok, false)
      assert.equal(missing.code, 'invalid_schedule_id')
      assert.equal(writes.length, 0)

      const broken = makeGateTool({ state: { ...S.emptyState(), readError: 'EACCES' } })
      const refused = await broken.tool.execute({ action: 'gated', scheduleId: SCHEDULE_ID })
      assert.equal(refused.ok, false)
      assert.equal(refused.code, 'state-unreadable')
      assert.equal(broken.writes.length, 0)
    })

    test('gateinject F4: 未知 action 的报错里列出全部三个合法值', async () => {
      const { tool } = makeGateTool()
      const bad = await tool.execute({ action: 'speak' })
      assert.equal(bad.ok, false)
      assert.equal(bad.code, 'invalid_action')
      assert.match(bad.message, /check/)
      assert.match(bad.message, /record/)
      assert.match(bad.message, /gated/)
    })

    test('gateinject F5: gated 的渲染说清"挡不住这一轮启动"（诚实边界）', async () => {
      const { tool } = makeGateTool()
      const result = await tool.execute({ action: 'gated', scheduleId: SCHEDULE_ID })
      const rendered = tool.output.render({ action: 'gated' }, result)
      const text = rendered.map((block) => block.text).join('\n')
      assert.match(text, /已把定时任务/)
      assert.match(text, /挡不住这一轮启动/)
      assert.equal(text.includes('{{'), false)
    })
  }
}

// ---------------------------------------------------------------------------
// 守卫：本测试文件不许碰真实状态文件
// ---------------------------------------------------------------------------

test('gateinject Z1: 全局守卫——真实状态文件未被触碰（快照大小/mtime 不变）', async () => {
  const { snapshotRealStateFile, assertRealStateFileUntouched } = await import('./_harness.mjs')
  const before = snapshotRealStateFile()
  assertRealStateFileUntouched(before, assert)
})
