// @ts-check
/**
 * repair.test.mjs —— 覆盖两件新事：
 *   ① 「记录的会话不可用 → 新建」这条路径要把旧会话上的任务迁走（A）
 *   ② `automation_zone_repair_tasks` 的孤儿判定 / dryRun / 失败报账（B）
 *
 * 全部用假 sessionController + 假 schedule，不连真实 DSH；状态读写是内存闭包，
 * 绝不碰 ~/.dsh-beta/automation-zone.json。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnsureZoneSession } from '../src/zone.js'
import { createTaskMigrator } from '../src/rotation.js'
import { REPAIR_TOOL_NAME, createRepairTasksTool } from '../src/tools.js'
import { LOG_PREFIX, upsertZone } from '../src/storage.js'
import { makeLogger, makeTmpDir } from './_harness.mjs'

const CWD = makeTmpDir('azone-cwd')
const OTHER_CWD = 'E:\\SomeOtherProject'

/**
 * 假 schedule：records 里 kind=daily 的任务能被 selectorFromRecord 直接重建，
 * delete 真的删（否则 migration 永远走 failed 分支，测不出“迁成功”）。
 * tasks: [{ id, title, sessionId, status? }]
 */
function makeFakeSchedule(tasks = []) {
  const calls = { create: 0, delete: 0, catalog: 0 }
  const records = tasks.map((task) => ({
    id: task.id,
    title: task.title ?? task.id,
    prompt: `prompt of ${task.id}`,
    kind: 'daily',
    time: '09:00:00',
    timeZone: 'Asia/Shanghai',
    status: task.status ?? 'active',
    sessionId: task.sessionId,
  }))
  let seq = 0
  return {
    calls,
    records,
    async catalog() {
      calls.catalog += 1
      return records.map((record) => ({ ...record }))
    },
    async list({ sessionId } = {}) {
      return records.filter((record) => record.sessionId === sessionId && record.status === 'active').map((r) => ({ ...r }))
    },
    async create(sessionId, request) {
      calls.create += 1
      seq += 1
      const record = { id: `task-new-${seq}`, sessionId, status: 'active', ...request }
      records.push(record)
      return record
    },
    async delete({ sessionId, id }) {
      calls.delete += 1
      const index = records.findIndex((record) => record.id === id && record.sessionId === sessionId)
      if (index < 0) return { deleted: false, code: 'not_found' }
      records.splice(index, 1)
      return { deleted: true }
    },
  }
}

/**
 * 假 sessionController。
 * `sessions` 里没有的 id = inspect 抛错（模拟「stored session ... is corrupt」）。
 */
function makeFakeSessionController(sessions = {}) {
  const calls = { create: 0, inspect: 0 }
  const live = new Map(Object.entries(sessions))
  let seq = 0
  return {
    calls,
    live,
    add(id, cwd) {
      live.set(id, cwd)
    },
    async inspect(sessionId) {
      calls.inspect += 1
      if (!live.has(sessionId)) {
        const error = new Error(`stored session ${sessionId} is corrupt`)
        error.code = 'session_not_found'
        throw error
      }
      return { meta: { id: sessionId, cwd: live.get(sessionId) } }
    },
    async create({ cwd }) {
      calls.create += 1
      seq += 1
      const sessionId = `session-new-${seq}`
      live.set(sessionId, cwd)
      return { sessionId }
    },
  }
}

/** 内存状态读写（zone.js / rotation.js 的 DI 契约是同步的） */
function makeStateIo(zones = {}) {
  let state = { version: 1, zones: { ...zones }, throttle: {}, tasks: {} }
  return {
    loadState: () => state,
    saveState: (next) => {
      state = next
    },
    setZone: (cwd, entry) => {
      state = upsertZone(state, cwd, entry)
    },
    current: () => state,
  }
}

function hasWarn(logger, needle) {
  return logger.lines.some((line) => line.startsWith('[warn]') && line.includes(needle))
}

// ---------------------------------------------------------------------------
// ① ensure 替换不可用会话时会触发迁移
// ---------------------------------------------------------------------------

