#!/usr/bin/env node
/**
 * 计算每个 pi 会话的用量。口径严格照抄 pi 官方实现：
 *   - 聚合函数  : packages/durable/src/harness/usage.ts 的 addUsage()
 *   - 来源清单  : packages/coding-agent/docs/session-format.md + message-types.md
 *   - 分桶键    : models 用 `provider/modelId`，tools 用工具名（官方 UsageState）
 *
 * 用法:
 *   node scripts/session-usage.mjs                 # 打印摘要表
 *   node scripts/session-usage.mjs --json out.json # 输出完整 JSON
 *   node scripts/session-usage.mjs --top 20        # 只看最贵的 20 个会话
 *
 * 约束（不破坏"不读正文"原则）:
 *   只取 usage / provider / model / role / toolName / timestamp；content 一律丢弃。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------- 官方口径：聚合

/** packages/durable/src/harness/usage.ts 的 addUsage 直译 */
function addUsage(total, usage) {
  total.input += n(usage.input);
  total.output += n(usage.output);
  total.cacheRead += n(usage.cacheRead);
  total.cacheWrite += n(usage.cacheWrite);
  total.totalTokens += n(usage.totalTokens);
  // cacheWrite1h 是 cacheWrite 的子集、reasoning 已含在 output：二者单独累加，不进 totalTokens
  if (usage.cacheWrite1h !== undefined)
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + n(usage.cacheWrite1h);
  if (usage.reasoning !== undefined)
    total.reasoning = (total.reasoning ?? 0) + n(usage.reasoning);
  total.cost.input += n(usage.cost?.input);
  total.cost.output += n(usage.cost?.output);
  total.cost.cacheRead += n(usage.cost?.cacheRead);
  total.cost.cacheWrite += n(usage.cost?.cacheWrite);
  total.cost.total += n(usage.cost?.total);
}

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const emptyUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const emptyState = () => ({ models: {}, tools: {} });

function bucket(state, bucketName, key, usage) {
  const totals = state[bucketName];
  // 官方注释：own keys only（工具可能叫 toString）；用 defineProperty 防 __proto__ 污染
  if (!Object.hasOwn(totals, key)) {
    Object.defineProperty(totals, key, { value: emptyUsage(), enumerable: true, writable: true });
  }
  addUsage(totals[key], usage);
}

function sumState(state) {
  const out = emptyUsage();
  for (const b of ["models", "tools"]) {
    for (const u of Object.values(state[b])) addUsage(out, u);
  }
  return out;
}

// ---------------------------------------------------------------- 路径解析

/** settings.json 是 jsonc（带注释/尾逗号），不能 JSON.parse */
function parseJsonc(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], d = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1"); // 去尾逗号
  return JSON.parse(out);
}

/**
 * 会话根目录可能不止一处（magpie 实证 + 官方 env 文档）：
 *   $PI_CODING_AGENT_SESSION_DIR  > settings.json 的 sessionDir > ~/.pi/agent/sessions
 * 用 sessionDir 时是"所有会话平铺在一个目录"，没有项目子目录。
 */
function resolveSessionRoots() {
  const roots = [];
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const envSession = process.env.PI_CODING_AGENT_SESSION_DIR;

  let settingsSession = undefined;
  const settingsPath = join(agentDir, "settings.json");
  if (existsSync(settingsPath)) {
    try { settingsSession = parseJsonc(readFileSync(settingsPath, "utf8"))?.sessionDir; } catch { /* 忽略 */ }
  }

  for (const [dir, source] of [
    [envSession, "env:PI_CODING_AGENT_SESSION_DIR"],
    [settingsSession, "settings.json:sessionDir"],
    [join(agentDir, "sessions"), "default"],
  ]) {
    if (dir && existsSync(dir)) roots.push({ dir: resolve(dir), source, flat: source !== "default" });
  }
  return roots;
}

/** 收集所有 .jsonl（项目子目录下也可能有子代理目录，要递归） */
function collectFiles(root) {
  const files = [];
  const walk = (dir, depth = 0) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1); // 子代理目录 <session>/0-Explore.jsonl
      } else if (e.name.endsWith(".jsonl")) {
        files.push(p);
      }
    }
  };
  walk(root);
  return files;
}

// ---------------------------------------------------------------- 扫描

