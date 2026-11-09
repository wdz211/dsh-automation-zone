// @ts-check
/**
 * dsh-automation-zone 测试公共工具（零依赖，只用 node: 内置模块）。
 *
 * 三条设计原则：
 *  1. **绝不触碰真实家目录的状态文件**。zone 模块的 loadState/saveState 是可注入的，
 *     测试一律注入绑定到临时目录的闭包；注入不了就 skip，绝不退化成默认路径。
 *  2. **绑定要自证**。源码导出形态不完全确定，候选名逐个试，但只有探针真的跑通
 *     才认为绑定成功；绑定不上就明确 skip，绝不伪造通过。
 *  3. 临时目录一律 os.tmpdir()，用例之间不共享任何可变状态。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TEST_DIR = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = resolve(TEST_DIR, '..')
export const SRC_DIR = join(PLUGIN_ROOT, 'src')

/** 真实状态文件路径（只用于「不许被碰」的守卫，绝不写入） */
export const REAL_STATE_FILE = join(homedir(), '.dsh-beta', 'automation-zone.json')

/** 契约 §3.3 的六个 selector */
export const SEL_KEYS = ['daily', 'weekly', 'every_seconds', 'after_seconds', 'at', 'cron']

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function relOf(p) {
  const abs = isAbsolute(p) ? p : resolve(PLUGIN_ROOT, p)
  return abs.startsWith(PLUGIN_ROOT) ? abs.slice(PLUGIN_ROOT.length + 1) : abs
}

// ---------------------------------------------------------------------------
// 日志 / 临时目录
// ---------------------------------------------------------------------------

/** 静默 logger：记录每行，供用例断言"有没有留痕"，但不污染 stdout */
export function makeLogger() {
  const lines = []
  const push = (level) => (...args) => {
    lines.push(`[${level}] ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}`)
  }
  return {
    lines,
    log: push('log'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    child() {
      return this
    },
  }
}

export function makeTmpDir(tag = 'azone') {
  return mkdtempSync(join(tmpdir(), `${tag}-`))
}

export function rmTmp(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

export function ensureParentDir(filePath) {
  const parent = dirname(filePath)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  return filePath
}

export function listDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
}

export function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (err) {
    return { __parseError: String(err?.message || err) }
  }
}

/** 读状态文件的原始文本（原子写用例要验"落盘即完整 JSON"） */
export function readStateFileText(filePath) {
  return readFileSync(filePath, 'utf8')
}

export function parseStateFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

// ---------------------------------------------------------------------------
// 真实状态文件守卫
// ---------------------------------------------------------------------------

export function snapshotRealStateFile() {
  try {
    const st = statSync(REAL_STATE_FILE)
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 }
  }
}