test('zone: 记录的会话不可用时，把旧会话上的任务迁到新会话', async () => {
  const logger = makeLogger()
  const schedule = makeFakeSchedule([
    { id: 'T1', title: '早报', sessionId: 'session-dead' },
    { id: 'T2', title: '别的项目的', sessionId: 'session-elsewhere' },
  ])
  const sessionController = makeFakeSessionController({ [CWD]: CWD, 'session-elsewhere': OTHER_CWD })
  const io = makeStateIo({ [CWD]: { sessionId: 'session-dead', title: '⚙ 自动化任务' } })
  const migrator = createTaskMigrator({ schedule, loadState: io.loadState, saveState: io.saveState, log: logger })

  const zone = createEnsureZoneSession({
    inspect: (id) => sessionController.inspect(id),
    create: (request) => sessionController.create(request),
    onSessionReplaced: migrator.migrate,
    migrate: migrator.migrate,
    loadState: io.loadState,
    saveState: io.saveState,
    log: logger,
  })

  const result = await zone.ensure(CWD)

  assert.notEqual(result.sessionId, 'session-dead', '不可用的会话被复用了')
  assert.equal(result.created, true)
  assert.equal(sessionController.calls.create, 1)

  // T1 应该已经搬走：新会话上有一条同标题的任务，旧 id 不在册
  const moved = schedule.records.find((record) => record.title === '早报')
  assert.ok(moved, '旧会话上的任务凭空消失了（迁移把任务删了却没建新的）')
  assert.equal(moved.sessionId, result.sessionId, `任务没有迁到新会话：${JSON.stringify(moved)}`)
  assert.equal(schedule.records.some((record) => record.id === 'T1'), false, '旧任务没被删掉（会重复投递）')

  // 别的会话上的任务一个都不许动
  assert.equal(
    schedule.records.find((record) => record.id === 'T2')?.sessionId,
    'session-elsewhere',
    '迁移越界去动了别的会话上的任务',
  )

  assert.equal(io.current().zones[CWD].sessionId, result.sessionId, '状态文件没更新成新会话')
})

test('zone: cwd 不符时不迁移（那里没有可信的旧会话）', async () => {
  const logger = makeLogger()
  const schedule = makeFakeSchedule([{ id: 'T1', title: '不该被碰', sessionId: 'session-foreign' }])
  const sessionController = makeFakeSessionController({ 'session-foreign': OTHER_CWD })
  const io = makeStateIo({ [CWD]: { sessionId: 'session-foreign', title: '⚙ 自动化任务' } })

  let replacedCalls = 0
  const zone = createEnsureZoneSession({
    inspect: (id) => sessionController.inspect(id),
    create: (request) => sessionController.create(request),
    onSessionReplaced: async () => {
      replacedCalls += 1
    },
    loadState: io.loadState,
    saveState: io.saveState,
    log: logger,
  })

  const result = await zone.ensure(CWD)

  assert.notEqual(result.sessionId, 'session-foreign')
  assert.equal(replacedCalls, 0, 'cwd 不符那条路径不该迁移（旧会话属于别的项目，搬过来就是串轨）')
  assert.equal(schedule.records[0].sessionId, 'session-foreign')
})

// ---------------------------------------------------------------------------
// ② 迁移失败不影响新会话返回
// ---------------------------------------------------------------------------

test('zone: 迁移抛错时仍返回新会话（fail-open）', async () => {
  const logger = makeLogger()
  const sessionController = makeFakeSessionController({ [CWD]: CWD })
  const io = makeStateIo({ [CWD]: { sessionId: 'session-dead', title: '⚙ 自动化任务' } })

  const zone = createEnsureZoneSession({
    inspect: (id) => sessionController.inspect(id),
    create: (request) => sessionController.create(request),
    onSessionReplaced: async () => {
      throw new Error('catalog 炸了')
    },
    loadState: io.loadState,
    saveState: io.saveState,
    log: logger,
  })

  const result = await zone.ensure(CWD)

  assert.ok(result.sessionId, '迁移失败不该把新会话也一起丢掉')
  assert.notEqual(result.sessionId, 'session-dead')
  assert.equal(result.created, true)
  assert.equal(io.current().zones[CWD].sessionId, result.sessionId, '迁移失败也要把新会话记住（否则下次再建一个）')

  assert.equal(typeof result.warning, 'string', `应当返回 warning，实际 ${JSON.stringify(result)}`)
  assert.match(String(result.warning), /迁移失败/, `warning 里应说明迁移失败，实际 ${JSON.stringify(result.warning)}`)
  assert.ok(hasWarn(logger, '需要人工迁移'), `应当记一条 warn 说明任务留在旧会话上，实际 ${JSON.stringify(logger.lines)}`)
})

