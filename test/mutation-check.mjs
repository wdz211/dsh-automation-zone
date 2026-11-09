#!/usr/bin/env node
// @ts-check
/**
 * mutation-check.mjs —— 变异自检：「把实现改坏 → 测试必须变红 → 逐字节恢复 → 回到全绿」。
 *
 * 判据（这是唯一能区分「真有守卫」与「看起来有守卫」的办法）：
 * 每条变异都断言「目标那一格真的被改到了」（`from` 必须恰好命中一次），否则报
 * `MUTATION-NOT-APPLIED` 而不是假绿；跑完必须校验被改文件的 sha256 与跑前一致。
 *
 * 两种模式：
 *
 *   node test/mutation-check.mjs            ← 默认 **dry-run**：只打印变异清单 + 校验每个
 *                                             `from` 在源码里仍恰好命中一次，**一个字节都不改**
 *   node test/mutation-check.mjs --apply    ← 真的跑：**在 os.tmpdir() 下的临时副本里改**，
 *                                             仓库源码全程只读，结束前断言三个源文件的
 *                                             sha256 与本脚本启动时一致
 *
 * 为什么在副本里跑而不是原地改：本脚本要完整跑 30 遍 `node test/run-all.mjs`，
 * 中途一旦崩掉 / 被杀 / 断电，原地模式会把「改坏了的源码」留在仓库里——而这份源码
 * 是已交付状态。副本模式让仓库在任意时刻都可交付，并用 sha256 断言把这件事**证明**出来
 * （而不只是承诺）。
 *
 * 可选参数：
 *   --report <path>   报告 JSON 落地位置（默认落在系统临时目录）
 *   --keep            保留临时副本目录（排查「这个变异为什么没变红」时用）
 *
 * 退出码：0 = 所有变异符合预期且恢复干净；1 = 有变异不符合预期 / 没生效 / 没恢复。
 */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const KEEP = argv.includes('--keep')
const REPORT_PATH = (() => {
  const i = argv.indexOf('--report')
  return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : undefined
})()

/** 变异涉及、且必须在跑完后逐字节恢复的源文件（相对仓库根）。 */
const SOURCE_FILES = ['src/throttle.js', 'src/storage.js', 'src/tools.js', 'src/gateinject.js']

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const shaOf = (file) => sha(readFileSync(file))

/**
 * 29 条变异（判定器 18 + 闸门 11）。`file` 是相对仓库根的路径，`from` 必须在文件里**恰好出现一次**。
 * `expect`：red = 必须把测试跑红；green = 等价变异（拆了也测不出来，故意留着当对照组）。
 * `want`：变红时**必须命中**的用例名片段（证明不是被别的用例顺手弄红的）。
 */
