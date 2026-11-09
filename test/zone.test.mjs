// @ts-check
/**
 * zone.test.mjs —— 覆盖 CONTRACT.md §3.2「确保自动化会话」与验收
 * A1（首次新建）/ A2（复用）/ A6（状态文件丢失可恢复）/ A7（损坏不崩）/ A9（并发只建一个）。
 *
 * sessionController / schedule 全部是普通对象 mock + 计数器，不连真实 DSH。
 * 状态读写一律注入绑定到临时目录的闭包 —— 实现默认走 ~/.dsh-beta，绝不能被触发。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  assertRealStateFileUntouched,
  describeExports,
  ensureParentDir,
  loadImpl,
  makeLogger,
  makeMockDeps,
  makeSyncStateIo,
  makeTmpDir,
  makeZoneContext,
  readJsonIfExists,
  resolveZoneShape,
  rmTmp,
  snapshotRealStateFile,
  writeCorruptStateFile,
  writeStateFile,
} from './_harness.mjs'

// 任何用例跑起来之前对真实状态文件拍快照，最后断言它没被动过。
const realStateBefore = snapshotRealStateFile()

const impl = await loadImpl('zone')
const storageImpl = await loadImpl('storage')
const zoneShape = impl.ok && storageImpl.ok ? await resolveZoneShape(impl.mod, storageImpl.mod) : null

const SKIP_REASON = !impl.ok
  ? `zone: ${impl.reason}`
  : !storageImpl.ok
    ? `zone: 无法建立隔离的状态读写（${storageImpl.reason}）；拒绝退化成真实家目录，故跳过`
    : `zone: 未找到可绑定的构造形态（可用导出：${describeExports(impl.mod)}）`

const CWD = 'D:\\projects\\demo'

/** 每个用例独立沙箱：独立临时目录 + 独立 mock + 独立 state 文件 */
function makeSandbox(t, options = {}) {
  const dir = makeTmpDir('azone-zone')
  const stateFile = ensureParentDir(join(dir, 'automation-zone.json'))
  const logger = makeLogger()
  const syncIo = makeSyncStateIo(storageImpl.mod, stateFile, logger)
  if (!syncIo) return null

  const deps = makeMockDeps({ createDelayMs: 0, ...options })
  // 同一个 logger 同时给 storage 层和 zone 层，告警才落在同一处可断言
  const ctx = makeZoneContext(deps, stateFile, syncIo, logger)
  const ensure = zoneShape.build(impl.mod, ctx)
  t.after(() => rmTmp(dir))
  return { dir, stateFile, deps, ctx, ensure, logger: ctx.log }
}

const sessionIdOf = (r) => r?.sessionId ?? r?.id

// ---------------------------------------------------------------------------