// ---------------------------------------------------------------------------
// ③ repair：孤儿判定 + dryRun
// ---------------------------------------------------------------------------

function makeRepairContext(options = {}) {
  const logger = makeLogger()
  const schedule = makeFakeSchedule(options.tasks ?? [])
  const sessionController = makeFakeSessionController(options.sessions ?? {})
  const io = makeStateIo(options.zones ?? {})
  const ensureCalls = []
  const migrator = createTaskMigrator({ schedule, loadState: io.loadState, saveState: io.saveState, log: logger })

  const tool = createRepairTasksTool({
    schedule,
    sessionController,
    loadState: io.loadState,
    ensureZoneSession: async (cwd) => {
      ensureCalls.push(cwd)
      return { sessionId: 'session-zone' }
    },
    migrate: options.migrate ?? migrator.migrate,
    log: logger,
  })

  return { tool, schedule, sessionController, io, logger, ensureCalls }
}

test('repair: 默认只挑孤儿，dryRun 不建不删', async () => {
  const ctx = makeRepairContext({
    zones: { [CWD]: { sessionId: 'session-zone', title: '⚙ 自动化任务' } },
    sessions: {
      // session-ghost 不在 live 里 → inspect 抛错 → cwd 未知
      'session-zone': CWD,
      'session-orphan': CWD,
    },
    tasks: [
      { id: 'T1', title: '孤儿@本项目', sessionId: 'session-orphan' },
      { id: 'T2', title: '正常在自动化会话上', sessionId: 'session-zone' },
      { id: 'T3', title: '孤儿@cwd未知', sessionId: 'session-ghost' },
    ],
  })

  const plan = await ctx.tool.execute({ dryRun: true }, {})

  assert.equal(plan.ok, true, `dryRun 不该报错：${JSON.stringify(plan)}`)
  assert.equal(ctx.schedule.calls.create, 0, 'dryRun 不许建任务')
  assert.equal(ctx.schedule.calls.delete, 0, 'dryRun 不许删任务')
  assert.equal(ctx.ensureCalls.length, 0, 'dryRun 不许建会话')

  assert.deepEqual(
    plan.migrated.map((item) => item.from),
    ['T1'],
    `只该把 T1 列进计划（T2 在自动化会话上、T3 的 cwd 未知），实际 ${JSON.stringify(plan.migrated)}`,
  )
  assert.equal(plan.migrated[0].to, '', 'dryRun 下 to 应为空（新任务还没建）')

  const skippedIds = plan.skipped.map((item) => item.id)
  assert.ok(skippedIds.includes('T3'), `cwd 未知的任务应进 skipped，实际 ${JSON.stringify(plan.skipped)}`)
  assert.match(
    plan.skipped.find((item) => item.id === 'T3').reason,
    /cwd 未知/,
    `skipped 的原因要如实写「cwd 未知」，实际 ${JSON.stringify(plan.skipped)}`,
  )
  assert.equal(skippedIds.includes('T2'), false, '自动化会话上的任务不是孤儿，不该出现在 skipped 里')
})

test('repair: 真跑时把孤儿迁到该 cwd 的自动化会话', async () => {
  const ctx = makeRepairContext({
    zones: { [CWD]: { sessionId: 'session-zone', title: '⚙ 自动化任务' } },
    sessions: { 'session-zone': CWD, 'session-orphan': CWD },
    tasks: [
      { id: 'T1', title: '孤儿@本项目', sessionId: 'session-orphan' },
      { id: 'T2', title: '正常在自动化会话上', sessionId: 'session-zone' },
    ],
  })

  const result = await ctx.tool.execute({}, {})

  assert.equal(result.ok, true, `不该有失败：${JSON.stringify(result.failed)}`)
  assert.equal(result.migrated.length, 1, `应迁移 1 条，实际 ${JSON.stringify(result.migrated)}`)
  assert.equal(result.migrated[0].from, 'T1')
  assert.ok(result.migrated[0].to.startsWith('task-new-'), 'to 应是新任务 id')

  const moved = ctx.schedule.records.find((record) => record.title === '孤儿@本项目')
  assert.equal(moved.sessionId, 'session-zone', `任务没迁到自动化会话：${JSON.stringify(moved)}`)
  assert.equal(ctx.schedule.records.some((record) => record.id === 'T1'), false, '旧任务没被删掉（会重复投递）')

  // 已经在自动化会话上的那条不许被碰
  assert.equal(ctx.schedule.records.find((record) => record.id === 'T2')?.sessionId, 'session-zone')
})

