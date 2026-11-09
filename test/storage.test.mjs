// @ts-check
/**
 * storage.test.mjs —— 覆盖 CONTRACT.md §3.1「状态文件」与验收 A6（原子写 + 可恢复）。
 *
 * 全部用例在 os.tmpdir() 下的独立临时目录里进行，绝不触碰
 * ~/.dsh-beta/automation-zone.json。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, rmSync, statSync } from 'node:fs'

import {
  bindStorage,
  describeExports,
  ensureParentDir,
  listDir,
  loadImpl,
  makeTmpDir,
  parseStateFile,
  readStateFileText,
  rmTmp,
  writeCorruptStateFile,
} from './_harness.mjs'

const impl = await loadImpl('storage')

const SKIP_REASON = impl.ok ? '' : `storage: ${impl.reason}`

/**
 * 每个用例独立建目录 + 独立绑定，保证用例之间不共享任何状态。
 * 绑定不上（导出形态不匹配）时返回 null，由调用方 skip 而不是假通过。
 */
async function withStorage(t, fn) {
  const dir = makeTmpDir('azone-storage')
  const file = ensureParentDir(join(dir, 'automation-zone.json'))
  t.after(() => rmTmp(dir))
  const api = await bindStorage(impl.mod, file)
  if (!api) {
    t.skip(`storage 导出形态无法绑定（可用导出：${describeExports(impl.mod)}）`)
    return
  }
  await fn({ dir, file, api })
}

// ---------------------------------------------------------------------------

