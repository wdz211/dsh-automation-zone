// @ts-check
/**
 * tools.test.mjs —— 工具层验收：A3 / A4 / A5 / A10 + cwd 解析优先级 + schedule 错误透出。
 *
 * 全部依赖注入（schedule / sessionController / ensureZoneSession / loadState 都是普通对象 mock），
 * 不连真实 DSH，也不碰文件系统 —— 所以本文件不需要临时目录。
 *
 * 为什么这几条必须在工具层测：storage / selector / zone 各自都对，不代表被工具串起来还
 * 对。最容易写错的三处就是「任务建在哪个会话上」「selector 没通过时会不会已经落库」
 * 「schedule 抛的错误码会不会被兜底值盖掉」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describeExports, loadImpl, makeLogger, makeTmpDir, rmTmp } from './_harness.mjs'

const impl = await loadImpl('tools')

const SKIP_REASON = impl.ok
  ? ''
  : `tools: ${impl.reason}`

const CALLER_ID = 'session-caller-0001'
const ZONE_ID = 'session-zone-0001'
const CWD = makeTmpDir('azone-cwd')

const DAILY = { daily: { time: '09:00', time_zone: 'Asia/Shanghai' } }
const WEEKLY = { weekly: { time: '10:00', time_zone: 'Asia/Shanghai', weekdays: [1, 2] } }

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

/** inspect 依据「sessionId → cwd」表工作；表里没有就抛（等价于会话不存在） */
function inspectFromMap(map) {
  return async (sessionId) => {
    if (!(sessionId in map)) {
      const err = new Error(`session not found: ${sessionId}`)
      err.code = 'session_not_found'
      throw err
    }
    return { meta: { id: sessionId, cwd: map[sessionId] }, inheritedEventCount: 0, events: [] }
  }
}

function makeSessionController(inspectImpl) {
  const calls = { inspect: [] }
  return {
    calls,
    async inspect(sessionId) {
      calls.inspect.push(sessionId)
      return inspectImpl(sessionId)
    },
  }
}

/**
 * schedule mock：**逐条记录 create 的 (sessionId, request)**。
 * A3/A4/A5 的判据全在这份记录上，所以它必须是数组而不是计数器。
 */
function makeScheduleMock(options = {}) {
  const calls = { create: [], list: [], catalog: 0 }
  const bySession = options.tasksBySession ?? {}
  return {
    calls,
    async create(sessionId, request) {
      calls.create.push({ sessionId, request })
      if (typeof options.createImpl === 'function') return options.createImpl(sessionId, request)
      return { id: `task-${calls.create.length}`, sessionId, status: 'active', ...request }
    },
    async list(query = {}) {
      const sessionId = query?.sessionId
      calls.list.push(sessionId)
      return (bySession[sessionId] ?? []).map((r) => ({ ...r }))
    },
    async catalog() {
      calls.catalog += 1
      if (typeof options.catalogImpl === 'function') return options.catalogImpl()
      return (options.catalog ?? []).map((r) => ({ ...r }))
    },
  }
}

/** ensureZoneSession mock：记录它被要求处理的 cwd，返回可切换的 zone 结果 */
function makeEnsureZoneSession(initial) {
  const seen = { cwd: [] }
  const holder = { result: initial }
  const fn = async (cwd) => {
    seen.cwd.push(cwd)
    const current = holder.result
    return typeof current === 'function' ? current(cwd) : current
  }
  fn.seen = seen
  /** 让下一次（及之后）的调用返回不同的 zone 结果，用于模拟"第二次复用" */
  fn.setResult = (next) => {
    holder.result = next
  }
  return fn
}

/** loadState 固定返回一份 zones 表（工具只当它是个同步取函数用） */
const fixedState = (zones) => () => ({ version: 1, zones })

// ---------------------------------------------------------------------------