if (!zoneShape) {
  test('zone: 无法运行，9 个用例全部跳过', (t) => {
    t.skip(SKIP_REASON)
  })
} else {
  test(`zone 调用形态已探明：${zoneShape.shape}`, (t) => {
    t.diagnostic(zoneShape.shape)
  })

  test('zone: 首次调用 create 一次且 created:true（A1）', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')

    const r = await box.ensure(CWD)
    const sessionId = sessionIdOf(r)

    assert.ok(sessionId, `返回值缺少 sessionId：${JSON.stringify(r)?.slice(0, 300)}`)
    assert.equal(box.deps.calls.create, 1, `首次调用应恰好 create 一次，实际 ${box.deps.calls.create}`)
    assert.equal(r.created, true, `首次调用 created 应为 true，实际 ${JSON.stringify(r.created)}`)

    // A1 判据：返回的 sessionId 能在 inspect 里查到，且 meta.cwd 与调用者 cwd 一致
    const info = await box.deps.sessionController.inspect(sessionId)
    assert.equal(info.meta.cwd, CWD, `新建会话的 cwd 不符：${info.meta.cwd}`)

    // 契约 §3.2 步骤 4：写回 stateFile
    const state = readJsonIfExists(box.stateFile)
    assert.ok(state && !state.__parseError, `stateFile 未落盘或不可解析：${box.stateFile}`)
    assert.equal(
      state.zones?.[CWD]?.sessionId,
      sessionId,
      `stateFile 里记录的 sessionId 不符：${JSON.stringify(state)?.slice(0, 300)}`,
    )
    assert.equal(typeof state.zones?.[CWD]?.title, 'string', 'stateFile 里应记录 title')
    t.diagnostic(`新建 ${sessionId}，title=${JSON.stringify(state.zones[CWD].title)}`)
  })

  test('zone: 二次调用不 create、created:false 且 sessionId 相同（A2）', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')

    const first = await box.ensure(CWD)
    const second = await box.ensure(CWD)

    assert.equal(box.deps.calls.create, 1, `同一 cwd 第二次调用不该再 create，实际 ${box.deps.calls.create} 次`)
    assert.equal(first.sessionId, second.sessionId, '两次返回的 sessionId 不同')
    assert.equal(first.created, true, '第一次 created 应为 true')
    assert.equal(second.created, false, `第二次 created 应为 false，实际 ${JSON.stringify(second.created)}`)
  })

  test('zone: 记录失效（inspect 抛错）时重建', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')
    const deadId = 'session-dead-0001'

    // mock 里没有这个会话 → inspect 抛错
    writeStateFile(box.stateFile, {
      [CWD]: { sessionId: deadId, createdAt: '2026-10-19T13:00:00.000Z', title: '⚙ 自动化任务' },
    })

    const r = await box.ensure(CWD)
    const sessionId = sessionIdOf(r)

    assert.ok(sessionId, '应当返回新会话 id')
    assert.notEqual(sessionId, deadId, '失效记录没被替换，仍返回死会话 id')
    assert.equal(box.deps.calls.create, 1, `记录失效时应重建一次，实际 create ${box.deps.calls.create} 次`)
    assert.equal(r.created, true, `重建时 created 应为 true，实际 ${JSON.stringify(r.created)}`)
    assert.ok(box.deps.calls.inspect >= 1, '重建前应先用 inspect 探测旧记录')

    const state = readJsonIfExists(box.stateFile)
    assert.equal(state.zones?.[CWD]?.sessionId, sessionId, 'stateFile 未更新为新的 sessionId')
  })

  test('zone: cwd 不符（inspect 返回别的 cwd）时重建', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')
    const foreignId = 'session-foreign-0001'

    // 会话存在，但 cwd 是另一个项目 —— 复用等于把任务建到别人的记忆轨上
    box.deps.sessionController.seed(foreignId, { cwd: 'E:\\SomeOtherProject' })
    writeStateFile(box.stateFile, {
      [CWD]: { sessionId: foreignId, createdAt: '2026-10-19T13:00:00.000Z', title: '⚙ 自动化任务' },
    })

    const r = await box.ensure(CWD)
    const sessionId = sessionIdOf(r)

    assert.ok(sessionId, '应当返回会话 id')
    assert.notEqual(sessionId, foreignId, 'cwd 不符的旧会话被直接复用了')
    assert.equal(box.deps.calls.create, 1, `cwd 不符时应重建一次，实际 create ${box.deps.calls.create} 次`)
    assert.equal(r.created, true, `重建时 created 应为 true，实际 ${JSON.stringify(r.created)}`)

    const info = await box.deps.sessionController.inspect(sessionId)
    assert.equal(info.meta.cwd, CWD, '重建出来的会话 cwd 不对')
  })

  test('zone: 并发 5 个调用只 create 一次（A9）', async (t) => {
    // create 带 8ms 延迟，放大竞态窗口；没有按 cwd 的去重队列会在这里 create 5 次
    const box = makeSandbox(t, { createDelayMs: 8 })
    if (!box) return t.skip('无法建立隔离的状态读写')

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => box.ensure(CWD)))

    assert.equal(
      box.deps.calls.create,
      1,
      `并发 5 个调用应只 create 一次，实际 ${box.deps.calls.create} 次（缺少按 cwd 的在途 Promise 去重）`,
    )

    const ids = new Set(results.map(sessionIdOf))
    assert.equal(ids.size, 1, `并发调用返回了不同的 sessionId：${JSON.stringify([...ids])}`)

    // created 标志在并发下语义是含糊的：5 个调用共享同一次创建，实现返回同一个结果
    // 对象时它们都会看到 created:true。契约只要求"只建一个"，所以这里不锁死计数。
    const createdCount = results.filter((r) => r.created === true).length
    assert.ok(createdCount >= 1, '并发场景里至少应有一个调用报告 created:true（否则没人真的新建）')
    t.diagnostic(`并发返回 created:true 的调用数：${createdCount}/5（共享同一次创建时全为 true，属正常）`)

    const state = readJsonIfExists(box.stateFile)
    assert.deepEqual(Object.keys(state.zones ?? {}), [CWD], `stateFile 里应只有一个 zone，实际 ${JSON.stringify(Object.keys(state.zones ?? {}))}`)
    assert.equal(state.zones[CWD].sessionId, [...ids][0], 'stateFile 里的 sessionId 与返回值不一致')
  })

  test('zone: 状态文件被删掉后能重建（A6）', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')

    const first = await box.ensure(CWD)
    assert.equal(first.created, true)

    rmSync(box.stateFile, { force: true })

    const second = await box.ensure(CWD)
    assert.ok(sessionIdOf(second), '状态文件缺失时应能重建并返回新会话')
    assert.equal(box.deps.calls.create, 2, `状态文件丢失后应重建一次（累计 2），实际 ${box.deps.calls.create}`)
    assert.equal(second.created, true, `重建时 created 应为 true，实际 ${JSON.stringify(second.created)}`)

    const state = readJsonIfExists(box.stateFile)
    assert.equal(state.zones?.[CWD]?.sessionId, sessionIdOf(second), '重建后 stateFile 未写回')
  })

  test('zone: 记录指向已归档会话时重建（不复用被用户藏起来的会话）', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')
    const archivedId = 'session-archived-0001'

    // 会话本身完全正常（cwd 也对），唯一的问题是它已被归档。
    box.deps.sessionController.seed(archivedId, { cwd: CWD })
    writeStateFile(box.stateFile, {
      [CWD]: { sessionId: archivedId, createdAt: '2026-10-19T13:00:00.000Z', title: '⚙ 自动化任务' },
    })

    // 注入归档判据（生产里由 workspaceRegistry 汇总，测试里就是一个 id 集合）
    const ensure = zoneShape.build(impl.mod, { ...box.ctx, isArchived: async (id) => id === archivedId })

    const r = await ensure(CWD)
    const sessionId = sessionIdOf(r)

    assert.ok(sessionId, '应当返回会话 id')
    assert.notEqual(sessionId, archivedId, '已归档的会话被直接复用了（任务会落在用户看不见的会话里）')
    assert.equal(box.deps.calls.create, 1, `已归档时应重建一次，实际 create ${box.deps.calls.create} 次`)
    assert.equal(r.created, true, `重建时 created 应为 true，实际 ${JSON.stringify(r.created)}`)

    const info = await box.deps.sessionController.inspect(sessionId)
    assert.equal(info.meta.cwd, CWD, '重建出来的会话 cwd 不对')

    const state = readJsonIfExists(box.stateFile)
    assert.equal(state.zones?.[CWD]?.sessionId, sessionId, 'stateFile 未换成新的（可见的）会话')

    // 归档这件事必须留痕（否则用户只会看到“怎么又多了一个会话”）
    const warnLines = box.logger.lines.filter((l) => l.startsWith('[warn]'))
    assert.ok(
      warnLines.some((l) => l.includes('已被归档')),
      `应当记一条 warn 说明记录指向的会话已归档，实际：${JSON.stringify(box.logger.lines)}`,
    )
  })

  test('zone: isArchived 为 false 时照旧复用（别把归档判据做成“每次都重建”）', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')

    const ensure = zoneShape.build(impl.mod, { ...box.ctx, isArchived: async () => false })

    const first = await ensure(CWD)
    const second = await ensure(CWD)

    assert.equal(first.created, true)
    assert.equal(second.created, false, '未归档时应复用')
    assert.equal(box.deps.calls.create, 1, `未归档时只该 create 一次，实际 ${box.deps.calls.create}`)
    assert.equal(first.sessionId, second.sessionId)
  })

  test('zone: 状态文件读不出（readError）时放弃写盘，只在返回值里给 warning', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')
    const READ_ERROR = 'EACCES: permission denied, open automation-zone.json'

    // 模拟“盘上可能有一整份别人的记录，但这次读不出来”：
    // 此时若照常写回，就会把其它项目的 zone 记录整表覆盖成只剩当前 cwd。
    let saves = 0
    const ensure = zoneShape.build(impl.mod, {
      ...box.ctx,
      loadState: () => ({ version: 1, zones: {}, readError: READ_ERROR }),
      saveState: () => {
        saves += 1
      },
    })

    const r = await ensure(CWD)

    assert.ok(sessionIdOf(r), '会话该建还是要建（不能因为状态文件读不出来就让用户建不了任务）')
    assert.equal(box.deps.calls.create, 1, `应当 create 一次，实际 ${box.deps.calls.create}`)
    assert.equal(
      saves,
      0,
      `读失败时绝不许写盘（saves=${saves}）：拿一份不可信的“空表”写回会删掉其它项目的记录`,
    )
    assert.equal(readJsonIfExists(box.stateFile), null, '磁盘上不该出现被覆盖后的状态文件')

    assert.equal(typeof r.warning, 'string', `应当返回 warning（会话已建、但没记住），实际 ${JSON.stringify(r)}`)
    assert.match(String(r.warning), /EACCES/, `warning 里应带真实原因，实际 ${JSON.stringify(r.warning)}`)

    const warnLines = box.logger.lines.filter((l) => l.startsWith('[warn]'))
    assert.ok(
      warnLines.some((l) => l.includes('放弃写入')),
      `应当记一条 warn 说明放弃写入，实际：${JSON.stringify(box.logger.lines)}`,
    )
  })

  test('zone: 状态文件是非法 JSON 时不崩，记 warn 且放弃写入（A7，fail-closed）', async (t) => {
    const box = makeSandbox(t)
    if (!box) return t.skip('无法建立隔离的状态读写')
    const CORRUPT = '{ "version": 1, "zones": { oops'
    writeCorruptStateFile(box.stateFile, CORRUPT)
    const beforeBytes = readFileSync(box.stateFile)

    let result
    try {
      result = await box.ensure(CWD)
    } catch (err) {
      assert.fail(`状态文件损坏时不应抛错（契约 §3.1：记 warn 且放弃写入），实际抛了：${err?.stack || err}`)
    }

    // 会话照建（不能因为状态文件坏了就让用户建不了任务），但**不记忆**
    assert.ok(sessionIdOf(result), '损坏状态下仍应能创建并返回 sessionId')
    assert.equal(box.deps.calls.create, 1, `损坏状态下应创建一次，实际 ${box.deps.calls.create} 次`)
    assert.equal(result.created, true, `创建时 created 应为 true，实际 ${JSON.stringify(result.created)}`)

    // 关键：坏文件必须**逐字节没变**。半截 JSON 里可能装着别的项目的 zones + throttle，
    // 拿不可信的空表写回去 = 一次静默的整表覆盖（这就是 A7 要钉住的数据丢失风险）。
    const afterBytes = readFileSync(box.stateFile)
    assert.equal(
      afterBytes.equals(beforeBytes),
      true,
      `损坏文件被改写了：before=${beforeBytes.length}B after=${afterBytes.length}B，内容 ${JSON.stringify(afterBytes.toString('utf8').slice(0, 120))}`,
    )

    // 返回值要带 warning（会话建了、没记住），否则调用方以为已经落盘
    assert.equal(typeof result.warning, 'string', `应当返回 warning，实际 ${JSON.stringify(result?.warning)}`)
    assert.match(String(result.warning), /JSON|parse|解析/, `warning 里应带真实原因，实际 ${JSON.stringify(result.warning)}`)

    // 契约 §3.7：这类事件必须留痕（不能静默吞掉）
    const warnLines = box.logger.lines.filter((l) => l.startsWith('[warn]') || l.startsWith('[error]'))
    assert.ok(warnLines.length >= 1, `损坏时应记 warn，实际 logger 里没有 warn/error：${JSON.stringify(box.logger.lines)}`)
    t.diagnostic(`warn: ${warnLines[0]}`)
  })

  test('zone: 全程未写入真实状态文件 ~/.dsh-beta/automation-zone.json', (t) => {
    const before = realStateBefore
    assertRealStateFileUntouched(before, assert)
    t.diagnostic(`守卫目标：${'<homedir>'}/.dsh-beta/automation-zone.json`)
  })
}