const MUTATIONS = [
  {
    label: 'A1-a 默认值 peakLine 20 → 25',
    file: 'src/throttle.js',
    from: '  peakLine: 20,',
    to: '  peakLine: 25,',
    expect: 'red',
    want: ['A0'],
  },
  {
    label: 'A1-b 默认值 nearFactor 0.15 → 0.2',
    file: 'src/throttle.js',
    from: '  nearFactor: 0.15,',
    to: '  nearFactor: 0.2,',
    expect: 'red',
    want: ['A0', 'A4'],
  },
  {
    label: 'A1-c 默认值 intervalMinutes 30 → 20',
    file: 'src/throttle.js',
    from: '  intervalMinutes: 30,',
    to: '  intervalMinutes: 20,',
    expect: 'red',
    want: ['A0'],
  },
  {
    label: 'A2 clamp 丢掉下界（Math.min(max, value)）',
    file: 'src/throttle.js',
    from: '  return Math.min(max, Math.max(min, value));',
    to: '  return Math.min(max, value);',
    expect: 'red',
    want: ['A3b'],
  },
  {
    label: 'A3-a 去掉 streak 的 Math.max(0, …)（能从 bonus 上看见）',
    file: 'src/throttle.js',
    from: '  const streak = Math.max(0, finiteOr(options.streak, 0));',
    to: '  const streak = finiteOr(options.streak, 0);',
    expect: 'red',
    want: ['A3'],
  },
  {
    label: 'A3-b 去掉 missBonus 的 Math.max(0, …)',
    file: 'src/throttle.js',
    from: '  const missBonus = Math.max(0, finiteOr(options.missBonus, THROTTLE_DEFAULTS.missBonus));',
    to: '  const missBonus = finiteOr(options.missBonus, THROTTLE_DEFAULTS.missBonus);',
    expect: 'red',
    want: ['A3'],
  },
  {
    label: 'A3-c 去掉 bonusCap 的 Math.max(0, …)',
    file: 'src/throttle.js',
    from: '  const bonusCap = Math.max(0, finiteOr(options.bonusCap, THROTTLE_DEFAULTS.bonusCap));',
    to: '  const bonusCap = finiteOr(options.bonusCap, THROTTLE_DEFAULTS.bonusCap);',
    expect: 'red',
    want: ['A3'],
  },
  {
    label: 'A3-d 【等价变异】只去掉 base 的 Math.max(0, …)（clamp 下界会兜住，预期仍是绿）',
    file: 'src/throttle.js',
    from: '  const base = Math.max(0, finiteOr(options.base, 0));',
    to: '  const base = finiteOr(options.base, 0);',
    expect: 'green',
    want: [],
  },
  {
    label: 'A3-e 同时去掉 base 兜底与 clamp 下界（两道防线都拆，预期红）',
    file: 'src/throttle.js',
    from: '  const base = Math.max(0, finiteOr(options.base, 0));',
    to: '  const base = finiteOr(options.base, 0);',
    expect: 'red',
    want: ['A3'],
    extra: [{ from: '  return Math.min(max, Math.max(min, value));', to: '  return Math.min(max, value);' }],
  },
  {
    label: 'A4 冷却边界 < 改成 <=',
    file: 'src/throttle.js',
    from: '    if (elapsed < cfg.cooldownMinutes) {',
    to: '    if (elapsed <= cfg.cooldownMinutes) {',
    expect: 'red',
    want: ['A7b'],
  },
  {
    label: 'A5-a emptyState() 丢掉 throttle 节',
    file: 'src/storage.js',
    from: '  return { version: STATE_VERSION, zones: {}, throttle: {}, tasks: {} };',
    to: '  return { version: STATE_VERSION, zones: {}, tasks: {} };',
    expect: 'red',
    want: ['D2'],
  },
  {
    label: 'A5-b zones 坏掉时把 throttle 也清空',
    file: 'src/storage.js',
    from: '    return { ...emptyState(), throttle, tasks };',
    to: '    return { ...emptyState(), throttle: {}, tasks };',
    expect: 'red',
    want: ['D3'],
  },
  {
    label: 'A6 判定器不再从会话解 cwd（只看参数）→ C6 必须红',
    file: 'src/tools.js',
    from: '  if (typeof agentId === "string" && agentId.length > 0) {',
    to: '  if (false && typeof agentId === "string" && agentId.length > 0) {',
    expect: 'red',
    want: ['C6'],
  },
  {
    label: 'B 解析失败退回空表（不带 readError）',
    file: 'src/storage.js',
    from:
      '    return {\n' +
      '      ...emptyState(),\n' +
      '      readError: `cannot parse state file ${target}: ${reason}${near === "" ? "" : ` (near ${near})`}`,\n' +
      '    };',
    to: '    return emptyState();',
    expect: 'red',
    want: ['C7'],
  },
  {
    // 会话历史读缓存（src/tools.js）：TTL 恒 0 = 缓存永远不命中 → 「TTL 内只 inspect 一次」必红
    label: 'C1 TTL 恒为 0（缓存永远不命中）',
    file: 'src/tools.js',
    from: '    if (nowMs - cached.atMs < ttlMs) {',
    to: '    if (nowMs - cached.atMs < 0) {',
    expect: 'red',
    want: ['TTL 内连续 3 次'],
  },
  {
    // 命中时按 now 重算（minutes + 流逝分钟）= 往「更容易开口」的激进侧偏，保守方向守卫必红
    label: 'C2 命中时返回 minutes + ageMinutes（按 now 重算）',
    file: 'src/tools.js',
    from: '      return cached.minutes;',
    to: '      return cached.minutes + (nowMs - cached.atMs) / 60000;',
    expect: 'red',
    want: ['保守方向守卫'],
  },
  {
    // 两种 undefined（inspect 抛异常 / 找不到真人消息）也写缓存 → 时机因子被固定成中性 1
    label: 'C3 两种 undefined 也写进缓存',
    file: 'src/tools.js',
    from: '    return undefined;\n' + '  }\n' + '  const events =',
    to:
      '    writeInspectCache(sessionId, { minutes: undefined, atMs: nowMs });\n' +
      '    return undefined;\n' +
      '  }\n' +
      '  const events =',
    extra: [
      {
        from: '  return undefined;\n}\n\n/** 一位小数',
        to:
          '  writeInspectCache(sessionId, { minutes: undefined, atMs: nowMs });\n' +
          '  return undefined;\n}\n\n/** 一位小数',
      },
    ],
    expect: 'red',
    want: ['inspect 抛错', 'inspect 成功但没有真人消息'],
  },
  {
    // Map 不设上限（永不淘汰）→ 条目数会随着会话数无界增长
    label: 'C4 Map 不设上限（永不淘汰）',
    file: 'src/tools.js',
    from: '  if (inspectCache.size >= INSPECT_CACHE_MAX) {',
    to: '  if (false && inspectCache.size >= INSPECT_CACHE_MAX) {',
    expect: 'red',
    want: ['Map 上限'],
  },

  // ---------------------------------------------------------------------
  // 定时任务闸门（src/gateinject.js）：每一条都在问「拆掉这个判据，会不会
  // 静默变成另一个行为」。闸门最危险的错法不是不工作，而是方向反了。
  // ---------------------------------------------------------------------
  {
    label: 'G1 只认结构化 kind（不再看 framing 文本兜底）',
    file: 'src/gateinject.js',
    from: 'const isScheduled = structured || text.includes(FRAMING_SINGLE) || text.includes(FRAMING_BATCH);',
    to: 'const isScheduled = structured;',
    expect: 'red',
    want: ['A5'],
  },
  {
    label: 'G2 tasks 的 enabled 过滤放宽成「有记录就算开」',
    file: 'src/gateinject.js',
    from: 'const scheduleId = lastUser.scheduleIds.find((id) => taskEntryOf(state, id)?.enabled === true);',
    to: 'const scheduleId = lastUser.scheduleIds.find((id) => taskEntryOf(state, id) !== undefined);',
    expect: 'red',
    want: ['D3'],
  },
  {
    label: 'G3 readError 闸门摘除（读不出来也照样判定、照样记账）',
    file: 'src/gateinject.js',
    from: '    if (readError !== undefined) {',
    to: '    if (false) {',
    expect: 'red',
    want: ['D4'],
  },
  {
    label: 'G4 同一轮备忘失效（同一条消息重掷骰子）',
    file: 'src/gateinject.js',
    from: 'const cached = decisions.get(memoKey);',
    to: 'const cached = undefined;',
    expect: 'red',
    want: ['E2'],
  },
  {
    label: 'G5 warnOnce 不再真的调 log.warn（静默失败）',
    file: 'src/gateinject.js',
    from: '      log.warn(`automation-zone: ${message}`);',
    to: '      void message;',
    expect: 'red',
    want: ['D2', 'D4'],
  },
  {
    label: 'G6 出口不再中和花括号（context 会被插值炸穿）',
    file: 'src/gateinject.js',
    from: 'return neutralizeBraces(composed',
    to: 'return (composed',
    expect: 'red',
    want: ['C3'],
  },
  {
    label: 'G7 streak 不前进（用完直接回写原值）',
    file: 'src/gateinject.js',
    from: 'const streak = nextStreak(result.decision, previous.streak);',
    to: 'const streak = previous.streak;',
    expect: 'red',
    want: ['E1', 'E2'],
  },
  {
    label: 'G8 「距上次真人说话」读不到时返回 0（当成刚说完话 = 几乎必然放行）',
    file: 'src/gateinject.js',
    from:
      '    return clamp((Number(nowMs) - at) / 60000, 0, Number.MAX_SAFE_INTEGER);\n' + '  }\n' + '  return null;',
    to: '    return clamp((Number(nowMs) - at) / 60000, 0, Number.MAX_SAFE_INTEGER);\n' + '  }\n' + '  return 0;',
    expect: 'red',
    want: ['B2'],
  },
  {
    label: 'G9 「没登记」不再等于零行为变化（未登记的任务也会被注入）',
    file: 'src/gateinject.js',
    from: 'if (scheduleId === undefined) {',
    to: 'if (false) {',
    expect: 'red',
    want: ['D1'],
  },
  {
    label: 'G10 serialize 白名单漏掉 tasks 一节（写一次就静默消失）',
    file: 'src/storage.js',
    from: 'return { version: STATE_VERSION, zones, throttle, tasks };\n}\n\n/**',
    to: 'return { version: STATE_VERSION, zones, throttle };\n}\n\n/**',
    expect: 'red',
    want: ['E3'],
  },
  {
    label: 'G11 normalizeTaskEntry 的 enabled 宽松成 truthy（脏值让闸门常年开着）',
    file: 'src/storage.js',
    from: 'const record = { enabled: source.enabled === true, streak, lastSpokeAt };',
    to: 'const record = { enabled: Boolean(source.enabled), streak, lastSpokeAt };',
    expect: 'red',
    want: ['E4'],
  },
]

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 跑一遍完整离线测试，返回 { pass, summary, failed } —— failed 只取用例名。 */
function runSuite(cwd) {
  const res = spawnSync(process.execPath, ['test/run-all.mjs'], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: '1', NODE_OPTIONS: '' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = (out.match(/汇总：.*/) || ['(没有汇总行)'])[0]
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim())
  const spawned = !res.error
  return { pass: spawned && res.status === 0, summary, failed, out }
}