test('repair: 给了 fromSessionId 就只迁那一个会话', async () => {
  const ctx = makeRepairContext({
    zones: { [CWD]: { sessionId: 'session-zone', title: '⚙ 自动化任务' } },
    sessions: { 'session-zone': CWD, 'session-orphan': CWD, 'session-other': OTHER_CWD },
    tasks: [
      { id: 'T1', title: '指定会话上的', sessionId: 'session-orphan' },
      { id: 'T2', title: '别处的孤儿', sessionId: 'session-other' },
    ],
  })

  const result = await ctx.tool.execute({ fromSessionId: 'session-orphan', cwd: CWD }, {})

  assert.equal(result.ok, true, `不该有失败：${JSON.stringify(result.failed)}`)
  assert.deepEqual(result.migrated.map((item) => item.from), ['T1'])
  assert.equal(
    ctx.schedule.records.find((record) => record.id === 'T2')?.sessionId,
    'session-other',
    '没点名的会话上的任务被顺手迁走了',
  )
})

// ---------------------------------------------------------------------------
// ④ migrate 抛错被吞掉并进 failed
// ---------------------------------------------------------------------------

test('repair: 迁移器抛错只进 failed，不抛出、不中断其它会话', async () => {
  const ctx = makeRepairContext({
    zones: { [CWD]: { sessionId: 'session-zone', title: '⚙ 自动化任务' } },
    sessions: { 'session-zone': CWD, 'session-orphan-a': CWD, 'session-orphan-b': CWD },
    tasks: [
      { id: 'T1', title: 'A 组的', sessionId: 'session-orphan-a' },
      { id: 'T2', title: 'B 组的', sessionId: 'session-orphan-b' },
    ],
    migrate: async () => {
      throw new Error('boom: catalog 挂了')
    },
  })

  let result
  try {
    result = await ctx.tool.execute({}, {})
  } catch (error) {
    assert.fail(`迁移器抛错不该冒到工具外面：${error?.stack || error}`)
  }

  assert.equal(result.ok, false, '有失败时 ok 应为 false')
  assert.equal(result.failed.length, 2, `两个会话各应记一条 failed（证明没中断），实际 ${JSON.stringify(result.failed)}`)
  for (const item of result.failed) {
    assert.equal(item.code, 'migrate_failed', `code 应为 migrate_failed，实际 ${item.code}`)
    assert.match(item.message, /boom/, `message 要带真实原因，实际 ${item.message}`)
  }
  assert.equal(result.migrated.length, 0)
  assert.ok(hasWarn(ctx.logger, '迁移会话'), `应当记 warn，实际 ${JSON.stringify(ctx.logger.lines)}`)
  assert.ok(ctx.logger.lines.some((line) => line.includes(LOG_PREFIX)), '日志应带统一前缀，便于在 host 日志里定位')
})

// ---------------------------------------------------------------------------
// 工具接口契约（schema 登记不全会让整个结果被拒收）
// ---------------------------------------------------------------------------

test('repair: output.schema 登记了 ok/migrated/failed/skipped 四个键', () => {
  const tool = createRepairTasksTool({
    schedule: makeFakeSchedule([]),
    sessionController: makeFakeSessionController({}),
    loadState: () => ({ version: 1, zones: {}, throttle: {}, tasks: {} }),
    ensureZoneSession: async () => ({ sessionId: 'x' }),
    migrate: async () => ({ migrated: [], failed: [] }),
    log: makeLogger(),
  })

  assert.equal(tool.name, REPAIR_TOOL_NAME)
  for (const key of ['ok', 'migrated', 'failed', 'skipped']) {
    assert.ok(key in tool.output.schema.properties, `output.schema.properties 少了 ${key}（整个结果会被拒收）`)
  }
  assert.equal(tool.parameters.type, 'object', 'parameters 必须是标准 JSON Schema 对象根')
  assert.ok(Array.isArray(tool.parameters.required), 'parameters.required 必须是数组')
  assert.equal(typeof tool.output.render, 'function', 'output.render 必填（缺了 tools.register 直接抛 TypeError）')
})
