#!/usr/bin/env node
/**
 * 把学在浙大的作业同步进 DeskBox 待办控件。
 *
 * 为什么是这个架构：
 *   服务器上 reminders.js 每 10 分钟登录一次学在浙大并刷新 .reminder-state.json，
 *   里面已经有 title / course / ddlIso / url 四个字段，够用了。本机直接 SSH 把它
 *   拉下来即可——本机不放 ZJU 凭据，也不会多出一个 CAS 登录源（学在浙大有 429
 *   限流，登录源越少越好）。
 *
 * 为什么写完要重启 DeskBox：
 *   DeskBox 没有对 todo.json 挂 FileSystemWatcher。控件内容只在「创建 / 应用启动 /
 *   点击待办通知」这几个时机从磁盘读一次，之后一直用内存副本，任何编辑都会把整个
 *   列表回写。所以运行期间的外部写入既看不见、又会在下次编辑时被覆盖。
 *   唯一可靠的落地方式是：关闭 → 写入 → 重新启动。
 *
 * 安全边界（重要）：
 *   本脚本只碰「自己创建的、且用户尚未勾完成」的条目。用户自己加的待办永远不动；
 *   用户勾完成的同步条目会被「释放」，之后再不触碰。删除只针对状态文件里登记过
 *   的 id，不会误删。
 *
 * 用法：
 *   node deskbox/sync.js               正常同步（有变化才重启 DeskBox）
 *   node deskbox/sync.js --dry-run     只报告将要发生的改动，不写盘、不重启
 *   node deskbox/sync.js --no-restart  写盘但不重启（下次 DeskBox 启动才可见）
 *   node deskbox/sync.js --force       即使没有变化也强制写盘 + 重启
 */

import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 配置

const SSH_HOST = process.env.ZJU_SSH_HOST || "root@124.223.111.42";
const REMOTE_STATE =
  process.env.ZJU_REMOTE_STATE || "/opt/ZJU-live-better/.reminder-state.json";

// 服务器上的快照超过这个时长就认为不可信（systemd timer 挂了之类），拒绝同步
const MAX_SNAPSHOT_AGE_MINUTES = Number(
  process.env.ZJU_SNAPSHOT_MAX_AGE_MINUTES || 180
);

const DESKBOX_EXE = "C:\\Program Files\\DeskBox\\DeskBox.exe";

const DRY_RUN = process.argv.includes("--dry-run");
const NO_RESTART = process.argv.includes("--no-restart");
const FORCE = process.argv.includes("--force");
// 给计划任务用：没事发生的轮次不产生输出，日志文件里只剩真正发生过的事。
// dry-run 本来就是给人看的，不受静默影响。
const QUIET = process.argv.includes("--quiet") && !DRY_RUN;

const LOCALAPPDATA = process.env.LOCALAPPDATA;
if (!LOCALAPPDATA) throw new Error("环境变量 LOCALAPPDATA 缺失，无法定位 DeskBox 数据目录");

const DESKBOX_DATA = path.join(LOCALAPPDATA, "DeskBox", "data");
const SETTINGS_FILE = path.join(DESKBOX_DATA, "settings.json");
const WIDGETS_DIR = path.join(DESKBOX_DATA, "widgets");
// 可覆盖，便于在沙箱里试跑而不污染真实状态
const STATE_FILE =
  process.env.ZJU_SYNC_STATE || path.join(__dirname, ".sync-state.json");

// 输出先缓冲，跑完再决定要不要写出去——这样 --quiet 下「什么都没发生」
// 的轮次完全静默，而一旦真的改了待办，整轮过程又完整可见。
const _out = [];
let _didChange = false;
const log = (...args) => _out.push(args.join(" "));

function flush(force = false) {
  if (_out.length === 0) return;
  if (force || !QUIET || _didChange) console.log(_out.join("\n"));
  _out.length = 0; // 清空，避免第二次 flush 重复打印
}

// ---------------------------------------------------------------- 小工具

