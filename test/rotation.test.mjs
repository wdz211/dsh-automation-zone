// @ts-check
/**
 * rotation.test.mjs —— 覆盖「会话轮换 + 定时任务自动迁移」（CONTRACT.md §3.11）。
 *
 * 三组：
 *  ① `selectorFromRecord`：六种 kind 的重建 + 三种坏记录（不抛，返回 unsupported_record）
 *  ② `createTaskMigrator`：先建后删、闸门改键、单条失败不中断、读失败不写盘
 *  ③ zone 轮换路径：该换就换并迁移、不该换就复用、判据抛错 fail-open、迁移抛错仍换
 *
 * 全部依赖注入：schedule 是普通对象 mock，状态文件一律落到 os.tmpdir() 下的临时目录，
 * 结尾还会断言真实 `~/.dsh-beta/automation-zone.json` 一个字节都没被碰过。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { createEnsureZoneSession } from '../src/zone.js'
import { createTaskMigrator, selectorFromRecord } from '../src/rotation.js'
import { loadState, saveState as writeStateFile } from '../src/storage.js'
import {
  assertRealStateFileUntouched,
  ensureParentDir,
  makeLogger,
  makeMockDeps,
  makeTmpDir,
  readJsonIfExists,
  rmTmp,
  snapshotRealStateFile,
} from './_harness.mjs'

// 任何用例跑起来之前拍快照：轮换/migrator 会写状态文件，绝不能写到真实家目录。
const realStateBefore = snapshotRealStateFile()

const CWD = 'D:\\projects\\demo'
const OLD = 'session-old-0001'
const NEW = 'session-new-0001'
const NOW_MS = Date.parse('2026-11-06T00:00:00.000Z')

/** 每个用例独立沙箱：临时状态文件 + 一个记录写盘次数的 saveState。 */
function makeStore(t, options = {}) {
  const dir = makeTmpDir('azone-rotation')
  const stateFile = ensureParentDir(join(dir, 'automation-zone.json'))
  const logger = makeLogger()
  const saves = []
  t.after(() => rmTmp(dir))
  if (options.seed !== undefined) writeStateFile(stateFile, options.seed)
  return {
    dir,
    stateFile,
    logger,
    saves,
    loadState: () => (options.readError === undefined
      ? loadState(stateFile, logger)
      : { version: 1, zones: {}, throttle: {}, tasks: {}, readError: options.readError }),
    saveState: (state) => {
      saves.push(state)
      if (options.readError === undefined) writeStateFile(stateFile, state)
    },
    read: () => readJsonIfExists(stateFile),
  }
}

/** mock schedule：create 真入队、delete 真出队，另带三种故障注入开关。 */
function makeScheduleMock(records, options = {}) {
  const all = records.map((r) => ({ ...r }))
  const calls = { catalog: 0, create: [], delete: [] }
  let seq = 0
  return {
    records: all,
    calls,
    async catalog() {
      calls.catalog += 1
      if (options.catalogThrows === true) throw new Error('catalog boom')
      return all.map((r) => ({ ...r }))
    },
    async create(sessionId, request) {
      calls.create.push({ sessionId, request })
      if (options.createThrows === true) {
        const error = new Error('create boom')
        error.code = 'invalid_prompt'
        throw error
      }
      seq += 1
      const record = { id: `schedule-new-${seq}`, sessionId, status: 'active', ...request }
      all.push(record)
      return record
    },
    async delete(key) {
      calls.delete.push({ ...key })
      if (options.deleteThrows === true) throw new Error('delete boom')
      if (options.deleteRefuses === true) return { id: key.id, deleted: false, code: 'not_found' }
      const at = all.findIndex((r) => r.id === key.id && r.sessionId === key.sessionId)
      if (at < 0) return { id: key.id, deleted: false, code: 'not_found' }
      all.splice(at, 1)
      return { id: key.id, deleted: true }
    },
  }
}