/** 只读首行拿 header（ProjectIndex 的用法） */
function readHeader(file) {
  const fd = readFileSync(file, "utf8");
  const nl = fd.indexOf("\n");
  const first = nl === -1 ? fd : fd.slice(0, nl);
  try {
    const o = JSON.parse(first);
    return o?.type === "session" ? o : null;
  } catch { return null; }
}

function countLines(file) {
  let c = 0;
  for (const ch of readFileSync(file, "utf8")) if (ch === "\n") c++;
  return c;
}

/**
 * 全量扫描一个会话文件的用量。
 * @param {number} skipEntries 跳过前 N 条条目（fork 继承段，见下）
 */
function scanUsage(file, skipEntries = 0) {
  const state = emptyState();
  let entries = 0, scanned = 0, skipped = 0;
  let inconsistencies = 0;
  let modelChanges = 0, compactions = 0, usageEntries = 0, branchSummaries = 0;
  let firstTs = null, lastTs = null;

  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object") continue;

    if (o.type !== "session") entries++;
    if (skipEntries > 0 && o.type !== "session" && entries <= skipEntries) { skipped++; continue; }
    scanned++;

    const ts = o.timestamp ?? null;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }

    switch (o.type) {
      case "message": {
        const m = o.message ?? {};
        const u = m.usage;
        if (!u || typeof u !== "object") break;
        if (m.role === "assistant") {
          // 官方：models bucket 按 `provider/modelId`
          bucket(state, "models", `${m.provider ?? "?"}/${m.model ?? "?"}`, u);
        } else if (m.role === "toolResult") {
          // 官方：tools bucket 按工具名，其 usage 无 model identity
          bucket(state, "tools", m.toolName ?? "?", u);
        }
        break;
      }
      case "usage": { // kind 任意（如 cache_warm）；未知 kind 照常计入
        if (o.usage) { bucket(state, "models", `${o.provider ?? "?"}/${o.model ?? "?"}`, o.usage); usageEntries++; }
        break;
      }
      case "compaction":
        if (o.usage) { bucket(state, "models", "compaction/summary", o.usage); compactions++; }
        break;
      case "branch_summary":
        if (o.usage) { bucket(state, "models", "compaction/branch-summary", o.usage); branchSummaries++; }
        break;
      case "model_change": modelChanges++; break;
    }
  }

  // 自洽校验：totalTokens 应等于 input+output+cacheRead+cacheWrite
  for (const b of ["models", "tools"]) {
    for (const u of Object.values(state[b])) {
      const sum = u.input + u.output + u.cacheRead + u.cacheWrite;
      if (u.totalTokens !== sum) inconsistencies++;
    }
  }

  return { state, entries, scanned, skipped, inconsistencies, modelChanges, compactions, usageEntries, branchSummaries, firstTs, lastTs };
}

// ---------------------------------------------------------------- 主流程

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
};
const wantJson = getArg("--json", null);
const topN = parseInt(getArg("--top", "15"), 10);

const roots = resolveSessionRoots();
if (roots.length === 0) {
  console.error("找不到 pi 会话目录。设置 PI_CODING_AGENT_SESSION_DIR 或 PI_CODING_AGENT_DIR 后重试。");
  process.exit(1);
}

const results = [];
let scanMs = 0;
const skipped = { empty: 0, noHeader: 0 };

for (const root of roots) {
  for (const file of collectFiles(root.dir)) {
    const t0 = performance.now();

    // 实测：本机 134 个 .jsonl 里有 31 个是 0 字节空壳（文件名是纯 UUID，
    // 没有 timestamp 前缀）——spawn 了但没写进任何东西，就是僵尸会话的物证
    if (statSync(file).size === 0) { skipped.empty++; continue; }

    const header = readHeader(file);
    if (!header) { skipped.noHeader++; continue; }

    // fork 继承段：parentSession 指向源文件，本文件前 N 条是复制来的（含 usage）
    // 官方 durable 的 UsageDoc 语义一致：fork:"initial" → 新会话账本从空开始
    let inherited = 0, parentExists = false;
    if (header.parentSession && existsSync(header.parentSession)) {
      parentExists = true;
      inherited = countLines(header.parentSession) - 1; // 减掉 header 行
    }

    const s = scanUsage(file, inherited);
    scanMs += performance.now() - t0;

    const total = sumState(s.state);
    const stat = statSync(file);
    const models = Object.entries(s.state.models).map(([k, v]) => ({ key: k, ...v }));
    // 该 provider 是否上报成本：有 token 却成本为 0 视为未上报
    const unreported = models.filter((m) => (m.totalTokens > 0) && (m.cost.total === 0));

    results.push({
      file,
      sessionId: header.id,
      cwd: header.cwd,
      version: header.version,
      parentSession: header.parentSession ?? null,
      forked: Boolean(header.parentSession),
      inheritedEntries: parentExists ? inherited : 0,
      bytes: stat.size,
      modified: stat.mtimeMs,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      models,
      tools: Object.entries(s.state.tools).map(([k, v]) => ({ key: k, ...v })),
      total,
      costReported: unreported.length === 0,
      unreportedProviders: unreported.map((m) => m.key),
      entries: s.entries,
      scannedEntries: s.scanned,
      skippedInherited: s.skipped,
      _diag: {
        inconsistencies: s.inconsistencies,
        modelChanges: s.modelChanges,
        compactions: s.compactions,
        usageEntries: s.usageEntries,
        branchSummaries: s.branchSummaries,
      },
    });
  }
}