function readJson(file, fallback = null) {
  try {
    // DeskBox 写出来的 settings.json 带 UTF-8 BOM，JSON.parse 会直接炸
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch (err) {
    if (fallback !== null) return fallback;
    throw new Error(`读取 ${file} 失败：${err.message}`);
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function ps(script) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  ).trim();
}

// ---------------------------------------------------------------- 拉快照

function fetchSnapshot() {
  let raw;
  try {
    raw = execFileSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", SSH_HOST, `cat ${REMOTE_STATE}`],
      { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (err) {
    throw new Error(
      `SSH 拉取失败（${SSH_HOST}）：${err.stderr?.trim() || err.message}\n` +
        `确认本机到服务器的免密登录可用：ssh -o BatchMode=yes ${SSH_HOST} echo ok`
    );
  }

  const state = JSON.parse(raw);

  const updatedAt = Date.parse(state?.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) {
    throw new Error("快照里没有可解析的 updatedAt，服务器上的 reminders.js 可能没跑过");
  }

  const ageMinutes = (Date.now() - updatedAt) / 60000;
  if (ageMinutes > MAX_SNAPSHOT_AGE_MINUTES) {
    throw new Error(
      `快照已过期 ${Math.round(ageMinutes)} 分钟（上限 ${MAX_SNAPSHOT_AGE_MINUTES}）——` +
        `拒绝用陈旧数据覆盖 DeskBox。请在服务器上执行：systemctl status zju-reminders.timer`
    );
  }

  const todos = Object.values(state.todos ?? {}).filter(
    (t) => t && t.url && t.title
  );
  log(
    `[快照] ${todos.length} 条待办，更新于 ${Math.round(ageMinutes)} 分钟前`
  );
  return todos;
}

// ---------------------------------------------------------------- 映射

/**
 * 由作业 URL 派生出稳定的 32 位十六进制 id。
 * 用 md5 是为了长度和格式跟 Guid.NewGuid().ToString("N") 完全一致——
 * TodoItem.Id 本身是不透明字符串（全项目没有任何地方解析成 Guid），
 * 但保持一致能避免将来某条通知链路按 32 位长度做假设时踩坑。
 */
function itemIdFor(todo) {
  return crypto.createHash("md5").update(`zju::${todo.url}`).digest("hex");
}

/**
 * 标题后面挂上课程名。不同课程会出现同名的「第1次作业」「第二次作业」，
 * 列表里光看标题根本分不清是哪门课的。
 */
function displayText(todo) {
  return todo.course ? `${todo.title}（${todo.course}）` : todo.title;
}

function notesFor(todo) {
  return `[在学在浙大打开](${todo.url})`;
}

function buildItem(todo, existing) {
  const now = new Date().toISOString();
  return {
    id: itemIdFor(todo),
    text: displayText(todo),
    isCompleted: false,
    isImportant: false,
    colorMarker: null,
    dueDate: todo.ddlIso || null,
    recurrence: null,
    steps: [],
    notes: notesFor(todo),
    attachments: [],
    completedAt: null,
    // 保留用户已有的提醒状态，避免更新一条待办就把已经弹过的提醒重新弹一遍
    reminderLastNotifiedAt: existing?.reminderLastNotifiedAt ?? null,
    reminderDismissedForDueDate: existing?.reminderDismissedForDueDate ?? null,
    // null = 交给 DeskBox 用默认值（你设的是提前 5 分钟）；-1 才是关闭
    reminderOffsetMinutes: null,
    snoozedUntil: existing?.snoozedUntil ?? null,
    snoozeLastNotifiedAt: existing?.snoozeLastNotifiedAt ?? null,
    recurrenceSeriesId: null,
    generatedNextItemId: null,
    sortOrder: 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function dueTime(todo) {
  const t = Date.parse(todo.ddlIso ?? "");
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** 只比较我们负责的字段，用户改过的其它字段不参与判断 */
function managedFieldsEqual(a, b) {
  return a.text === b.text && a.dueDate === b.dueDate && a.notes === b.notes;
}

// ---------------------------------------------------------------- 单个控件

function planWidget(widget, todos, tracked) {
  const file = path.join(WIDGETS_DIR, widget.id, "todo.json");
  const originalText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const data = readJson(file, { version: 3, items: [] });
  if (!Array.isArray(data.items)) data.items = [];

  const existingById = new Map(data.items.map((it) => [it.id, it]));

  // 我们负责的 id 集合：状态文件登记过、且当前这条之后还要不要继续管
  const managedIds = new Set(Object.keys(tracked));

  const desired = [];
  const released = new Set(); // 用户已勾完成 → 交还给用户，此后不再触碰

  for (const todo of todos.slice().sort((a, b) => dueTime(a) - dueTime(b))) {
    const id = itemIdFor(todo);
    const existing = existingById.get(id);

    if (existing?.isCompleted) {
      released.add(id);
      continue;
    }

    const next = buildItem(todo, existing);
    desired.push({ next, existing, changed: !existing || !managedFieldsEqual(existing, next) });
  }

  const desiredIds = new Set(desired.map((d) => d.next.id));
  const removed = [...managedIds].filter((id) => !desiredIds.has(id) && existingById.has(id));

  const added = desired.filter((d) => !d.existing);
  const updated = desired.filter((d) => d.existing && d.changed);

  const changes = {
    added,
    updated,
    removed,
    released: [...released].filter((id) => managedIds.has(id)),
  };
  changes.count =
    added.length + updated.length + removed.length + changes.released.length;

  if (changes.count === 0 && !FORCE) {
    return { file, data, originalText, changes, newTracked: tracked, dirty: false };
  }

  // 构造新列表：我们的条目按 DDL 排在最前，用户自己的条目保持原有相对顺序跟在后面。
  // 只重排，不增删用户条目的任何字段。
  const ours = desired.map((d) => d.next);
  const oursIds = desiredIds;
  const theirs = data.items
    .filter((it) => !oursIds.has(it.id))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const nextItems = [...ours, ...theirs].map((it, index) => ({ ...it, sortOrder: index }));

  // 完成的条目交还用户之后就不再登记，以后无论它还在不在服务器列表里都不再动它
  const newTracked = {};
  for (const todo of todos) {
    const id = itemIdFor(todo);
    if (released.has(id)) continue;
    newTracked[id] = { title: todo.title, course: todo.course, ddlIso: todo.ddlIso, url: todo.url };
  }

  return {
    file,
    data: { version: Math.max(3, data.version ?? 3), items: nextItems },
    originalText,
    changes,
    newTracked,
    dirty: true,
  };
}

// ---------------------------------------------------------------- DeskBox 进程

function deskboxRunning() {
  try {
    const n = ps("@(Get-Process DeskBox -ErrorAction SilentlyContinue).Count");
    return Number(n) > 0;
  } catch {
    return false;
  }
}

function waitForExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!deskboxRunning()) return true;
    // 前台 sleep 不可用，用 PowerShell 的 Start-Sleep 走子进程
    try {
      ps("Start-Sleep -Milliseconds 500");
    } catch {
      /* ignore */
    }
  }
  return !deskboxRunning();
}

function stopDeskBox() {
  if (!deskboxRunning()) return false;

  // 先请求优雅关闭，让它有机会把内存里的列表落盘。
  // 桌面挂件通常没有主窗口，CloseMainWindow() 会直接返回 false——
  // 那种情况下没什么可等的，直接跳到强制结束，省掉 8 秒空等。
  let requested = false;
  try {
    requested =
      ps(
        "$closed = $false; " +
          "Get-Process DeskBox -ErrorAction SilentlyContinue | " +
          "ForEach-Object { if ($_.CloseMainWindow()) { $closed = $true } }; " +
          "if ($closed) { 'yes' } else { 'no' }"
      ) === "yes";
  } catch {
    /* ignore */
  }

  if (requested) {
    if (waitForExit(8000)) return true;
    log("[DeskBox] 优雅关闭超时，改为强制结束");
  }

  ps("Stop-Process -Name DeskBox -Force -ErrorAction SilentlyContinue");
  return waitForExit(5000);
}

function startDeskBox() {
  const attempts = [];

  // 优先复用计划任务，这样启动参数和用户登录时的自启完全一致
  try {
    const task = ps(
      "(Get-ScheduledTask -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.TaskName -like '*DeskBox*' } | " +
        "Select-Object -First 1).TaskName"
    );
    if (task) {
      attempts.push({
        how: `计划任务 ${task}`,
        run: () => ps(`Start-ScheduledTask -TaskName '${task.replace(/'/g, "''")}'`),
      });
    }
  } catch {
    /* 落到直接启动 */
  }

  attempts.push({
    how: DESKBOX_EXE,
    run: () => ps(`Start-Process -FilePath '${DESKBOX_EXE}' -ArgumentList '--startup'`),
  });

  // 关键：启动命令返回不代表进程真的起来了（计划任务可能被条件拦住），
  // 所以每种方式都要等进程出现，失败就换下一种。
  for (const attempt of attempts) {
    try {
      attempt.run();
    } catch {
      continue;
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (deskboxRunning()) return attempt.how;
      try {
        ps("Start-Sleep -Milliseconds 500");
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error("两次启动尝试都没能让 DeskBox 进程出现");
}

// ---------------------------------------------------------------- 主流程

function main() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    throw new Error(`找不到 ${SETTINGS_FILE}，确认 DeskBox 已安装并至少运行过一次`);
  }

  const widgets = (readJson(SETTINGS_FILE, {}).widgets ?? []).filter(
    (w) => w.widgetKind === "Todo" && !w.isDisabled
  );
  if (widgets.length === 0) {
    log("没有启用中的待办控件，无事可做。");
    return;
  }
  log(`[控件] 找到 ${widgets.length} 个待办控件：${widgets.map((w) => w.id).join(", ")}`);

  const todos = fetchSnapshot();
  const state = readJson(STATE_FILE, { version: 1, widgets: {} });
  state.widgets ??= {};

  const plans = widgets.map((w) =>
    planWidget(w, todos, state.widgets[w.id]?.items ?? {})
  );

  for (const [i, plan] of plans.entries()) {
    const c = plan.changes;
    if (c.count === 0) {
      log(`[控件 ${i + 1}] 无变化`);
      continue;
    }
    log(
      `[控件 ${i + 1}] 新增 ${c.added.length}，更新 ${c.updated.length}，` +
        `移除 ${c.removed.length}，交还 ${c.released.length}`
    );
    for (const d of c.added) log(`    + ${d.next.text}（${d.next.dueDate ?? "无截止"}）`);
    for (const d of c.updated) log(`    ~ ${d.next.text}`);
    for (const id of c.removed) log(`    - ${id}`);
    for (const id of c.released) log(`    ✓ ${id}（已勾完成，交还给你，后续不再改动）`);
  }

  const dirty = plans.filter((p) => p.dirty);
  if (dirty.length === 0) {
    log("全部控件均无变化，结束。");
    return;
  }

  if (DRY_RUN) {
    log("\n[dry-run] 以上为将要发生的改动，未写盘、未重启。");
    return;
  }

  _didChange = true;

  const wasRunning = deskboxRunning();
  const needRestart = wasRunning && !NO_RESTART;

  if (wasRunning && NO_RESTART) {
    log("[DeskBox] --no-restart：写盘但不重启，控件界面要等下次启动才看得到");
  }

  let stopped = false;
  try {
    if (needRestart) {
      log("[DeskBox] 正在关闭以便写入…");
      stopped = stopDeskBox();
    }

    for (const plan of dirty) {
      // 保留一份同步前快照，出问题可以手工还原（不要写 .bak，那是 DeskBox 自己的恢复文件）
      if (plan.originalText !== null) {
        fs.writeFileSync(`${plan.file}.zju-sync-backup`, plan.originalText);
      }
      writeJsonAtomic(plan.file, plan.data);

      // 回读校验，写坏了立刻能发现
      const check = readJson(plan.file);
      if (!Array.isArray(check.items)) throw new Error(`${plan.file} 写入后校验失败`);
      log(`[写入] ${plan.file} → ${check.items.length} 条`);
    }

    for (const [i, plan] of plans.entries()) {
      state.widgets[widgets[i].id] = {
        items: plan.newTracked,
        syncedAt: new Date().toISOString(),
      };
    }
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(STATE_FILE, state);
  } finally {
    // 只要是我们关掉的，无论写入成功与否都必须拉起来，
    // 否则一次异常就会把 DeskBox 永久留在关闭状态
    if (stopped) {
      try {
        log(`[DeskBox] 已重新启动（${startDeskBox()}）`);
      } catch (err) {
        console.error(
          `[DeskBox] 自动重启失败：${err.message}\n` +
            `待办已经写入磁盘，手动打开 DeskBox 就能看到，数据没丢。`
        );
      }
    }
  }
}

try {
  main();
  flush();
} catch (err) {
  // 出错时即使 --quiet 也要把已经跑过的过程吐出来，否则无从排查
  flush(true);
  console.error(`同步失败：${err.message}`);
  process.exit(1);
}
