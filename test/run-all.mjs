#!/usr/bin/env node
// @ts-check
/**
 * run-all.mjs —— 串行跑完 plugins/dsh-automation-zone 的全部离线测试并汇总 pass/fail。
 *
 * 用法：
 *   node plugins/dsh-automation-zone/test/run-all.mjs
 *   node plugins/dsh-automation-zone/test/run-all.mjs --verbose   # 失败时也打印完整 TAP
 *
 * 退出码：0 = 全绿；1 = 有失败/崩溃。
 * 注意：本脚本**串行**执行，一个文件跑完再跑下一个，避免任何并发干扰。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

const FILES = [
  'storage.test.mjs',
  'selector.test.mjs',
  'zone.test.mjs',
  'rotation.test.mjs',
  'repair.test.mjs',
  'prompt.test.mjs',
  'tools.test.mjs',
  'inspect-cache.test.mjs',
  'throttle.test.mjs',
  'gateinject.test.mjs',
]

const verbose = process.argv.includes('--verbose')

function runOne(file) {
  const abs = join(HERE, file)
  if (!existsSync(abs)) {
    return { file, ok: false, pass: 0, fail: 1, skipped: 0, skipReasons: [], output: `测试文件不存在：${abs}` }
  }

  const res = spawnSync(process.execPath, [abs], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1', NODE_OPTIONS: '' },
  })

  const output = `${res.stdout || ''}${res.stderr || ''}`
  const parsed = parseTap(output)

  if (res.error) {
    return { file, ok: false, ...parsed, output: `${output}\n[spawn error] ${res.error.message}` }
  }
  if (!parsed.foundSummary) {
    // 没有 TAP 汇总行：文件大概率在 import 阶段就崩了，按失败处理
    return {
      file,
      ok: false,
      ...parsed,
      fail: Math.max(parsed.fail, 1),
      output,
      note: '未找到 TAP 汇总行（可能在 import 阶段就抛错了）',
    }
  }

  return { file, ok: parsed.fail === 0, ...parsed, output, exitCode: res.status }
}

/** node:test 的 TAP 输出会把换行转义成字面量 \\n，打印前还原 */
function unescapeTap(s) {
  return String(s)
    .replace(/\\r\\n|\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
}

function parseTap(text) {
  const counts = { pass: 0, fail: 0, skipped: 0, tests: 0, foundSummary: false }
  const skipReasons = []
  const failLines = []

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const summary = line.match(/^#\s+(tests|pass|fail|cancelled|skipped|skip|todo)\s+(\d+)\s*$/)
    if (summary) {
      counts.foundSummary = true
      const key = summary[1] === 'skip' ? 'skipped' : summary[1]
      if (key === 'tests' || key === 'pass' || key === 'fail' || key === 'skipped') {
        counts[key] = Number(summary[2])
      }
      continue
    }

    if (/^not ok\s+\d+/.test(line)) {
      failLines.push(line.trim())
      // 紧跟的 YAML 诊断块里有真正的错误信息，取到下一个 not ok / ok / # 为准
      let j = i + 1
      while (j < lines.length && !/^(not ok|ok)\s+\d+/.test(lines[j]) && !/^#\s/.test(lines[j])) {
        const l = lines[j].trim()
        if (l && !l.startsWith('---') && !l.startsWith('...') && !l.startsWith('duration_ms')) failLines.push(`  ${l}`)
        j++
      }
      continue
    }

    if (/^#\s+SKIP\s+/i.test(line) || /^\s*#\s+SKIP\s+/i.test(line)) {
      skipReasons.push(line.trim())
    }
    const skipNote = line.match(/^#\s+skip\s+(\d+)\s+(.+)$/i)
    if (skipNote) skipReasons.push(skipNote[2])
  }

  // 有的版本把跳过原因写在 ok 行的 `# SKIP <reason>` 后面
  for (const line of lines) {
    const m = line.match(/^ok\s+\d+\s+.*#\s+SKIP\s+(.*)$/i)
    if (m) skipReasons.push(m[1])
  }

  return { ...counts, skipReasons: [...new Set(skipReasons)], failLines }
}

// ---------------------------------------------------------------------------

const started = Date.now()
const results = []
let total = { pass: 0, fail: 0, skipped: 0, tests: 0 }

console.log('dsh-automation-zone · 离线测试（node:test，零依赖）')
console.log(`插件目录：${relative(process.cwd(), PLUGIN_ROOT) || '.'}`)
console.log(`node：${process.version}`)
console.log('─'.repeat(72))

for (const file of FILES) {
  process.stdout.write(`▶ ${file} ... `)
  const r = runOne(file)
  results.push(r)

  total.pass += r.pass
  total.fail += r.fail
  total.skipped += r.skipped
  total.tests += r.tests || r.pass + r.fail + r.skipped

  const flag = r.ok ? 'PASS' : 'FAIL'
  console.log(`${flag}  pass=${r.pass} fail=${r.fail} skip=${r.skipped}`)

  if (r.skipReasons.length) {
    for (const reason of r.skipReasons) {
      for (const line of unescapeTap(reason).split('\n')) console.log(`    ↷ SKIP: ${line}`)
    }
  }

  if (!r.ok) {
    if (r.note) console.log(`    ! ${r.note}`)
    const detail = (r.failLines || []).join('\n')
    const body = verbose ? r.output : detail || r.output
    if (body) {
      console.log('    ── 失败详情 ──')
      const lines = unescapeTap(body).split('\n')
      for (const line of lines.slice(0, 120)) console.log(`    ${line}`)
      if (lines.length > 120) console.log('    …（截断，用 --verbose 看全文）')
    }
  }
}

console.log('─'.repeat(72))
console.log(
  `汇总：${results.length} 个测试文件 · 用例 ${total.tests} · pass ${total.pass} · fail ${total.fail} · skip ${total.skipped}`,
)
console.log(`耗时：${((Date.now() - started) / 1000).toFixed(2)}s`)

const failedFiles = results.filter((r) => !r.ok).map((r) => r.file)
if (failedFiles.length) {
  console.log(`结果：FAIL（${failedFiles.join(', ')}）`)
  process.exitCode = 1
} else if (total.pass === 0) {
  console.log('结果：没有执行任何用例（全部被跳过）—— 这不算通过，请检查 src/ 是否已落地。')
  process.exitCode = 1
} else if (total.fail === 0) {
  console.log('结果：PASS')
  process.exitCode = 0
} else {
  console.log('结果：FAIL')
  process.exitCode = 1
}