/** 施加一个变异；断言 `from` 恰好命中一次（否则报「变异未生效」而不是假绿）。 */
function mutate(root, file, from, to) {
  const abs = join(root, file)
  const text = readFileSync(abs, 'utf8')
  const hit = text.split(from).length - 1
  if (hit !== 1) {
    throw new Error(`变异未生效：${file} 里 "${from.slice(0, 60)}" 命中 ${hit} 次（要求恰好 1 次）`)
  }
  writeFileSync(abs, text.replace(from, to), 'utf8')
}

/** 把插件拷到一个临时副本目录（仓库本身全程只读）。 */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'azone-mutation-'))
  const skipBackups = (src) => !/\.bak-\d{8}-\d{6}$/.test(src)
  for (const entry of ['src', 'test']) {
    cpSync(join(REPO, entry), join(root, entry), { recursive: true, filter: skipBackups })
  }
  for (const file of ['package.json', 'index.js', 'cordis.patch.yml']) {
    if (existsSync(join(REPO, file))) cpSync(join(REPO, file), join(root, file))
  }
  return root
}

function parseArgsError() {
  if (APPLY && !existsSync(join(REPO, 'src/throttle.js'))) {
    return `仓库里找不到 src/throttle.js（REPO=${REPO}）`
  }
  return null
}