if (!impl.ok) {
  test('storage: 实现未落地，4 个用例全部跳过', (t) => {
    t.skip(SKIP_REASON)
  })
} else {
  test('storage: 正常读写往返（cwd 原串作为 key，反斜杠不被规范化）', async (t) => {
    await withStorage(t, async ({ api }) => {
      const zones = {
        'D:\\projects\\proj': {
          sessionId: 'session-aaa',
          createdAt: '2026-10-19T13:00:00.000Z',
          title: '⚙ 自动化任务',
        },
        'D:/projects/proj': {
          sessionId: 'session-bbb',
          createdAt: '2026-10-19T14:00:00.000Z',
          title: '⚙ 自动化任务',
        },
      }

      await api.write({ version: 1, zones })
      const back = await api.read()

      assert.ok(back && typeof back === 'object', '读回应返回对象')
      assert.ok(back.zones && typeof back.zones === 'object', '读回应含 zones 对象')

      // 契约 §3.1：cwd 用原始字符串做 key，不做路径规范化。
      // 反斜杠与正斜杠必须被当成两个不同的 key。
      const keys = Object.keys(back.zones)
      assert.deepEqual(
        keys.sort(),
        Object.keys(zones).sort(),
        `cwd key 被改写了，实际得到 ${JSON.stringify(keys)}`,
      )

      for (const [cwd, expected] of Object.entries(zones)) {
        const actual = back.zones[cwd]
        assert.ok(actual, `缺少 zone: ${cwd}`)
        for (const [k, v] of Object.entries(expected)) {
          assert.deepEqual(actual[k], v, `zone[${cwd}].${k} 往返不一致`)
        }
      }
    })
  })

  test('storage: JSON 损坏时返回空表且不抛（A7 的一半）', async (t) => {
    const dir = makeTmpDir('azone-storage')
    const file = ensureParentDir(join(dir, 'automation-zone.json'))
    t.after(() => rmTmp(dir))

    const api = await bindStorage(impl.mod, file)
    if (!api) {
      t.skip(`storage 导出形态无法绑定（可用导出：${describeExports(impl.mod)}）`)
      return
    }

    writeCorruptStateFile(file, '{ "version": 1, "zones": { broken ')

    let state
    try {
      state = await api.read()
    } catch (err) {
      assert.fail(`读到损坏 JSON 时抛错了，契约要求按空表处理：${err?.stack || err}`)
    }

    assert.ok(state && typeof state === 'object', '损坏时应返回对象而不是 null/undefined')
    const zones = state.zones ?? {}
    assert.equal(typeof zones, 'object', '损坏时 zones 应是对象')
    assert.equal(Object.keys(zones).length, 0, '损坏时 zones 应为空表')
  })

  test('storage: 读失败（非 ENOENT）时带 readError，ENOENT 不带；readError 永不落盘', async (t) => {
    const dir = makeTmpDir('azone-storage')
    const file = ensureParentDir(join(dir, 'automation-zone.json'))
    t.after(() => rmTmp(dir))

    const loadState = impl.mod.loadState
    const saveState = impl.mod.saveState
    if (typeof loadState !== 'function' || typeof saveState !== 'function') {
      t.skip(`实现未导出 loadState/saveState（可用导出：${describeExports(impl.mod)}）`)
      return
    }

    // 1) 文件不存在（ENOENT）：空表就是事实，不能带 readError（否则永远不敢写盘）
    const missing = loadState(file)
    assert.deepEqual(missing.zones, {}, 'ENOENT 时应返回空表 zones')
    assert.equal(missing.readError, undefined, `ENOENT 不该带 readError，实际 ${JSON.stringify(missing.readError)}`)

    // 2) 读失败但文件“存在”：把路径换成目录，读它必抛 EISDIR（Windows/Linux 都稳定）
    rmSync(file, { force: true })
    mkdirSync(file, { recursive: true })
    const broken = loadState(file)
    assert.deepEqual(broken.zones, {}, '读失败时退化成空表（不能抛）')
    assert.equal(
      typeof broken.readError,
      'string',
      `读失败必须带 readError（这是“盘上可能有别人的记录、只是读不到”的信号），实际 ${JSON.stringify(broken.readError)}`,
    )
    assert.ok(broken.readError.length > 0, 'readError 不能是空字符串')
    // 文案要能定位：`error.message` 自己只有 "EISDIR: illegal operation on a directory, read"，
    // **不带路径**。只给原因不给路径时，用户不知道该去修哪个文件（契约 §3.1 的要求）。
    assert.ok(broken.readError.includes(file), `读失败的 readError 必须带文件路径，实际 ${broken.readError}`)
    assert.match(broken.readError, /EISDIR|EACCES|EPERM|EBUSY/i, `readError 必须带真实原因，实际 ${broken.readError}`)
    t.diagnostic(`readError=${broken.readError}`)

    // 3) JSON 解析失败与「读失败」同档：盘上那份文件（可能装着别的项目的 zones + throttle）
    //    还没被读出来，退空表 + 带 readError，写盘方必须停手。
    //    曾经的契约是「解析失败按空表重建」，实测后果是判定器照常写盘、把整表覆盖成只剩本 cwd 一条。
    rmSync(file, { recursive: true, force: true })
    writeCorruptStateFile(file, '{ "version": 1, "zones": { broken')
    const corrupt = loadState(file)
    assert.deepEqual(corrupt.zones, {}, '解析失败时返回空表')
    assert.equal(
      typeof corrupt.readError,
      'string',
      `解析失败必须带 readError（否则写盘方会拿空表覆盖盘上其它项目的记录），实际 ${JSON.stringify(corrupt.readError)}`,
    )
    assert.ok(corrupt.readError.length > 0, 'readError 不能是空字符串')
    // 文案要能定位：路径 + 原因 + 出错位置附近的原文（三者缺一都会让用户不知道修哪）
    assert.ok(corrupt.readError.includes(file), `readError 必须带文件路径，实际 ${corrupt.readError}`)
    assert.match(corrupt.readError, /parse/i, `readError 必须带真实原因，实际 ${corrupt.readError}`)
    t.diagnostic(`parse readError=${corrupt.readError}`)

    // 4) readError 是内存标记，绝不能写进文件（否则下次启动会把它当真数据读回来）
    const target = ensureParentDir(join(dir, 'copy.json'))
    t.after(() => rmTmp(dir))
    saveState(target, { version: 1, zones: {}, readError: 'EACCES: nope' })
    assert.ok(
      !readStateFileText(target).includes('readError'),
      `readError 被写进状态文件了：\n${readStateFileText(target)}`,
    )
  })

  test('storage: 原子写 —— 落盘内容完整且不留 .tmp 残留', async (t) => {
    const dir = makeTmpDir('azone-storage')
    const file = ensureParentDir(join(dir, 'automation-zone.json'))
    t.after(() => rmTmp(dir))

    const api = await bindStorage(impl.mod, file)
    if (!api) {
      t.skip(`storage 导出形态无法绑定（可用导出：${describeExports(impl.mod)}）`)
      return
    }

    const payload = {
      version: 1,
      zones: {
        'D:\\proj': { sessionId: 'session-x', createdAt: '2026-10-19T13:00:00.000Z', title: '⚙ 自动化任务' },
      },
    }

    await api.write(payload)

    // 原子写的可观测判据：契约要求「写 <file>.tmp → fs.rename」。
    // 从外部看，rename 会换掉目标文件的 inode/文件索引；而「原地截断重写」
    // 保持同一个 inode。所以覆盖写之后 ino 必须变化，否则就是非原子写
    // （进程在写一半时被杀会留下半个 JSON）。
    const inoBefore = statSync(file).ino

    // 连写两次，第二次覆盖第一次（顺带验证覆盖写不会残留旧内容）
    await api.write({ version: 1, zones: { 'D:\\proj2': { sessionId: 'session-y', title: '⚙ 自动化任务' } } })

    const inoAfter = statSync(file).ino
    if (inoBefore !== 0 && inoAfter !== 0) {
      assert.notEqual(
        inoAfter,
        inoBefore,
        `覆盖写后文件 inode 未变化（${inoBefore} → ${inoAfter}）：说明是原地截断重写，不是「写 .tmp 再 rename」，违反契约 §3.1 的原子写要求`,
      )
    } else {
      // 有的文件系统不提供 inode 身份（恒为 0），此时只能靠上面的内容完整性断言
      t.diagnostic(`当前文件系统未提供 inode（${inoBefore}→${inoAfter}），跳过 inode 判据`)
    }

    const raw = readStateFileText(file)
    assert.ok(raw.trim().length > 0, '落盘内容不能为空')

    // 落盘必须是完整可解析的 JSON（半截写入会在这里炸）
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      assert.fail(`落盘内容不是合法 JSON（非原子写或写入被截断）：${err?.message}\n原文前 200 字符：${raw.slice(0, 200)}`)
    }
    assert.deepEqual(parseStateFile(file), parsed, '重复解析结果不一致')
    assert.equal(parsed.zones['D:\\proj2'].sessionId, 'session-y', '第二次写入未生效')

    // 契约 §3.1：写 <file>.tmp → fs.rename，写完不得留 tmp 残留
    const leftover = listDir(dir).filter((name) => /\.tmp$/i.test(name) || name.includes('.tmp-'))
    assert.deepEqual(leftover, [], `目录里残留了临时文件：${JSON.stringify(leftover)}`)

    const extra = listDir(dir).filter((name) => name !== 'automation-zone.json')
    assert.deepEqual(extra, [], `状态目录出现了预期外的文件：${JSON.stringify(extra)}`)
  })

  test('storage: upsert 覆盖已有 cwd（不新增 key、不保留旧值）', async (t) => {
    const dir = makeTmpDir('azone-storage')
    const file = ensureParentDir(join(dir, 'automation-zone.json'))
    t.after(() => rmTmp(dir))

    const api = await bindStorage(impl.mod, file)
    if (!api) {
      t.skip(`storage 导出形态无法绑定（可用导出：${describeExports(impl.mod)}）`)
      return
    }
    if (typeof api.upsert !== 'function') {
      t.skip(`实现未导出 upsert 类接口（可用导出：${describeExports(impl.mod)}）`)
      return
    }

    const cwd = 'D:\\projects\\proj'
    await api.write({ version: 1, zones: {} })

    await api.upsert(cwd, { sessionId: 'session-old', createdAt: '2026-10-19T13:00:00.000Z', title: '旧' })
    let state = await api.read()
    assert.equal(state.zones[cwd]?.sessionId, 'session-old', '首次 upsert 未写入')

    await api.upsert(cwd, { sessionId: 'session-new', createdAt: '2026-10-19T15:00:00.000Z', title: '新' })
    state = await api.read()

    assert.equal(state.zones[cwd]?.sessionId, 'session-new', 'upsert 未覆盖已有 cwd')
    assert.equal(state.zones[cwd]?.title, '新', 'upsert 未覆盖 title')

    const keys = Object.keys(state.zones)
    assert.equal(keys.length, 1, `upsert 不该产生第二个 key，实际：${JSON.stringify(keys)}`)
    assert.equal(keys[0], cwd, 'upsert 的 key 不是原始 cwd 字符串')
  })
}