const dailyRecord = (id, overrides = {}) => ({
  id,
  sessionId: OLD,
  status: 'active',
  kind: 'daily',
  title: `任务-${id}`,
  prompt: `prompt-${id}`,
  time: '03:00:00.000',
  timeZone: 'Asia/Shanghai',
  ...overrides,
})

const warnText = (logger) => logger.lines.filter((l) => l.startsWith('[warn]')).join('\n')

// ---------------------------------------------------------------------------
// ① selectorFromRecord
// ---------------------------------------------------------------------------

test('selectorFromRecord：daily / weekly / cron / every / after 各一条正确重建', () => {
  assert.deepEqual(selectorFromRecord({ kind: 'daily', time: '03:00:00.000', timeZone: 'Asia/Shanghai' }, NOW_MS), {
    ok: true,
    selector: { daily: { time: '03:00:00.000', time_zone: 'Asia/Shanghai' } },
  })
  assert.deepEqual(
    selectorFromRecord({ kind: 'weekly', time: '09:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [1, 3] }, NOW_MS),
    { ok: true, selector: { weekly: { time: '09:00:00.000', time_zone: 'Asia/Shanghai', weekdays: [1, 3] } } },
  )
  assert.deepEqual(selectorFromRecord({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'Asia/Shanghai' }, NOW_MS), {
    ok: true,
    selector: { cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'Asia/Shanghai' } },
  })
  assert.deepEqual(selectorFromRecord({ kind: 'every', everySeconds: 3600 }, NOW_MS), {
    ok: true,
    selector: { every_seconds: 3600 },
  })
  // at / after 都按「距原定时刻还剩几秒」搬到新会话：绝对时刻直接照搬多半已经过期。
  assert.deepEqual(selectorFromRecord({ kind: 'after', scheduledAt: '2026-11-06T00:02:00.000Z' }, NOW_MS), {
    ok: true,
    selector: { after_seconds: 120 },
  })
})

test('selectorFromRecord：at 已过期 → overdue_oneshot，不迁移（绝不夹成 1 秒立刻触发）', () => {
  // 为什么必须拒：旧任务在 delete 之前可能已经被 schedule drive 投递过，
  // 夹成「1 秒后触发」等于在新会话上把同一件事再外发一次。
  const past = selectorFromRecord({ kind: 'at', scheduledAt: '2026-11-05T00:00:00.000Z' }, NOW_MS)
  assert.equal(past.ok, false, '过期的一次性任务不许迁移')
  assert.equal(past.code, 'overdue_oneshot')
  assert.equal(typeof past.reason, 'string')
  assert.equal(past.selector, undefined, '失败时不许带 selector')

  // 恰好到点（剩余 0）同样是过期：这一刻它已经该触发过了，不能再补一次。
  const exactly = selectorFromRecord({ kind: 'after', scheduledAt: '2026-11-06T00:00:00.000Z' }, NOW_MS)
  assert.equal(exactly.ok, false)
  assert.equal(exactly.code, 'overdue_oneshot')

  // 还没到点的仍然照迁：不足 1 秒要抬到 1，否则 schedule 会当成过去一次都不触发。
  const nearly = selectorFromRecord({ kind: 'at', scheduledAt: '2026-11-06T00:00:00.200Z' }, NOW_MS)
  assert.equal(nearly.ok, true)
  assert.equal(nearly.selector.after_seconds, 1, '不足 1 秒的剩余时间也要抬到 1')
})

test('selectorFromRecord：不认识的 kind / 缺字段 / 坏时间都返回 unsupported_record，不抛', () => {
  for (const record of [
    { kind: 'monthly', time: '03:00:00.000', timeZone: 'Asia/Shanghai' },
    { kind: 'daily', timeZone: 'Asia/Shanghai' },
    { kind: 'weekly', time: '09:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [] },
    { kind: 'cron', timeZone: 'Asia/Shanghai' },
    { kind: 'every', everySeconds: '3600' },
    { kind: 'at', scheduledAt: 'not-a-date' },
    { kind: 'after' },
    null,
    'nonsense',
  ]) {
    const picked = selectorFromRecord(record, NOW_MS)
    assert.equal(picked.ok, false, `应当拒绝：${JSON.stringify(record)}`)
    assert.equal(picked.code, 'unsupported_record')
    assert.equal(typeof picked.reason, 'string')
    assert.equal(picked.selector, undefined, '失败时不许带 selector')
  }
})

// ---------------------------------------------------------------------------
// ② createTaskMigrator
// ---------------------------------------------------------------------------

test('migrator：旧会话上的 active 任务被建到新会话，旧 id 被 delete（先建后删）', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([dailyRecord('schedule-a')])
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.equal(result.ok, true, `迁移应当成功：${JSON.stringify(result)}`)
  assert.deepEqual(result.migrated, [{ from: 'schedule-a', to: 'schedule-new-1', title: '任务-schedule-a' }])
  assert.deepEqual(result.failed, [])

  // 新任务落在新会话上，且触发方式被逐字重建（daily → time + time_zone）
  assert.equal(schedule.calls.create.length, 1)
  assert.equal(schedule.calls.create[0].sessionId, NEW)
  assert.deepEqual(schedule.calls.create[0].request, {
    title: '任务-schedule-a',
    prompt: 'prompt-schedule-a',
    daily: { time: '03:00:00.000', time_zone: 'Asia/Shanghai' },
  })
  // 旧任务按「旧会话 + 旧 id」删掉（顺序：create 之后才 delete）
  assert.deepEqual(schedule.calls.delete, [{ sessionId: OLD, id: 'schedule-a' }])
  assert.equal(schedule.records.length, 1, '迁完后应当只剩新会话上那一条')
})

test('migrator：闸门登记整键搬到新 scheduleId，streak/lastSpokeAt/note 原样保留（只写一次盘）', async (t) => {
  const store = makeStore(t, {
    seed: {
      version: 1,
      zones: { [CWD]: { sessionId: OLD, title: '⚙ 自动化任务' } },
      throttle: { [CWD]: { streak: 2, lastSpokeAt: 111 } },
      tasks: { 'schedule-a': { enabled: true, streak: 3, lastSpokeAt: 222, note: '周一早报' } },
    },
  })
  const schedule = makeScheduleMock([dailyRecord('schedule-a')])
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.equal(result.gateRemapped, 1)
  const state = store.read()
  assert.deepEqual(state.tasks['schedule-new-1'], { enabled: true, streak: 3, lastSpokeAt: 222, note: '周一早报' })
  assert.equal(state.tasks['schedule-a'], undefined, '旧 scheduleId 的登记必须删掉，否则同一件事会有两条曲线')
  // 其它几节必须原样带过去（serialize 是白名单重建，漏一节就是静默丢失）
  assert.equal(state.throttle[CWD].streak, 2)
  assert.equal(state.zones[CWD].sessionId, OLD, '闸门改键不该顺手改 zones')
  assert.equal(store.saves.length, 1, `整批只该写一次盘，实际 ${store.saves.length} 次`)
})

test('migrator：旧会话上没有 active 任务时正常返回空迁移结果（不建不删不写盘）', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([
    dailyRecord('schedule-other', { sessionId: 'session-someone-else' }),
    dailyRecord('schedule-done', { status: 'inactive' }),
  ])
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.deepEqual(result.migrated, [])
  assert.deepEqual(result.failed, [])
  assert.equal(result.gateRemapped, 0)
  assert.equal(schedule.calls.create.length, 0, '别的会话的任务不许动')
  assert.equal(schedule.calls.delete.length, 0)
  assert.equal(store.saves.length, 0)
})