// ---------------------------------------------------------------------------
// dry-run：只打印清单 + 校验每条变异的 `from` 仍恰好命中一次（只读，零写入）
// ---------------------------------------------------------------------------

if (!APPLY) {
  const argError = parseArgsError()
  if (argError) {
    console.error(`✗ ${argError}`)
    process.exit(1)
  }

  console.log('=== 变异自检 · dry-run（不会修改任何文件） ===')
  console.log(`仓库：${REPO}`)
  console.log(`模式：dry-run。要真的跑请加 --apply（会在 os.tmpdir() 的临时副本里改，仓库源码只读）`)
  console.log(`变异条数：${MUTATIONS.length}（预期红 ${MUTATIONS.filter((m) => m.expect === 'red').length} 条 · 预期绿 ${MUTATIONS.filter((m) => m.expect === 'green').length} 条等价变异）`)
  console.log('─'.repeat(78))

  let stale = 0
  for (const [index, c] of MUTATIONS.entries()) {
    const text = readFileSync(join(REPO, c.file), 'utf8')
    const parts = [{ from: c.from, to: c.to }, ...(c.extra || [])]
    const hits = parts.map((p) => text.split(p.from).length - 1)
    const fine = hits.every((n) => n === 1)
    if (!fine) stale += 1
    console.log(`${String(index + 1).padStart(2)}. ${fine ? '✓' : '✗'} ${c.label}`)
    console.log(`    文件：${c.file} · 期望：${c.expect === 'red' ? `红（命中 ${c.want.join(',') || '-'}）` : '绿（等价变异）'}`)
    if (!fine) {
      console.log(`    ⚠ from 命中次数 = ${JSON.stringify(hits)}，要求全部为 1：这条变异已经与源码脱节，--apply 会报 MUTATION-NOT-APPLIED`)
    }
  }

  console.log('─'.repeat(78))
  if (stale > 0) {
    console.log(`结论：${stale} 条变异的 from 与当前源码不匹配 —— 先修脚本再跑 --apply。`)
    process.exitCode = 1
  } else {
    console.log('结论：全部 from 仍恰好命中一次，可以跑 --apply。')
    process.exitCode = 0
  }
} else {
  // -------------------------------------------------------------------------
  // --apply：在临时副本里跑完 29 条变异，仓库源码全程只读
  // -------------------------------------------------------------------------

  const argError = parseArgsError()
  if (argError) {
    console.error(`✗ ${argError}`)
    process.exit(1)
  }

  const repoHashesBefore = Object.fromEntries(SOURCE_FILES.map((f) => [f, shaOf(join(REPO, f))]))

  const sandbox = makeSandbox()
  console.log('=== 变异自检 · apply（在临时副本里改，仓库源码只读） ===')
  console.log(`仓库（只读）：${REPO}`)
  console.log(`临时副本：  ${sandbox}`)
  console.log(`变异条数：${MUTATIONS.length}`)

  const cleanup = () => {
    if (KEEP) {
      console.log(`（--keep）临时副本保留在：${sandbox}`)
      return
    }
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }

  /** 副本必须能跑出全绿，否则「红」到底是不是变异造成的就不可信。 */
  const baseline = runSuite(sandbox)
  if (!baseline.pass) {
    console.error(`✗ 副本基线与仓库不一致（副本里就已经红了，先修实现/测试再跑变异）：${baseline.summary}`)
    console.error(baseline.out.slice(-2000))
    cleanup()
    process.exit(1)
  }
  console.log(`副本基线：${baseline.summary}`)
  console.log('─'.repeat(78))

  const results = []

  for (const c of MUTATIONS) {
    const parts = [{ file: c.file, from: c.from, to: c.to }, ...(c.extra || []).map((e) => ({ file: c.file, ...e }))]
    const touched = [...new Set(parts.map((p) => p.file))]

    // 每条变异前先按副本当前字节做快照，跑完逐字节写回（不依赖任何「上一次恢复对了」的假设）
    const snapshot = new Map(touched.map((f) => [f, readFileSync(join(sandbox, f))]))
    const beforeHashes = Object.fromEntries(touched.map((f) => [f, sha(snapshot.get(f))]))

    let run
    let error = null
    try {
      for (const p of parts) mutate(sandbox, p.file, p.from, p.to)
      run = runSuite(sandbox)
    } catch (e) {
      error = String(e && e.message ? e.message : e)
    } finally {
      for (const [f, buf] of snapshot) writeFileSync(join(sandbox, f), buf)
    }

    const afterHashes = Object.fromEntries(touched.map((f) => [f, shaOf(join(sandbox, f))]))
    const restored = touched.every((f) => afterHashes[f] === beforeHashes[f])

    if (error !== null) {
      results.push({ label: c.label, expect: c.expect, verdict: 'MUTATION-NOT-APPLIED', error, restored })
      continue
    }

    const gotRed = run.pass === false
    const verdictOk = (c.expect === 'red' && gotRed) || (c.expect === 'green' && !gotRed)
    const wantHit = c.want.length === 0 ? null : c.want.filter((k) => run.failed.some((name) => name.includes(k)))
    const verdict = verdictOk
      ? (c.expect === 'red' ? 'RED(预期)' : 'GREEN(预期-等价变异)')
      : 'UNEXPECTED'
    results.push({
      label: c.label,
      file: c.file,
      expect: c.expect,
      got: gotRed ? 'red' : 'green',
      verdict,
      summary: run.summary,
      failedWanted: wantHit,
      failedSample: run.failed.slice(0, 6),
      restored,
      beforeHashes,
      afterHashes,
    })
  }

  // 收尾 1：仓库三个源文件的 sha256 必须与启动时一致（本脚本从头到尾没碰过它们）
  const repoHashesAfter = Object.fromEntries(SOURCE_FILES.map((f) => [f, shaOf(join(REPO, f))]))
  const repoUntouched = SOURCE_FILES.every((f) => repoHashesAfter[f] === repoHashesBefore[f])

  // 收尾 2：副本也必须逐字节回到起始状态，且能重新跑出全绿
  const sandboxHashesAfter = Object.fromEntries(SOURCE_FILES.map((f) => [f, shaOf(join(sandbox, f))]))
  const sandboxRestored = SOURCE_FILES.every((f) => sandboxHashesAfter[f] === repoHashesBefore[f])

  const finalSandbox = runSuite(sandbox)
  const finalRepo = runSuite(REPO)

  console.log('')
  for (const r of results) {
    if (r.verdict === 'MUTATION-NOT-APPLIED') {
      console.log(`✗ ${r.label}`)
      console.log(`    ${r.error}`)
      continue
    }
    const mark = r.verdict.startsWith('RED') || r.verdict.startsWith('GREEN') ? '✓' : '✗'
    console.log(`${mark} ${r.label}`)
    console.log(`    期望=${r.expect} 实测=${r.got} → ${r.verdict}`)
    console.log(`    ${r.summary}`)
    if (r.failedWanted !== null) {
      console.log(`    命中的目标用例：${r.failedWanted.length > 0 ? r.failedWanted.join(',') : '（没有命中！）'}`)
    }
    if (r.failedSample.length > 0) console.log(`    失败用例样例：${JSON.stringify(r.failedSample)}`)
    console.log(`    副本恢复校验：${r.restored ? '字节一致' : '不一致！'}`)
  }

  console.log('')
  console.log(`仓库源码（${SOURCE_FILES.join(' / ')}）是否与跑前逐字节一致：${repoUntouched ? '是' : '否（有文件被动了！）'}`)
  for (const f of SOURCE_FILES) {
    console.log(`  ${f.padEnd(18)} ${repoHashesBefore[f]}${repoUntouched ? '' : ` → ${repoHashesAfter[f]}`}`)
  }
  console.log(`副本是否回到起始字节：${sandboxRestored ? '是' : '否（有变异没恢复！）'}`)
  console.log(`副本收尾全量测试：${finalSandbox.summary}`)
  console.log(`仓库收尾全量测试：${finalRepo.summary}`)

  const unexpected = results.filter((r) => r.verdict === 'UNEXPECTED' || r.verdict === 'MUTATION-NOT-APPLIED')
  const allRestored = results.every((r) => r.restored !== false)
  const ok = unexpected.length === 0 && repoUntouched && sandboxRestored && finalSandbox.pass && finalRepo.pass

  const report = {
    generatedAt: new Date().toISOString(),
    repo: REPO,
    sandbox: KEEP ? sandbox : null,
    mutationCount: MUTATIONS.length,
    results,
    repoHashesBefore,
    repoHashesAfter,
    repoUntouched,
    sandboxRestored,
    finalSandbox: finalSandbox.summary,
    finalRepo: finalRepo.summary,
    ok,
  }
  const reportPath = REPORT_PATH || join(tmpdir(), 'azone-mutation-report.json')
  try {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    console.log(`\n报告：${reportPath}（${relative(process.cwd(), reportPath) || reportPath}）`)
  } catch (error) {
    console.log(`\n报告写入失败（${error instanceof Error ? error.message : String(error)}），以上面打印的结果为准`)
  }

  cleanup()
  process.exitCode = ok ? 0 : 1
}