results.sort((a, b) => b.total.cost.total - a.total.cost.total || b.total.totalTokens - a.total.totalTokens);

// ---------------------------------------------------------------- 输出

const grand = emptyUsage();
const grandState = emptyState();
for (const r of results) {
  addUsage(grand, r.total);
  for (const m of r.models) bucket(grandState, "models", m.key, m);
  for (const t of r.tools) bucket(grandState, "tools", t.key, t);
}

const fmt = (x) => x.toLocaleString("en-US");
const money = (x) => `$${x.toFixed(4)}`;

console.log("=== pi 会话用量（官方口径）===");
for (const r of roots) console.log(`  目录: ${r.dir}  [${r.source}]`);
console.log(`  有效会话: ${results.length}    扫描耗时: ${scanMs.toFixed(0)}ms`);
if (skipped.empty || skipped.noHeader) {
  console.log(`  跳过: 空文件 ${skipped.empty}（0 字节 = spawn 后没写任何东西的僵尸会话）、首行无 header ${skipped.noHeader}`);
}
console.log();

if (results.length) {
  console.log(`--- 最贵的 ${Math.min(topN, results.length)} 个会话 ---`);
  console.log("cost       tokens          msgs  cwd");
  for (const r of results.slice(0, topN)) {
    const cwd = (r.cwd || "").replace(homedir(), "~");
    console.log(
      `${money(r.total.cost.total).padEnd(10)} ${fmt(r.total.totalTokens).padStart(13)} ${String(r.scannedEntries).padStart(6)}  ${cwd}${r.forked ? "  [fork]" : ""}`
    );
  }
  console.log();
}

console.log("--- 合计 ---");
console.log(`  tokens   ${fmt(grand.totalTokens)}`);
console.log(`    input       ${fmt(grand.input)}`);
console.log(`    output      ${fmt(grand.output)}`);
console.log(`    cacheRead   ${fmt(grand.cacheRead)}  (${((grand.cacheRead / Math.max(grand.totalTokens, 1)) * 100).toFixed(1)}%)`);
console.log(`    cacheWrite  ${fmt(grand.cacheWrite)}`);
console.log(`  cost     ${money(grand.cost.total)}`);
console.log();

const noCost = results.filter((r) => !r.costReported);
if (noCost.length) {
  console.log(`⚠️  ${noCost.length} 个会话有 provider 未上报成本（token 有值但 cost=0）→ 上面的 cost 是下限`);
  const prov = new Set(noCost.flatMap((r) => r.unreportedProviders));
  console.log(`   涉及: ${[...prov].slice(0, 6).join(", ")}`);
  console.log();
}

const forks = results.filter((r) => r.forked);
if (forks.length) {
  console.log(`fork 会话: ${forks.length} 个（不去重，但已跳过继承的 ${fmt(forks.reduce((a, r) => a + r.skippedInherited, 0))} 条条目）`);
  console.log();
}

const bad = results.filter((r) => r._diag.inconsistencies > 0);
console.log(`自洽校验: totalTokens === input+output+cacheRead+cacheWrite → ${results.length - bad.length}/${results.length} 通过`);
if (bad.length) console.log(`  ⚠️ ${bad.length} 个会话存在不一致（可能是 cacheWrite1h / reasoning 口径差异，需人工看）`);

if (wantJson) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(wantJson, JSON.stringify({ roots, sessions: results, grand, grandState }, null, 2));
  console.log(`\n完整结果已写入 ${wantJson}`);
}