if (!impl.ok) {
  test('tools: 无法运行，7 个用例全部跳过', (t) => {
    t.skip(SKIP_REASON)
  })
} else {
  const mod = impl.mod
  const missing = ['createTaskCreateTool', 'createZoneStatusTool'].filter((n) => typeof mod[n] !== 'function')
  if (missing.length) {
    test('tools: 缺少工具工厂', (t) => {
      t.skip(`tools: 未导出 ${missing.join(', ')}（可用导出：${describeExports(mod)}）`)
    })
  } else {
    /** 建一个「一切正常」的 task_create 工具，四个 mock 都可单独覆盖 */
    function makeCreateTool(overrides = {}) {
      const schedule = overrides.schedule ?? makeScheduleMock()
      const sessionController =
        overrides.sessionController ??
        makeSessionController(inspectFromMap({ [CALLER_ID]: CWD, [ZONE_ID]: CWD }))
      const ensureZoneSession =
        overrides.ensureZoneSession ??
        makeEnsureZoneSession({ sessionId: ZONE_ID, created: true, title: '⚙ 自动化任务' })
      const tool = mod.createTaskCreateTool({
        schedule,
        sessionController,
        ensureZoneSession,
        log: overrides.log ?? makeLogger(),
      })
      return { tool, schedule, sessionController, ensureZoneSession }
    }

    const exec = { agent: { id: CALLER_ID } }

    // -----------------------------------------------------------------------
    // 1. A3 —— 任务必须绑到自动化会话，不是调用者会话
    // -----------------------------------------------------------------------

    test('tools: A3 任务绑定在自动化会话上（schedule.create 第一个参数 = zoneSessionId）', async () => {
      const { tool, schedule } = makeCreateTool()

      const result = await tool.execute({ title: '每日巡检', prompt: '跑一遍自检', ...DAILY }, exec)

      assert.equal(result.ok, true, `应当成功，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.equal(schedule.calls.create.length, 1, `应恰好 create 一次，实际 ${schedule.calls.create.length}`)

      const [first] = schedule.calls.create
      assert.equal(
        first.sessionId,
        ZONE_ID,
        `A3 失败：任务建在了 ${first.sessionId} 上，应当是自动化会话 ${ZONE_ID}`,
      )
      assert.notEqual(first.sessionId, CALLER_ID, 'A3 失败：任务被绑到了调用者会话上')
      assert.equal(result.sessionId, ZONE_ID, `返回的 sessionId 应当是 ${ZONE_ID}，实际 ${result.sessionId}`)

      // selector 必须原样传给 schedule
      assert.deepEqual(first.request.daily, DAILY.daily, 'selector 没有原样传给 schedule.create')
      assert.equal(first.request.title, '每日巡检')
      assert.equal(first.request.prompt, '跑一遍自检')
    })

    // -----------------------------------------------------------------------
    // 2. A4 —— 原会话一次都不能被碰
    // -----------------------------------------------------------------------

    test('tools: A4 调用者会话从头到尾没被用过（A3/A4 是同一事实的两面）', async () => {
      const { tool, schedule, ensureZoneSession } = makeCreateTool()

      // 连续两次调用：第二次 ensureZoneSession 返回 created:false（复用已有会话）
      const first = await tool.execute({ title: 'a', prompt: 'p', ...DAILY }, exec)
      ensureZoneSession.setResult({ sessionId: ZONE_ID, created: false, title: '⚙ 自动化任务' })
      const second = await tool.execute({ title: 'b', prompt: 'p', ...WEEKLY }, exec)

      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      assert.equal(first.created, true, '第一次 created 应为 true')
      assert.equal(second.created, false, '第二次 created 应为 false（ensureZoneSession 说这次是复用）')
      assert.equal(schedule.calls.create.length, 2, `两次调用应 create 两次，实际 ${schedule.calls.create.length}`)

      const polluted = schedule.calls.create.filter((call) => call.sessionId === CALLER_ID)
      assert.deepEqual(
        polluted,
        [],
        `A4 失败：有 ${polluted.length} 次任务被建到了调用者会话 ${CALLER_ID} 上——那个会话会被钉住无法归档`,
      )
      // 每一次都必须落在自动化会话上
      for (const call of schedule.calls.create) {
        assert.equal(call.sessionId, ZONE_ID, `A4 失败：${call.sessionId} 不是自动化会话`)
      }
      // ensureZoneSession 收到的应当是调用者会话的 cwd（不是别的）
      assert.deepEqual(ensureZoneSession.seen.cwd, [CWD, CWD], 'ensureZoneSession 的入参 cwd 不对')
    })

    // -----------------------------------------------------------------------
    // 3. A5 —— selector 不合法时绝不能已经落库
    // -----------------------------------------------------------------------

    test('tools: A5 selector 给两个时返回 invalid_selector 且 schedule.create 零调用', async () => {
      const { tool, schedule } = makeCreateTool()

      const result = await tool.execute({ title: 'x', prompt: 'y', ...DAILY, ...WEEKLY }, exec)

      assert.equal(result.ok, false, `两个 selector 应当失败，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.equal(result.code, 'invalid_selector', `应当是 invalid_selector，实际 ${result.code}`)
      assert.equal(
        schedule.calls.create.length,
        0,
        `A5 失败：selector 校验没通过却已经 create 了 ${schedule.calls.create.length} 次（顺序反了）`,
      )
    })

    test('tools: A5 selector 零个时返回 invalid_selector 且 schedule.create 零调用', async () => {
      const { tool, schedule } = makeCreateTool()

      const result = await tool.execute({ title: 'x', prompt: 'y' }, exec)

      assert.equal(result.ok, false)
      assert.equal(result.code, 'invalid_selector', `应当是 invalid_selector，实际 ${result.code}`)
      assert.equal(schedule.calls.create.length, 0, 'A5 失败：selector 校验没通过却已经 create')
    })

    // -----------------------------------------------------------------------
    // 4. A10 —— orphan 识别
    // -----------------------------------------------------------------------

    test('tools: A10 只有寄生在非自动化会话上的 active 任务进 orphans', async () => {
      const zones = { [CWD]: { sessionId: ZONE_ID, createdAt: '2026-10-19T13:00:00.000Z', title: '⚙ 自动化任务' } }
      const zoneTask = { id: 'task-zone', sessionId: ZONE_ID, title: 'zone 上的任务', status: 'active' }
      const orphanTask = { id: 'task-orphan', sessionId: 'session-other-0009', title: '寄生任务', status: 'active' }
      const inactiveOrphan = { id: 'task-dead', sessionId: 'session-other-0009', title: '已停用', status: 'inactive' }

      const schedule = makeScheduleMock({
        catalog: [zoneTask, orphanTask, inactiveOrphan],
        tasksBySession: { [ZONE_ID]: [zoneTask] },
      })
      const sessionController = makeSessionController(
        inspectFromMap({ [ZONE_ID]: CWD, 'session-other-0009': 'E:\\SomeOtherProject' }),
      )

      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController,
        loadState: fixedState(zones),
        log: makeLogger(),
      })
      const result = await statusTool.execute({}, { agent: { id: CALLER_ID } })

      assert.equal(result.ok, true, `状态工具应当成功，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.ok(Array.isArray(result.orphans), 'orphans 必须是数组')

      const ids = result.orphans.map((o) => o.taskId)

      assert.ok(ids.includes('task-orphan'), `A10 失败：寄生任务没被识别出来（orphans=${JSON.stringify(result.orphans)}）`)
      assert.ok(
        !ids.includes('task-zone'),
        `A10 失败：自动化会话上的任务被误判成 orphan（orphans=${JSON.stringify(ids)}）`,
      )
      assert.ok(
        !ids.includes('task-dead'),
        `A10 失败：inactive 任务被算进 orphan（orphans 只该有 active，实际 ${JSON.stringify(ids)}）`,
      )

      const orphan = result.orphans.find((o) => o.taskId === 'task-orphan')
      assert.equal(orphan.sessionId, 'session-other-0009')
      assert.equal(orphan.cwd, 'E:\\SomeOtherProject', 'orphan 的 cwd 应当来自它所在会话的 meta.cwd')
      assert.equal(orphan.title, '寄生任务')
    })

    test('tools: A10 record 上完全没有 status 字段时也算 orphan', async () => {
      // schedule.json 把 status 存在 table entry 上，catalog 的 record 里常常没有这个字段。
      // 缺失 ≠ 已停用：这条必须被识别成 orphan，否则真实环境里 27 条任务会被全部过滤掉。
      const zones = { [CWD]: { sessionId: ZONE_ID, title: '⚙ 自动化任务' } }
      const statuslessOrphan = { id: 'task-statusless', sessionId: 'session-other-0009', title: '没有 status 的寄生任务' }

      const schedule = makeScheduleMock({ catalog: [statuslessOrphan], tasksBySession: {} })
      const sessionController = makeSessionController(inspectFromMap({ 'session-other-0009': 'E:\\SomeOtherProject' }))

      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController,
        loadState: fixedState(zones),
        log: makeLogger(),
      })
      const result = await statusTool.execute({})

      assert.equal(result.ok, true, `状态工具应当成功，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      const ids = result.orphans.map((o) => o.taskId)
      assert.ok(
        ids.includes('task-statusless'),
        `A10 失败：record 上没有 status 字段的寄生任务没被识别成 orphan（缺失 status 被当成了已停用？orphans=${JSON.stringify(result.orphans)}）`,
      )
    })

    test('tools: A10 没有孤儿时 orphans 为空数组（而不是 undefined）', async () => {
      const zones = { [CWD]: { sessionId: ZONE_ID, title: '⚙ 自动化任务' } }
      const zoneTask = { id: 'task-zone', sessionId: ZONE_ID, title: 'zone 上的任务', status: 'active' }

      const schedule = makeScheduleMock({ catalog: [zoneTask], tasksBySession: { [ZONE_ID]: [zoneTask] } })
      const sessionController = makeSessionController(inspectFromMap({ [ZONE_ID]: CWD }))

      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController,
        loadState: fixedState(zones),
        log: makeLogger(),
      })
      const result = await statusTool.execute({})

      assert.equal(result.ok, true)
      assert.deepEqual(result.orphans, [], `没有孤儿时应当是空数组，实际 ${JSON.stringify(result.orphans)}`)
      assert.equal(result.zones.length, 1)
      assert.equal(result.zones[0].sessionId, ZONE_ID)
      assert.equal(result.zones[0].exists, true)
      assert.equal(result.zones[0].cwdMatches, true)
      assert.equal(result.zones[0].tasks.length, 1)
    })

    // -----------------------------------------------------------------------
    // 5. cwd 解析优先级
    // -----------------------------------------------------------------------

    test('tools: cwd 优先取调用者会话的 meta.cwd，参数 cwd 不抢占', async () => {
      const ARG_CWD = 'E:\\WrongProject'
      const { tool, schedule, ensureZoneSession } = makeCreateTool()

      const result = await tool.execute({ title: 'x', prompt: 'y', cwd: ARG_CWD, ...DAILY }, exec)

      assert.equal(result.ok, true, `应当成功，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.deepEqual(
        ensureZoneSession.seen.cwd,
        [CWD],
        `应当用会话 cwd ${CWD}，实际 ${JSON.stringify(ensureZoneSession.seen.cwd)}（参数 cwd 不该抢占）`,
      )
      assert.equal(schedule.calls.create[0].sessionId, ZONE_ID)
    })

    test('tools: inspect 抛错时回退到参数 cwd', async (t) => {
      // 参数兜底必须指向**已存在的目录**（否则 create({cwd}) 会凭空 mkdir 出一条新记忆轨），
      // 所以这里用一个真实的临时目录当兜底 cwd。
      const ARG_CWD = makeTmpDir('azone-argcwd')
      t.after(() => rmTmp(ARG_CWD))
      const { tool, ensureZoneSession } = makeCreateTool({
        // 调用者会话一问就炸
        sessionController: makeSessionController(async () => {
          const err = new Error('session not found: ' + CALLER_ID)
          err.code = 'session_not_found'
          throw err
        }),
      })

      const result = await tool.execute({ title: 'x', prompt: 'y', cwd: ARG_CWD, ...DAILY }, exec)

      assert.equal(result.ok, true, `应当成功，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.deepEqual(
        ensureZoneSession.seen.cwd,
        [ARG_CWD],
        `应当回退到参数 cwd ${ARG_CWD}，实际 ${JSON.stringify(ensureZoneSession.seen.cwd)}`,
      )
    })

    test('tools: 参数 cwd 不存在时返回 cwd_not_found，且不建会话不落库', async () => {
      const BOGEY_CWD = 'D:\\NoSuchProject-azone-20261019'
      const { tool, schedule, ensureZoneSession } = makeCreateTool({
        sessionController: makeSessionController(async () => {
          const err = new Error('session not found: ' + CALLER_ID)
          err.code = 'session_not_found'
          throw err
        }),
      })

      const result = await tool.execute({ title: 'x', prompt: 'y', cwd: BOGEY_CWD, ...DAILY }, exec)

      assert.equal(result.ok, false, `不存在的 cwd 应当失败，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.equal(result.code, 'cwd_not_found', `应当是 cwd_not_found，实际 ${result.code}`)
      assert.equal(
        ensureZoneSession.seen.cwd.length,
        0,
        `cwd_not_found 时不该建自动化会话（create({cwd}) 会 mkdir -p 出幻觉目录），实际调了 ${JSON.stringify(ensureZoneSession.seen.cwd)}`,
      )
      assert.equal(schedule.calls.create.length, 0, 'cwd_not_found 时不该落库')
    })

    test('tools: 参数 cwd 是文件而不是目录时同样拒绝（cwd_not_found）', async (t) => {
      const dir = makeTmpDir('azone-filecwd')
      const FILE_CWD = join(dir, 'not-a-dir.txt')
      writeFileSync(FILE_CWD, 'x', 'utf8')
      t.after(() => rmTmp(dir))

      const { tool, ensureZoneSession } = makeCreateTool({
        sessionController: makeSessionController(async () => {
          const err = new Error('session not found: ' + CALLER_ID)
          err.code = 'session_not_found'
          throw err
        }),
      })

      const result = await tool.execute({ title: 'x', prompt: 'y', cwd: FILE_CWD, ...DAILY }, exec)

      assert.equal(result.ok, false, `文件当 cwd 应当失败，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.equal(result.code, 'cwd_not_found', `应当是 cwd_not_found，实际 ${result.code}`)
      assert.equal(ensureZoneSession.seen.cwd.length, 0, '文件当 cwd 时不该建会话')
      assert.match(String(result.message), /不是目录/, `报错里应说明“不是目录”，实际 ${JSON.stringify(result.message)}`)
    })

    test('tools: 会话和参数都拿不到 cwd 时返回 no_cwd，且不建会话不落库', async () => {
      const { tool, schedule, ensureZoneSession } = makeCreateTool({
        sessionController: makeSessionController(inspectFromMap({})), // 任何会话都查不到
      })

      const result = await tool.execute({ title: 'x', prompt: 'y', ...DAILY }, { agent: { id: CALLER_ID } })

      assert.equal(result.ok, false, `拿不到 cwd 时应当失败，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      assert.equal(result.code, 'no_cwd', `应当是 no_cwd，实际 ${result.code}`)
      assert.equal(schedule.calls.create.length, 0, 'no_cwd 时不该落库')
      assert.equal(ensureZoneSession.seen.cwd.length, 0, 'no_cwd 时不该再建自动化会话')
    })

    // -----------------------------------------------------------------------
    // 6. 两段失败不能混：会话读不到 ≠ 任务列表读不到
    // -----------------------------------------------------------------------

    test('tools: schedule.list 抛错时会话仍判在线，tasksError 说明原因（不是 exists:false）', async (t) => {
      const zones = { [CWD]: { sessionId: ZONE_ID, createdAt: '2026-10-19T13:00:00.000Z', title: '⚙ 自动化任务' } }
      const LIST_BOOM = 'schedule backend unavailable (list)'

      const schedule = makeScheduleMock({ catalog: [] })
      // inspect 成功、list 抛错：以前共用一段 catch，于是这里会得到「会话不存在」
      schedule.list = async () => {
        throw Object.assign(new Error(LIST_BOOM), { code: 'list_failed' })
      }
      const sessionController = makeSessionController(inspectFromMap({ [ZONE_ID]: CWD }))
      const logger = makeLogger()

      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController,
        loadState: fixedState(zones),
        log: logger,
      })
      const result = await statusTool.execute({})

      assert.equal(result.ok, true, `状态工具应当成功，实际 ${JSON.stringify(result)?.slice(0, 300)}`)
      const zone = result.zones[0]

      assert.equal(
        zone.exists,
        true,
        `会话 inspect 成功了，exists 必须是 true；变成 false 就是把「任务列表读不到」误报成「会话不存在」`,
      )
      assert.equal(zone.cwdMatches, true, 'cwd 判据与 inspect 同源，应当仍然成立')
      assert.deepEqual(zone.tasks, [], '读不到时 tasks 只能是空数组')
      assert.equal(
        zone.tasksError,
        LIST_BOOM,
        `应当带 tasksError 说明原因，实际 ${JSON.stringify(zone.tasksError)}`,
      )

      // 渲染层：不许把这件事说成「会话不存在」，必须说清是任务列表读不到
      const text = mod.renderZoneStatus({}, result)[0].text
      assert.ok(!text.includes('会话不存在'), `渲染把在线会话说成不存在了：\n${text}`)
      assert.ok(text.includes('会话在线，但任务列表读不到'), `渲染应当明说任务列表读不到：\n${text}`)
      assert.ok(text.includes(LIST_BOOM), `渲染应当带上真实原因：\n${text}`)
      assert.ok(!text.includes('无活动任务'), `读不到时不许说「无活动任务」（那是把读不到说成没有）：\n${text}`)

      // host 日志：这类结论必须留痕
      const warnLines = logger.lines.filter((l) => l.startsWith('[warn]'))
      assert.ok(
        warnLines.some((l) => l.includes('任务列表读取失败')),
        `应当记一条 warn 说明任务列表读取失败，实际：${JSON.stringify(logger.lines)}`,
      )
    })

    test('tools: 会话 inspect 抛错时 exists:false 且不带 tasksError（两段判据各归各的）', async () => {
      const zones = { [CWD]: { sessionId: 'session-gone-0001', title: '⚙ 自动化任务' } }
      const schedule = makeScheduleMock({ catalog: [] })
      let listCalls = 0
      schedule.list = async () => {
        listCalls += 1
        return []
      }
      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController: makeSessionController(inspectFromMap({})), // 查不到 → inspect 抛错
        loadState: fixedState(zones),
        log: makeLogger(),
      })

      const result = await statusTool.execute({})
      const zone = result.zones[0]

      assert.equal(result.ok, true)
      assert.equal(zone.exists, false, 'inspect 抛错时 exists 必须是 false')
      assert.equal(zone.cwdMatches, false)
      assert.equal(
        zone.tasksError,
        undefined,
        `会话不存在时不该有 tasksError（那是另一类失败），实际 ${JSON.stringify(zone.tasksError)}`,
      )
      assert.equal(listCalls, 0, '会话不存在时不该再去问它的任务列表')
    })

    test('tools: 已归档的会话在状态里标 archived:true，渲染说明下次会重建', async () => {
      const zones = { [CWD]: { sessionId: ZONE_ID, title: '⚙ 自动化任务' } }
      const schedule = makeScheduleMock({ catalog: [] })
      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController: makeSessionController(inspectFromMap({ [ZONE_ID]: CWD })),
        loadState: fixedState(zones),
        // 归档集合：只看 id
        isArchived: async (sessionId) => sessionId === ZONE_ID,
        log: makeLogger(),
      })

      const result = await statusTool.execute({})
      assert.equal(result.ok, true)
      assert.equal(result.zones[0].archived, true, `应当标记 archived:true，实际 ${JSON.stringify(result.zones[0])}`)

      const text = mod.renderZoneStatus({}, result)[0].text
      assert.ok(text.includes('已归档'), `渲染应当说明已归档：\n${text}`)
      assert.ok(text.includes('下次调用会重建'), `渲染应当说明下次会重建：\n${text}`)
    })

    // -----------------------------------------------------------------------
    // 7. schedule 的错误码必须原样透出
    // -----------------------------------------------------------------------

    test('tools: schedule.create 抛的 code/message 原样透出，不被兜底值盖掉', async () => {
      const BOOM_MESSAGE = 'title 不能为空'
      const schedule = makeScheduleMock({
        createImpl: async () => {
          // 模拟 ScheduleToolError：Error 子类 + 稳定的 code
          const err = new Error(BOOM_MESSAGE)
          err.code = 'invalid_prompt'
          throw err
        },
      })
      const logger = makeLogger()
      const { tool } = makeCreateTool({ schedule, log: logger })

      const result = await tool.execute({ title: 'x', prompt: 'y', ...DAILY }, exec)

      assert.equal(result.ok, false, 'create 抛错时应当返回 ok:false')
      assert.equal(
        result.code,
        'invalid_prompt',
        `错误码必须原样透出，实际 ${result.code}（变成 schedule_create_failed 就是被兜底值盖掉了）`,
      )
      assert.notEqual(result.code, 'schedule_create_failed', '错误码被兜底值覆盖了')
      assert.equal(result.message, BOOM_MESSAGE, `错误文案必须原样透出，实际 ${JSON.stringify(result.message)}`)

      // 这条路径是正常返回 {ok:false}：工具管线不会把它当错误记，所以必须自己落 host 日志。
      const warnLines = logger.lines.filter((l) => l.startsWith('[warn]'))
      assert.ok(
        warnLines.some((l) => l.includes('schedule.create') && l.includes('invalid_prompt') && l.includes('cwd=')),
        `schedule.create 失败应当留一条含 cwd/selector/code 的 warn，实际：${JSON.stringify(logger.lines)}`,
      )
      assert.ok(warnLines.some((l) => l.includes('daily')), `warn 里应当带 selector 类型，实际：${JSON.stringify(warnLines)}`)
    })

    test('tools: ensureZoneSession 抛错时返回 ok:false 且留一条 warn（含 cwd/selector/code）', async () => {
      const logger = makeLogger()
      const ensureZoneSession = async () => {
        const err = new Error('sessionController.create failed')
        err.code = 'create_failed'
        throw err
      }
      const { tool, schedule } = makeCreateTool({ ensureZoneSession, log: logger })

      const result = await tool.execute({ title: 'x', prompt: 'y', ...WEEKLY }, exec)

      assert.equal(result.ok, false)
      assert.equal(result.code, 'create_failed', `应当是原始 code，实际 ${result.code}`)
      assert.equal(schedule.calls.create.length, 0, '会话没建起来时不该落库')

      const warnLines = logger.lines.filter((l) => l.startsWith('[warn]'))
      assert.ok(
        warnLines.some((l) => l.includes('create_failed') && l.includes('cwd=') && l.includes('weekly')),
        `应当留一条含 cwd/selector/code 的 warn，实际：${JSON.stringify(logger.lines)}`,
      )
    })

    // -----------------------------------------------------------------------
    // 8. 状态文件读不出来：不许把「没读出来」渲染成「确实没有」
    //
    // 这一段盯的是**唯一诊断面**：读失败 / 解析失败时 loadState 退化成空表 + readError，
    // 若照空表往下推演，工具输出会变成「还没有任何自动化会话」+「所有任务都是孤儿」——
    // 方向正好反过来（孤儿判据的输入就是 zone 清单），而用户正是在这一刻来看这份输出。
    // -----------------------------------------------------------------------

    test('tools: 状态文件读不出来时 zone 清单与孤儿判定都不给结论（stateUnreadable）', async (t) => {
      const storage = await loadImpl('storage')
      if (!storage.ok || typeof storage.mod.loadState !== 'function') {
        t.skip(`需要真实 storage.loadState，实际：${storage.ok ? 'loadState 未导出' : storage.reason}`)
        return
      }

      const dir = makeTmpDir('azone-status-unreadable')
      t.after(() => rmTmp(dir))
      const file = join(dir, 'automation-zone.json')
      // 半截 JSON：能读到、但解析不了 —— 契约里明确归「盘上内容未知」，带 readError。
      writeFileSync(file, '{ "version": 1, "zones": { "D:\\\\broken": ', 'utf8')

      // 这个 schedule 里**真有一个** active 任务（就在 zone 会话上）。只要代码照空表推演，
      // 它就会因为「不在（空的）zone 清单里」被反过来指认成寄生任务——这正是旧行为。
      const schedule = makeScheduleMock({
        catalog: [{ id: 'task-real', title: '每日蒸馏', sessionId: ZONE_ID, status: 'active' }],
      })
      const logger = makeLogger()
      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController: makeSessionController(inspectFromMap({ [ZONE_ID]: CWD })),
        loadState: () => storage.mod.loadState(file),
        log: logger,
      })

      const result = await statusTool.execute({})

      assert.equal(result.ok, true, `读不出来也是正常返回（不抛），实际 ${JSON.stringify(result).slice(0, 300)}`)
      assert.ok(
        result.stateUnreadable !== null && typeof result.stateUnreadable === 'object',
        `必须带诊断字段 stateUnreadable，实际 ${JSON.stringify(result)}`,
      )
      const error = result.stateUnreadable.error
      assert.equal(typeof error, 'string', 'stateUnreadable.error 必须是字符串')
      assert.ok(error.includes(file), `诊断必须能定位到文件，实际 ${error}`)
      assert.match(error, /parse/i, `诊断必须带真实原因，实际 ${error}`)

      // 「不给结论」= 空的 zones/orphans 只是没读出来的副产物，且**不许**去猜孤儿
      assert.deepEqual(result.zones, [], '读不出来时不该凭空空表列出 zone')
      assert.deepEqual(result.orphans, [], '读不出来时不许给任何孤儿列表（那份判定不可信）')
      assert.equal(
        schedule.calls.catalog,
        0,
        '状态文件读不出来时不该去 catalog 里反推孤儿（那会把全部任务判成寄生任务）',
      )

      const text = mod.renderZoneStatus({}, result)[0].text
      assert.ok(/读不出来|不可信/.test(text), `渲染必须明说读不出来 / 不可信：\n${text}`)
      assert.ok(
        !text.includes('还没有任何自动化会话'),
        `读不出来时不许渲染成「还没有任何自动化会话」（那是把「没读到」说成「没有」）：\n${text}`,
      )
      assert.ok(
        !text.includes('孤儿任务：无'),
        `读不出来时也不许给「孤儿任务：无」这种结论（反过来同样不可信）：\n${text}`,
      )
      assert.ok(!/孤儿任务 \d+ 个/.test(text), `读不出来时不许列出孤儿任务：\n${text}`)

      const warnLines = logger.lines.filter((l) => l.startsWith('[warn]'))
      assert.ok(
        warnLines.some((l) => l.includes('状态文件读不出来')),
        `应当记一条 warn 说明状态文件读不出来，实际：${JSON.stringify(logger.lines)}`,
      )
    })

    test('tools: 状态读得到时不做多余告警（golden：正常路径输出与改动前逐字相同）', async (t) => {
      const storage = await loadImpl('storage')
      if (!storage.ok || typeof storage.mod.loadState !== 'function') {
        t.skip(`需要真实 storage.loadState，实际：${storage.ok ? 'loadState 未导出' : storage.reason}`)
        return
      }

      // golden 是**改动前**实测抓下来的原文。加 `stateUnreadable` 这一档时，
      // 正常路径（ENOENT / 合法文件）的输出必须一个字都不变。
      const EMPTY_TEXT =
        '还没有任何自动化会话（第一次调用 automation_task_create 时会创建）。\n' +
        '孤儿任务：无（没有定时任务寄生在非自动化会话上）。'
      assert.equal(
        mod.renderZoneStatus({}, { ok: true, zones: [], orphans: [] })[0].text,
        EMPTY_TEXT,
        '空表（状态文件不存在）的渲染被改动了',
      )

      const dir = makeTmpDir('azone-status-readable')
      t.after(() => rmTmp(dir))
      const missing = join(dir, 'nope.json')
      // ENOENT：真的没有状态文件 —— 空表就是事实，不许触发诊断档
      const schedule = makeScheduleMock({ catalog: [] })
      const statusTool = mod.createZoneStatusTool({
        schedule,
        sessionController: makeSessionController(inspectFromMap({})),
        loadState: () => storage.mod.loadState(missing),
        log: makeLogger(),
      })
      const result = await statusTool.execute({})
      assert.equal(result.ok, true)
      assert.equal(
        result.stateUnreadable,
        undefined,
        `ENOENT 不该带 stateUnreadable，实际 ${JSON.stringify(result.stateUnreadable)}`,
      )
      assert.equal(
        mod.renderZoneStatus({}, result)[0].text,
        EMPTY_TEXT,
        'ENOENT 时的渲染必须与改动前逐字相同（「还没有任何自动化会话」这一格不能被动到）',
      )
    })

    // -----------------------------------------------------------------------
    // 额外：工具定义形态（契约 §2.3 —— render 必填，缺了 register 直接抛）
    // -----------------------------------------------------------------------

    test('tools: 两个工具的 name / parameters / output.render 齐备', async () => {
      const { tool } = makeCreateTool()
      const statusTool = mod.createZoneStatusTool({
        schedule: makeScheduleMock(),
        sessionController: makeSessionController(inspectFromMap({})),
        loadState: fixedState({}),
      })

      for (const [label, definition] of [
        ['automation_task_create', tool],
        ['automation_zone_status', statusTool],
      ]) {
        assert.equal(typeof definition.name, 'string', `${label}: name 缺失`)
        assert.ok(definition.name.length > 0, `${label}: name 为空`)
        assert.equal(typeof definition.description, 'string', `${label}: description 缺失`)
        assert.equal(definition.parameters?.type, 'object', `${label}: parameters 必须是 object 根`)
        assert.equal(typeof definition.output?.render, 'function', `${label}: output.render 必填（缺了 tools.register 会抛）`)

        const blocks = definition.output.render({}, { ok: false, code: 'x', message: 'y' })
        assert.ok(Array.isArray(blocks), `${label}: render 必须返回 ContentBlock[]`)
        assert.equal(blocks[0]?.type, 'text', `${label}: render 第一块应当是 text`)
        assert.equal(typeof blocks[0]?.text, 'string', `${label}: render 的 text 必须是字符串`)
      }

      // 契约 §3.3：title / prompt 必填
      assert.deepEqual(tool.parameters.required, ['title', 'prompt'], 'parameters.required 应当是 ["title","prompt"]')
      // 六个 selector 都在参数表里
      for (const key of ['daily', 'weekly', 'every_seconds', 'after_seconds', 'at', 'cron']) {
        assert.ok(tool.parameters.properties[key], `参数表缺少 ${key}`)
      }
    })
  }
}