export function assertRealStateFileUntouched(before, assert) {
  const after = snapshotRealStateFile()
  if (before.exists !== after.exists || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    assert.fail(
      `测试触碰了真实状态文件 ${REAL_STATE_FILE}\n  before=${safeJson(before)}\n  after=${safeJson(after)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 模块发现
// ---------------------------------------------------------------------------

const FILE_CANDIDATES = {
  storage: ['src/storage.js', 'src/storage.mjs', 'src/storage.cjs', 'src/store.js', 'src/state.js'],
  selector: ['src/selector.js', 'src/selector.mjs', 'src/selector.cjs', 'src/selectors.js', 'src/schedule.js'],
  zone: ['src/zone.js', 'src/zone.mjs', 'src/zone.cjs', 'src/zones.js', 'src/automation-zone.js'],
  tools: ['src/tools.js', 'src/tool.js', 'src/tools/index.js', 'src/tasks.js'],
  throttle: ['src/throttle.js', 'src/throttle.mjs', 'src/rate-limit.js', 'src/gate.js'],
  prompt: [
    'src/prompt.js',
    'src/prompt.mjs',
    'src/prompt.cjs',
    'src/prompts.js',
    'src/inject.js',
    'src/rule.js',
    'src/text.js',
    'src/neutralize.js',
    'src/index.js',
  ],
  gateinject: ['src/gateinject.js', 'src/gate-inject.js', 'src/gate.js', 'src/inject-gate.js'],
}

const EXPORT_HINTS = {
  storage: [
    'loadState',
    'saveState',
    'upsertZone',
    'defaultStateFile',
    'emptyState',
    'readState',
    'writeState',
    'createStorage',
  ],
  selector: [
    'pickSelector',
    'presentSelectors',
    'selectorKind',
    'selectSchedule',
    'selectSelector',
    'resolveSelector',
    'normalizeSelector',
    'validateSelector',
    'buildScheduleRequest',
  ],
  zone: ['createEnsureZoneSession', 'ensureZoneSession', 'createZoneManager', 'createZoneService', 'makeZoneManager'],
  tools: [
    'createTaskCreateTool',
    'createZoneStatusTool',
    'collectZoneStatus',
    'resolveCallerCwd',
    'CREATE_TOOL_NAME',
    'STATUS_TOOL_NAME',
    'createProactiveGateTool',
    'GATE_TOOL_NAME',
  ],
  throttle: [
    'decide',
    'THROTTLE_DEFAULTS',
    'isPeak',
    'isQuietHour',
    'timingFactor',
    'computeLine',
    'lineEquation',
    'normalizeThrottle',
  ],
  prompt: [
    'neutralizeBraces',
    'renderInjectRule',
    'INJECT_RULE_TEXT',
    'INJECT_RULE',
    'INJECT_SECTION_NAME',
    'neutralize',
    'sanitizeBraces',
  ],
  gateinject: [
    'parseScheduleOrigin',
    'minutesSinceLastHumanMessage',
    'renderGateNote',
    'createGateInjector',
    'sessionIdOfContext',
    'GATE_CONTEXT_NAME',
    'GATE_NOTE_TAG',
  ],
}

function listSourceFiles(dir, depth = 0, out = []) {
  if (!existsSync(dir) || depth > 2) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      listSourceFiles(p, depth + 1, out)
    } else if (/\.(m|c)?js$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

/** 容忍 CJS 默认导出：把 default 上的可枚举属性平铺到命名空间视图 */
async function importTolerant(file) {
  const ns = await import(pathToFileURL(file).href)
  const merged = {}
  for (const [k, v] of Object.entries(ns)) merged[k] = v
  const d = ns?.default
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) if (!(k in merged)) merged[k] = v
  }
  if (!('default' in merged) && d !== undefined) merged.default = d
  return merged
}

function hasHint(mod, hints) {
  return hints.some((h) => h in mod)
}

export function describeExports(mod) {
  const keys = Object.keys(mod || {}).filter((k) => k !== 'default')
  return keys.length ? keys.join(', ') : '(无命名导出)'
}

/**
 * 加载某个逻辑模块的实现。
 * @returns {Promise<{ok:boolean, mod?:object, file?:string, tried:string[], reason?:string}>}
 */
export async function loadImpl(kind) {
  const tried = []
  const hints = EXPORT_HINTS[kind] || []
  const explicit = (FILE_CANDIDATES[kind] || []).map((rel) => join(PLUGIN_ROOT, rel))

  if (!existsSync(SRC_DIR)) {
    return { ok: false, tried, reason: `实现尚未落地（${relOf(SRC_DIR)} 目录不存在）` }
  }

  for (const file of explicit) {
    if (!existsSync(file)) {
      tried.push(`${relOf(file)}: 不存在`)
      continue
    }
    try {
      const mod = await importTolerant(file)
      if (hasHint(mod, hints)) return { ok: true, mod, file, tried }
      tried.push(`${relOf(file)}: 无期望导出 (${describeExports(mod)})`)
    } catch (err) {
      tried.push(`${relOf(file)}: 导入失败 ${err?.message || err}`)
    }
  }

  // 兜底：扫描 src 下其它文件按导出名认领（index.js 放最后，避免插件入口的副作用先被触发）
  const others = listSourceFiles(SRC_DIR)
    .filter((f) => !explicit.includes(f))
    .sort((a, b) => (a.endsWith('index.js') ? 1 : 0) - (b.endsWith('index.js') ? 1 : 0))

  for (const file of others) {
    try {
      const mod = await importTolerant(file)
      if (hasHint(mod, hints)) return { ok: true, mod, file, tried }
    } catch (err) {
      tried.push(`${relOf(file)}: 导入失败 ${err?.message || err}`)
    }
  }

  const firstFew = tried.slice(0, 4).join(' / ')
  return {
    ok: false,
    tried,
    reason: `未找到 ${kind} 模块（尝试 ${tried.length} 个候选：${firstFew}${tried.length > 4 ? ' …' : ''}）`,
  }
}

// ---------------------------------------------------------------------------
// 通用调用适配
// ---------------------------------------------------------------------------

function pickFn(mod, names) {
  for (const n of names) {
    if (typeof mod?.[n] === 'function') return mod[n]
  }
  return null
}

function pickMethod(obj, names) {
  for (const n of names) {
    if (obj && typeof obj[n] === 'function') return obj[n].bind(obj)
  }
  return null
}

function describeArgs(args) {
  return `(${args
    .map((a) => (a && typeof a === 'object' ? `{${Object.keys(a).slice(0, 6).join(',')}}` : typeof a))
    .join(', ')})`
}

export async function callAny(fn, argLists) {
  const errors = []
  for (const args of argLists) {
    try {
      const value = await fn(...args)
      return { ok: true, value, args }
    } catch (err) {
      errors.push(`${describeArgs(args)} -> ${err?.code || ''}${err?.message || err}`)
    }
  }
  return { ok: false, errors }
}

// ---------------------------------------------------------------------------
// storage 绑定
// ---------------------------------------------------------------------------

const STORAGE_FACTORIES = [
  'createStorage',
  'createStateStore',
  'createZoneStore',
  'createStore',
  'openStorage',
  'openStateStore',
  'makeStorage',
]
const STORAGE_READ = ['read', 'load', 'readState', 'loadState', 'getState', 'loadZoneState']
const STORAGE_WRITE = ['write', 'save', 'writeState', 'saveState', 'setState', 'persist']
const STORAGE_UPSERT = ['upsert', 'upsertZone', 'setZone', 'putZone']

/** 判断 upsertZone 是不是纯函数形态（state, cwd, entry) => newState */
function looksPureUpsert(fn) {
  if (typeof fn !== 'function') return false
  try {
    const out = fn({ version: 1, zones: {} }, '__azone_probe_cwd__', { sessionId: 'session-pure' })
    return !!(out && typeof out === 'object' && out.zones && out.zones['__azone_probe_cwd__']?.sessionId === 'session-pure')
  } catch {
    return false
  }
}

function adaptStorageInstance(inst) {
  if (!inst || (typeof inst !== 'object' && typeof inst !== 'function')) return null
  const read = pickMethod(inst, STORAGE_READ)
  const write = pickMethod(inst, STORAGE_WRITE)
  if (!read || !write) return null
  const upsert = pickMethod(inst, STORAGE_UPSERT)
  return {
    via: 'instance',
    read: async (...a) => read(...a),
    write: async (state) => write(state),
    upsert: upsert ? async (cwd, rec) => upsert(cwd, rec) : null,
  }
}

/** 模块级函数形态：(loadState(file, log), saveState(file, state), upsertZone(state, cwd, entry)) */
function adaptStorageModule(mod, filePath) {
  const readFn = pickFn(mod, ['loadState', 'readState', 'loadZoneState', 'readZoneState', 'loadStateFile'])
  const writeFn = pickFn(mod, ['saveState', 'writeState', 'saveZoneState', 'writeZoneState', 'saveStateFile'])
  if (!readFn || !writeFn) return null

  const upsertFn = pickFn(mod, ['upsertZone', 'setZone', 'upsertZoneState'])
  const pure = looksPureUpsert(upsertFn)

  const api = {
    via: pure ? 'module-functions + pure upsertZone' : 'module-functions',
    read: async () => readFn(filePath),
    write: async (state) => writeFn(filePath, state),
    // 纯函数的 upsert 不落盘，必须由调用方组合「读 → upsert → 写」。
    // 这里组合的完全是模块自己导出的两个函数，断言验的还是实现的语义。
    upsert: pure
      ? async (cwd, rec) => {
          const next = upsertFn(await readFn(filePath), cwd, rec)
          await writeFn(filePath, next)
          return next
        }
      : upsertFn
        ? async (cwd, rec) => upsertFn(cwd, rec)
        : null,
  }
  return api
}

/**
 * 把 storage 实现绑定成统一的 { read, write, upsert } 视图。
 * 用「探针写-读往返」自证绑定有效，避免把调用形态不对当成实现缺陷。
 */
export async function bindStorage(mod, filePath) {
  const candidates = []

  for (const name of STORAGE_FACTORIES) {
    const f = mod?.[name]
    if (typeof f !== 'function') continue
    for (const args of [
      [{ stateFile: filePath, file: filePath, path: filePath, filePath }],
      [{ stateFile: filePath }],
      [{ file: filePath }],
      [filePath],
    ]) {
      try {
        const inst = await f(...args)
        const api = adaptStorageInstance(inst)
        if (api) candidates.push({ ...api, label: `${name}${describeArgs(args)}` })
      } catch {
        /* 形态不对 */
      }
    }
  }

  const direct = adaptStorageModule(mod, filePath)
  if (direct) candidates.push({ ...direct, label: direct.via })

  for (const api of candidates) {
    if (await probeStorage(api, filePath)) return api
  }
  return null
}

async function probeStorage(api, filePath) {
  try {
    rmTmp(filePath)
    await api.write({ version: 1, zones: { __probe__: { sessionId: 'session-probe', createdAt: 'x', title: 't' } } })
    const back = await api.read()
    return back?.zones?.__probe__?.sessionId === 'session-probe'
  } catch {
    return false
  }
}

/**
 * 同步版状态读写（给 zone.js 的 DI 用）。
 *
 * zone.js 的契约是**同步**调用 `loadState()` / `saveState(state)`；给它异步包装
 * 会让 `state.zones` 变成 undefined。所以这里返回同步闭包，并且明确探测一遍：
 * 读出来是 thenable 就返回 null，让用例 skip —— 绝不退化成默认路径写真实家目录。
 */
export function makeSyncStateIo(storageMod, stateFile, logger) {
  const load = pickFn(storageMod, ['loadState', 'readState', 'loadZoneState', 'readZoneState'])
  const save = pickFn(storageMod, ['saveState', 'writeState', 'saveZoneState', 'writeZoneState'])
  if (!load || !save) return null

  let probe
  try {
    probe = load(stateFile, logger)
  } catch {
    return null
  }
  if (probe && typeof probe.then === 'function') return null

  return {
    loadState: () => load(stateFile, logger),
    saveState: (state) => save(stateFile, state),
  }
}

// ---------------------------------------------------------------------------
// selector 绑定
// ---------------------------------------------------------------------------

const SELECTOR_FNS = [
  'pickSelector',
  'selectSchedule',
  'selectSelector',
  'resolveSelector',
  'normalizeSelector',
  'validateSelector',
  'buildScheduleRequest',
  'scheduleRequest',
]

export function bindSelector(mod) {
  const name = SELECTOR_FNS.find((n) => typeof mod?.[n] === 'function')
  if (name) return { fn: mod[name], label: name }
  if (typeof mod?.default === 'function') return { fn: mod.default, label: 'default' }
  return null
}

/** 把实现的返回值/抛错归一成 { ok, code, selector } */
export function normalizeSelectorResult(outcome) {
  if (!outcome.ok) {
    const raw = outcome.errors?.[0] || ''
    const code = /invalid_selector/i.test(raw) ? 'invalid_selector' : undefined
    return { ok: false, code, raw }
  }
  const r = outcome.value
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if ('ok' in r) {
      const selector = r.selector ?? r.value ?? r.request ?? r.schedule ?? r.picked ?? null
      return { ok: !!r.ok, code: r.code ?? r.error?.code, selector, raw: r }
    }
    return { ok: true, code: undefined, selector: r, raw: r }
  }
  return { ok: true, code: undefined, selector: r, raw: r }
}

// ---------------------------------------------------------------------------
// zone 绑定
// ---------------------------------------------------------------------------

/** mock 的 sessionController + schedule（普通对象 + 计数器） */
export function makeMockDeps(options = {}) {
  const calls = { create: 0, inspect: 0, scheduleCreate: 0 }
  const sessions = new Map()
  let seq = 0
  const createDelayMs = options.createDelayMs ?? 8

  const sessionController = {
    calls,
    sessions,
    seed(sessionId, record) {
      sessions.set(sessionId, { id: sessionId, createdAt: new Date().toISOString(), ...record })
    },
    async create(request = {}) {
      calls.create += 1
      if (createDelayMs > 0) await new Promise((r) => setTimeout(r, createDelayMs))
      seq += 1
      const sessionId = `session-mock-${seq}-${Math.random().toString(16).slice(2, 8)}`
      sessions.set(sessionId, {
        id: sessionId,
        cwd: request?.cwd,
        agentPreset: request?.agentPreset,
        createdAt: new Date().toISOString(),
      })
      return { sessionId, agentPreset: request?.agentPreset }
    },
    async inspect(sessionId) {
      calls.inspect += 1
      await new Promise((r) => setTimeout(r, 1))
      const s = sessions.get(sessionId)
      if (!s) {
        const err = new Error(`session not found: ${sessionId}`)
        err.code = 'session_not_found'
        throw err
      }
      return {
        meta: { id: s.id, cwd: s.cwd, createdAt: s.createdAt, agentPreset: s.agentPreset },
        inheritedEventCount: 0,
        events: [],
      }
    },
  }

  const scheduleRecords = []
  const schedule = {
    calls,
    records: scheduleRecords,
    async create(sessionId, request) {
      calls.scheduleCreate += 1
      const rec = { id: `task-${scheduleRecords.length + 1}`, sessionId, status: 'active', ...request }
      scheduleRecords.push(rec)
      return rec
    },
    async list({ sessionId } = {}) {
      return scheduleRecords.filter((r) => r.sessionId === sessionId && r.status === 'active')
    },
    async catalog() {
      return scheduleRecords.map((r) => ({ ...r }))
    },
    async delete() {
      return { deleted: false, code: 'not_implemented_in_mock' }
    },
  }

  return { calls, sessionController, schedule }
}

/**
 * 传给实现的全家桶上下文：键名覆盖常见命名，实现按需解构。
 * @param {{sessionController: object, schedule: object}} deps
 * @param {string} stateFile
 * @param {{loadState: Function, saveState: Function}|null} syncIo 绑定到 stateFile 的同步读写
 */
export function makeZoneContext(deps, stateFile, syncIo, loggerIn) {
  // fail-closed：没有绑定到临时文件的状态读写，实现会回落到 defaultStateFile()
  // 也就是真实家目录。宁可当场炸掉，也不能让测试悄悄写真实数据。
  if (!syncIo || typeof syncIo.loadState !== 'function' || typeof syncIo.saveState !== 'function') {
    throw new Error('makeZoneContext: 缺少绑定到临时文件的 syncIo，拒绝构造可能写真实家目录的上下文')
  }
  // 与 syncIo 共用同一个 logger：storage 层与 zone 层的告警都落到同一处，用例才能统一断言。
  const logger = loggerIn ?? makeLogger()
  const { sessionController, schedule } = deps
  return {
    // zone.js 的真实 DI 契约
    inspect: (sessionId) => sessionController.inspect(sessionId),
    create: (request) => sessionController.create(request),
    loadState: syncIo.loadState,
    saveState: syncIo.saveState,
    log: logger,
    now: () => new Date('2026-10-19T13:00:00.000Z'),

    // 兼容其它可能形态
    sessionController,
    sessions: sessionController,
    schedule,
    schedules: schedule,
    scheduleService: schedule,
    stateFile,
    statePath: stateFile,
    filePath: stateFile,
    path: stateFile,
    logger,
    config: { stateFile, statePath: stateFile, path: stateFile },
    title: undefined,
  }
}

const ZONE_SHAPES = [
  {
    id: 'createEnsureZoneSession(ctx).ensure(cwd)',
    build: (mod, ctx) => zoneFactory(mod, ctx, 'ensure', ['createEnsureZoneSession']),
  },
  {
    id: 'createZoneManager(ctx).ensureZoneSession(cwd)',
    build: (mod, ctx) => zoneFactory(mod, ctx, 'ensureZoneSession'),
  },
  {
    id: 'createZoneManager(ctx).ensure(cwd)',
    build: (mod, ctx) => zoneFactory(mod, ctx, 'ensure'),
  },
  {
    id: 'ensureZoneSession(cwd, ctx)',
    build: (mod, ctx) => (typeof mod.ensureZoneSession === 'function' ? (cwd) => mod.ensureZoneSession(cwd, ctx) : null),
  },
  {
    id: 'ensureZoneSession({cwd, ...ctx})',
    build: (mod, ctx) =>
      typeof mod.ensureZoneSession === 'function' ? (cwd) => mod.ensureZoneSession({ ...ctx, cwd }) : null,
  },
]

function zoneFactory(
  mod,
  ctx,
  method,
  names = ['createZoneManager', 'createZoneService', 'makeZoneManager', 'openZone', 'createEnsureZoneSession'],
) {
  for (const n of names) {
    const f = mod?.[n]
    if (typeof f !== 'function') continue
    try {
      const inst = f(ctx)
      if (inst && typeof inst[method] === 'function') return (cwd) => inst[method](cwd)
    } catch {
      /* 形态不对 */
    }
  }
  return null
}

/**
 * 探明实现接受的调用形态。
 *
 * 每个形态用**独立的一次性 mock + 独立临时 stateFile** 探测，并校验
 * 「创建出来的会话 cwd === 传入的 cwd」，避免把错误形态误判成正确形态。
 * storageMod 为 null 时直接返回 null —— 没有隔离的读写就无法安全探测。
 */
export async function resolveZoneShape(zoneMod, storageMod) {
  if (!storageMod) return null
  const probeCwd = 'D:\\probe\\project'

  for (const shape of ZONE_SHAPES) {
    const dir = makeTmpDir('azone-probe')
    try {
      const stateFile = ensureParentDir(join(dir, 'state.json'))
      const logger = makeLogger()
      const syncIo = makeSyncStateIo(storageMod, stateFile, logger)
      if (!syncIo) return null

      const deps = makeMockDeps({ createDelayMs: 0 })
      const ctx = makeZoneContext(deps, stateFile, syncIo)
      const ensure = shape.build(zoneMod, ctx)
      if (!ensure) continue

      const r = await ensure(probeCwd)
      const sessionId = r?.sessionId ?? r?.id
      if (!sessionId) continue

      const info = await deps.sessionController.inspect(sessionId)
      if (info?.meta?.cwd !== probeCwd) continue
      return { shape: shape.id, build: shape.build }
    } catch {
      /* 继续下一个形态 */
    } finally {
      rmTmp(dir)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 状态文件辅助（预置场景用）
// ---------------------------------------------------------------------------

export function writeStateFile(filePath, zones) {
  ensureParentDir(filePath)
  const payload = { version: 1, zones: zones || {} }
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  return payload
}

export function writeCorruptStateFile(filePath, raw = '{ this is not json ') {
  ensureParentDir(filePath)
  writeFileSync(filePath, raw, 'utf8')
  return raw
}