test('migrator：单条 record 坏掉只进 failed，其余任务照迁（不中断、不抛）', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([
    dailyRecord('schedule-a'),
    { id: 'schedule-bad', sessionId: OLD, status: 'active', kind: 'monthly', title: '坏任务', prompt: 'p' },
    dailyRecord('schedule-c'),
  ])
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.equal(result.migrated.length, 2, `两条好任务都该迁走，实际 ${JSON.stringify(result.migrated)}`)
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, 'schedule-bad')
  assert.equal(result.failed[0].code, 'unsupported_record')
  assert.equal(result.ok, false, '有失败时 ok 必须是 false（否则调用方以为整批成功）')
  assert.match(warnText(store.logger), /无法重建触发方式/, '坏记录必须留 warn（人工要能找到它）')
  // 坏的那条不能被删：留在原地至少还能被人工修
  assert.equal(schedule.calls.delete.some((c) => c.id === 'schedule-bad'), false)
})

test('migrator：delete 被拒绝时只 warn 不抛，新旧两条都在（重复投递必须留痕）', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([dailyRecord('schedule-a')], { deleteRefuses: true })
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.deepEqual(result.migrated, [], '旧任务没删掉就不算迁成功')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].code, 'not_found')
  assert.match(warnText(store.logger), /同时投递/, '重复投递是用户可见的异常，必须写明')
  assert.match(warnText(store.logger), /人工/, '并且要说清这是需要人处理的')
})

test('migrator：create 抛错时旧任务留在原地（先建后删，建失败一条都不丢）', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([dailyRecord('schedule-a')], { createThrows: true })
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.deepEqual(result.migrated, [])
  assert.equal(result.failed[0].code, 'invalid_prompt', '要把上游的 code 原样透出（与工具层同一口径）')
  assert.equal(schedule.calls.delete.length, 0, '建失败就绝不能删旧任务')
  assert.equal(schedule.records.length, 1)
})

test('migrator：过期一次性任务只进 failed，不 create 不 delete（不制造重复外发）', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([
    dailyRecord('schedule-a'),
    {
      id: 'schedule-overdue',
      sessionId: OLD,
      status: 'active',
      kind: 'at',
      title: '过期任务',
      prompt: 'p',
      scheduledAt: '2026-11-05T00:00:00.000Z',
    },
  ])
  const { migrate } = createTaskMigrator({
    schedule,
    loadState: store.loadState,
    saveState: store.saveState,
    log: store.logger,
    now: () => NOW_MS,
  })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.equal(result.migrated.length, 1, '没过期的照迁')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, 'schedule-overdue')
  assert.equal(result.failed[0].code, 'overdue_oneshot')
  assert.equal(result.ok, false)
  assert.equal(schedule.calls.create.length, 1, '过期那条绝不能 create（一建就等于立刻补发一次）')
  assert.equal(schedule.calls.delete.some((c) => c.id === 'schedule-overdue'), false, '也不能删：留在原地等人工决定是否重建')
  assert.equal(schedule.records.length, 2, '过期那条应原样留在旧会话上')
  assert.match(warnText(store.logger), /已过期|无法重建触发方式/, '必须留 warn（人工要能找到它）')
})

test('migrator：delete 抛错时不抛给调用方，旧任务进 failed 并 warn「新旧两条会同时投递」', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([dailyRecord('schedule-a')], { deleteThrows: true })
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.deepEqual(result.migrated, [], '旧任务删不掉就不算迁成功')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, 'schedule-a')
  assert.equal(result.failed[0].code, 'delete_failed')
  assert.equal(result.ok, false)
  assert.equal(result.gateRemapped, 0, '没迁成功就不该改闸门键')
  // 删不掉最坏的后果是同一件事在两个会话上各触发一次：这必须留一条 warn。
  assert.match(warnText(store.logger), /同时投递/, '重复投递是用户可见的异常，必须写明')
  assert.match(warnText(store.logger), /delete boom/, 'warn 要带真实报错原因')
  assert.equal(schedule.records.length, 2, '新建的 + 删不掉的旧条都在，这正是重复投递的来源')
})

test('migrator：状态文件读不出来时闸门登记不改键，且绝不写盘（fail-closed）', async (t) => {
  const store = makeStore(t, { readError: 'cannot read state file <tmp>: EACCES' })
  const schedule = makeScheduleMock([dailyRecord('schedule-a')])
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.equal(result.migrated.length, 1, '任务本身还是要迁（迁移与闸门记账是两件事）')
  assert.equal(result.gateRemapped, 0)
  assert.equal(store.saves.length, 0, '读失败时写回空表 = 删掉别的项目的 zones + throttle')
  assert.match(warnText(store.logger), /未改键/, '必须警告：新任务需要重新登记才会被闸门管到')
})

test('migrator：catalog 抛错不抛给调用方（返回 failed，由轮换侧决定怎么办）', async (t) => {
  const store = makeStore(t)
  const schedule = makeScheduleMock([], { catalogThrows: true })
  const { migrate } = createTaskMigrator({ schedule, loadState: store.loadState, saveState: store.saveState, log: store.logger })

  const result = await migrate({ cwd: CWD, fromSessionId: OLD, toSessionId: NEW })

  assert.equal(result.ok, false)
  assert.equal(result.failed[0].code, 'catalog_failed')
})

// ---------------------------------------------------------------------------
// ③ zone 轮换路径
// ---------------------------------------------------------------------------

function makeZone(t, options = {}) {
  const dir = makeTmpDir('azone-zone-rot')
  const stateFile = ensureParentDir(join(dir, 'automation-zone.json'))
  const logger = makeLogger()
  const deps = makeMockDeps({ createDelayMs: 0 })
  const migrations = []
  const recordMigrate = async (info) => {
    migrations.push({ ...info })
    return { ok: true, migrated: [], failed: [], gateRemapped: 0 }
  }
  const zone = createEnsureZoneSession({
    inspect: (sessionId) => deps.sessionController.inspect(sessionId),
    create: (request) => deps.sessionController.create(request),
    ...(options.isArchived === undefined ? {} : { isArchived: options.isArchived }),
    loadState: () => loadState(stateFile, logger),
    saveState: (state) => writeStateFile(stateFile, state),
    log: logger,
    now: () => '2026-11-06T00:00:00.000Z',
    // 'shouldRotate' in options 时才注入：不注入的用例验的就是「零行为变化」。
    ...('shouldRotate' in options ? { shouldRotate: options.shouldRotate } : {}),
    // 'migrate' in options 时才注入调用方给的版本：传 undefined 就是「不注入」。
    ...('migrate' in options ? { migrate: options.migrate } : { migrate: recordMigrate }),
  })
  t.after(() => rmTmp(dir))
  return { dir, stateFile, deps, logger, ensure: zone.ensure, migrations, read: () => readJsonIfExists(stateFile) }
}

test('zone 轮换：shouldRotate 判真 → 换新会话并把任务迁过去', async (t) => {
  const box = makeZone(t, {
    shouldRotate: async () => ({ rotate: true, bytes: 12_400_000, reason: '会话文件 12400000 字节 > 阈值 4000000' }),
  })

  const first = await box.ensure(CWD)
  const second = await box.ensure(CWD)

  assert.equal(box.deps.calls.create, 2, `新建一次 + 轮换一次，共 2 次，实际 ${box.deps.calls.create}`)
  assert.notEqual(second.sessionId, first.sessionId, '命中轮换判据后必须换到新会话')

  assert.equal(box.migrations.length, 1, '轮换必须调用 migrate（否则任务留在旧会话里继续哑火）')
  assert.equal(box.migrations[0].cwd, CWD)
  assert.equal(box.migrations[0].fromSessionId, first.sessionId)
  assert.equal(box.migrations[0].toSessionId, second.sessionId)
  assert.equal(box.migrations[0].title, '⚙ 自动化任务')

  assert.equal(second.rotated, true)
  assert.equal(second.created, true)
  assert.deepEqual(second.rotation, {
    from: first.sessionId,
    to: second.sessionId,
    reason: '会话文件 12400000 字节 > 阈值 4000000',
    bytes: 12_400_000,
    migrated: 0,
    failed: [],
    gateRemapped: 0,
  })
  assert.equal(box.read().zones[CWD].sessionId, second.sessionId, 'stateFile 必须换成新会话')
  assert.match(box.logger.lines.join('\n'), /轮换/, '轮换必须留一行 info（否则“它到底换没换”只能靠猜）')
})

test('zone 轮换：shouldRotate 判假 → 照旧复用（created:false，migrate 零调用）', async (t) => {
  const box = makeZone(t, { shouldRotate: async () => ({ rotate: false }) })

  const first = await box.ensure(CWD)
  const second = await box.ensure(CWD)

  assert.equal(box.deps.calls.create, 1)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.created, false)
  assert.equal(second.rotated, undefined, '没轮换就不许带 rotated 键')
  assert.equal(box.migrations.length, 0)
})

test('zone 轮换：shouldRotate 抛错 → fail-open 复用（一条判据查不出来不许重建会话）', async (t) => {
  const box = makeZone(t, {
    shouldRotate: async () => {
      throw new Error('stat boom')
    },
  })

  const first = await box.ensure(CWD)
  const second = await box.ensure(CWD)

  assert.equal(second.sessionId, first.sessionId, '度量失败时必须继续用旧会话')
  assert.equal(second.created, false)
  assert.equal(box.deps.calls.create, 1)
  assert.match(warnText(box.logger), /按不轮换处理/)
})

test('zone 轮换：迁移抛错 → 仍然切到新会话，只把原因放进 warning', async (t) => {
  const box = makeZone(t, {
    shouldRotate: async () => ({ rotate: true, bytes: 5_000_000, reason: '超阈值' }),
    migrate: async () => {
      throw new Error('migrate boom')
    },
  })

  const first = await box.ensure(CWD)
  const second = await box.ensure(CWD)

  assert.notEqual(second.sessionId, first.sessionId, '新会话是健康的；留在超大会话里等于必然再炸一次')
  assert.equal(second.rotated, true)
  assert.equal(typeof second.warning, 'string')
  assert.match(second.warning, /migrate boom/, 'warning 要带真实原因')
  assert.equal(box.read().zones[CWD].sessionId, second.sessionId)
  assert.match(warnText(box.logger), /需要人工迁移/)
})

test('zone 轮换：不注入 shouldRotate/migrate 时零行为变化（旧会话无限复用）', async (t) => {
  // 显式传 undefined = 两个可选项都不注入（生产里未接轮换时的形态）
  const box = makeZone(t, { shouldRotate: undefined, migrate: undefined })

  const first = await box.ensure(CWD)
  const second = await box.ensure(CWD)

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.rotated, undefined)
  assert.equal(box.deps.calls.create, 1)
})

test('zone 轮换：会话已归档时换新会话并迁移任务（顺手修复，不只是重建）', async (t) => {
  const archivedId = 'session-archived-rot'
  const box = makeZone(t, { isArchived: async (id) => id === archivedId })
  box.deps.sessionController.seed(archivedId, { cwd: CWD })
  writeStateFile(box.stateFile, {
    version: 1,
    zones: { [CWD]: { sessionId: archivedId, createdAt: '2026-10-19T13:00:00.000Z', title: '⚙ 自动化任务' } },
  })

  const rotated = await box.ensure(CWD)

  assert.notEqual(rotated.sessionId, archivedId)
  assert.equal(rotated.rotated, true)
  assert.equal(rotated.rotation.reason, '会话已被归档')
  assert.equal(box.migrations.length, 1, '归档态也要把任务迁走（旧会话里的任务用户已经看不见了）')
  assert.equal(box.migrations[0].fromSessionId, archivedId)
  assert.equal(box.migrations[0].toSessionId, rotated.sessionId)
})

test('rotation: 全程没有写入真实状态文件 ~/.dsh-beta/automation-zone.json', (t) => {
  assertRealStateFileUntouched(realStateBefore, assert)
  t.diagnostic('守卫目标：<homedir>/.dsh-beta/automation-zone.json')
})
