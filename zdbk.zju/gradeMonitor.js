#!/usr/bin/env node

/* zdbk 成绩监控
 *
 * Portions of this file are based on zju-learning-assistant:
 * https://github.com/PeiPei233/zju-learning-assistant
 *
 * MIT License
 *
 * Copyright (c) 2023 PeiPei233
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Modified for ZJU-live-better.
 *
 * 使用方法：
 * 建议使用 tmux 后台常驻 monitor，服务器效果更好。也可以配置合盖保活或其他类似工具在本地运行。
 *   node zdbk.zju/gradeMonitor.js check      # 立即检查一次成绩
 *   node zdbk.zju/gradeMonitor.js monitor    # 在配置时段内持续监控
 *   node zdbk.zju/gradeMonitor.js test-ding  # 发送钉钉测试消息
 *
 * 必需配置（.env）：ZJU_USERNAME、ZJU_PASSWORD。
 * 钉钉通知复用 ENABLE_DINGTALK、DINGTALK_WEBHOOK、DINGTALK_SECRET。
 * 可选配置（以下均为默认值）：
 *   GRADE_STATE_PATH=state/grades.json
 *   GRADE_MONITOR_START_HOUR=8
 *   GRADE_MONITOR_END_HOUR=24
 *   GRADE_MONITOR_INTERVAL_SECONDS=3600
 *   GRADE_REQUEST_TIMEOUT_MS=20000
 *   GRADE_NOTIFY_INITIAL=false
 *   GRADE_CHECK_EVALUATION=true
 */

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { ZDBK, ZJUAM } from "login-zju";
import { dingTalkMarkdown } from "../shared/dingtalk-webhook.js";

const SCORE_URL = "https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html";
const EVALUATION_URL =
  "https://zdbk.zju.edu.cn/jwglxt/xtgl/index_cxMyCosJxpj.html";
const DEFAULT_STATE_PATH = "state/grades.json";
const WATCHED_FIELDS = ["cj", "bkcj", "jd", "xf"];
const SCORE_FIELDS = ["xkkh", "kcmc", ...WATCHED_FIELDS];
const NON_NUMERIC_GRADES = new Set(["合格", "不合格", "弃修"]);

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) {
    return false;
  }
  throw new Error(`无法识别布尔值：${value}`);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildConfig() {
  const config = {
    username: process.env.ZJU_USERNAME || "",
    password: process.env.ZJU_PASSWORD || "",
    statePath: process.env.GRADE_STATE_PATH || DEFAULT_STATE_PATH,
    startHour: Number(process.env.GRADE_MONITOR_START_HOUR || 8),
    endHour: Number(process.env.GRADE_MONITOR_END_HOUR || 24),
    intervalSeconds: Number(process.env.GRADE_MONITOR_INTERVAL_SECONDS || 3600),
    requestTimeoutMs: Number(process.env.GRADE_REQUEST_TIMEOUT_MS || 20000),
    notifyInitial: parseBoolean(process.env.GRADE_NOTIFY_INITIAL, false),
    checkEvaluation: parseBoolean(process.env.GRADE_CHECK_EVALUATION, true),
  };

  if (
    !Number.isInteger(config.startHour) ||
    config.startHour < 0 ||
    config.startHour > 23
  ) {
    throw new Error("start_hour 必须是 0 到 23 的整数");
  }
  if (
    !Number.isInteger(config.endHour) ||
    config.endHour < 1 ||
    config.endHour > 24
  ) {
    throw new Error("end_hour 必须是 1 到 24 的整数");
  }
  if (config.startHour >= config.endHour) {
    throw new Error("start_hour 必须小于 end_hour");
  }
  if (!Number.isFinite(config.intervalSeconds) || config.intervalSeconds <= 0) {
    throw new Error("interval_seconds 必须大于 0");
  }
  if (
    !Number.isFinite(config.requestTimeoutMs) ||
    config.requestTimeoutMs <= 0
  ) {
    throw new Error("request_timeout_ms 必须大于 0");
  }
  return config;
}

function ensureCredentials(config) {
  if (!config.username || !config.password) {
    throw new Error("请在 .env 中配置 ZJU_USERNAME 和 ZJU_PASSWORD");
  }
}

function scoreKey(item) {
  return String(item.xkkh || item.kch_id || item.kcmc || "");
}

function simplifyScore(item) {
  return Object.fromEntries(
    SCORE_FIELDS.map((field) => [field, String(item[field] ?? "")]),
  );
}

function changedScores(oldScores, newScores) {
  const changes = [];
  for (const item of newScores) {
    const key = scoreKey(item);
    if (!key) continue;
    const current = simplifyScore(item);
    const previous = oldScores[key];
    if (!previous) {
      if (current.cj || current.bkcj || current.jd) {
        changes.push({ key, previous: null, current });
      }
    } else if (
      WATCHED_FIELDS.some((field) => (previous[field] ?? "") !== current[field])
    ) {
      changes.push({ key, previous, current });
    }
  }
  return changes;
}

function numeric(value) {
  if (value === null || value === undefined || String(value).trim() === "")
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateMetrics(items) {
  let totalGradePoints = 0;
  let gpaCredits = 0;
  let totalPercentScore = 0;
  let percentCredits = 0;

  for (const item of items) {
    const credit = numeric(item.xf);
    if (credit === null) continue;

    const grade = String(item.cj ?? "");
    const point = numeric(item.jd);
    if (!NON_NUMERIC_GRADES.has(grade) && point !== null) {
      totalGradePoints += point * credit;
      gpaCredits += credit;
    }

    const score = numeric(item.cj);
    if (score !== null) {
      totalPercentScore += score * credit;
      percentCredits += credit;
    }
  }

  return {
    totalCredits: gpaCredits,
    gpa: gpaCredits ? totalGradePoints / gpaCredits : 0,
    percentAverage: percentCredits ? totalPercentScore / percentCredits : 0,
  };
}

function readState(filePath) {
  const state = readJsonIfExists(filePath);
  return { scores: state.scores || {}, lastSync: state.last_sync || null };
}

function writeState(filePath, scores) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const state = {
    last_sync: new Date().toLocaleString("sv-SE", { hour12: false }),
    scores: Object.fromEntries(
      scores
        .filter((item) => scoreKey(item))
        .map((item) => [scoreKey(item), simplifyScore(item)]),
    ),
  };
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temporaryPath, filePath);
}

function requestOptions(config, options = {}) {
  return { ...options, signal: AbortSignal.timeout(config.requestTimeoutMs) };
}

async function responseJson(response, context) {
  if (!response.ok) {
    throw new Error(`${context}失败：HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${context}失败：服务器未返回 JSON，登录可能已失效`);
  }
}

async function checkEvaluation(zdbk, config) {
  if (!config.checkEvaluation) return null;
  const url = new URL(EVALUATION_URL);
  url.search = new URLSearchParams({ gnmkdm: "N5083", su: config.username });
  const response = await zdbk.fetch(
    url,
    requestOptions(config, { method: "POST" }),
  );
  const data = await responseJson(response, "查询评教状态");
  return data.result === "1";
}

async function fetchScores(zdbk, config) {
  const form = new URLSearchParams({
    xn: "",
    xq: "",
    zscjl: "",
    zscjr: "",
    _search: "false",
    nd: String(Date.now()),
    "queryModel.showCount": "5000",
    "queryModel.currentPage": "1",
    "queryModel.sortName": "xkkh",
    "queryModel.sortOrder": "asc",
    time: "1",
  });

  let lastError;
  for (const gnmkdm of ["N508301", "N5083"]) {
    const url = new URL(SCORE_URL);
    url.search = new URLSearchParams({
      doType: "query",
      gnmkdm,
      su: config.username,
    });
    try {
      const response = await zdbk.fetch(
        url,
        requestOptions(config, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        }),
      );
      const data = await responseJson(response, "查询成绩");
      if (Array.isArray(data.items)) return data.items;
      lastError = new Error("查询成绩失败：响应中没有 items 数组");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("查询成绩失败");
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function notificationMarkdown(item, previous, oldMetrics, newMetrics) {
  return [
    "### 考试成绩通知",
    `- **选课课号**\t${item.xkkh}`,
    `- **课程名称**\t${item.kcmc}`,
    `- **成绩**\t${item.cj}`,
    `- **原成绩**\t${previous?.cj || "无"}`,
    `- **补考成绩**\t${item.bkcj}`,
    `- **学分**\t${item.xf}`,
    `- **总学分**\t${newMetrics.totalCredits.toFixed(1)}`,
    `- **绩点**\t${item.jd}`,
    `- **成绩变化**\t${newMetrics.gpa.toFixed(2)}(${signed(newMetrics.gpa - oldMetrics.gpa)}) / ${newMetrics.percentAverage.toFixed(2)}(${signed(newMetrics.percentAverage - oldMetrics.percentAverage)})`,
  ].join("\n");
}

async function notifyChange(change, oldMetrics, newMetrics) {
  const result = await dingTalkMarkdown(
    notificationMarkdown(
      change.current,
      change.previous,
      oldMetrics,
      newMetrics,
    ),
    "考试成绩通知",
  );
  if (!result.sent) {
    console.warn("[Grade Monitor] 钉钉未启用，已跳过通知");
  }
}

async function runCheck(config) {
  ensureCredentials(config);
  const zdbk = new ZDBK(new ZJUAM(config.username, config.password));
  const evaluationDone = await checkEvaluation(zdbk, config);
  if (evaluationDone === false) {
    console.warn("[Grade Monitor] 本学期尚未完成评价，可能无法查询最新成绩");
  }

  const state = readState(config.statePath);
  const scores = await fetchScores(zdbk, config);
  console.log(`[Grade Monitor] 获取到 ${scores.length} 条成绩记录`);

  const firstRun = Object.keys(state.scores).length === 0;
  if (firstRun && !config.notifyInitial) {
    writeState(config.statePath, scores);
    console.log(
      `[Grade Monitor] 首次运行，已保存基线到 ${config.statePath}，未发送历史成绩`,
    );
    return 0;
  }

  const changes = changedScores(state.scores, scores);
  const oldMetrics = calculateMetrics(Object.values(state.scores));
  const newMetrics = calculateMetrics(scores.map(simplifyScore));
  for (const change of changes) {
    console.log(
      `[Grade Monitor] 检测到成绩更新：${change.current.kcmc} ${change.current.cj}`,
    );
    await notifyChange(change, oldMetrics, newMetrics);
  }
  writeState(config.statePath, scores);
  console.log(`[Grade Monitor] 检查完成，共 ${changes.length} 项更新`);
  return changes.length;
}

function inWindow(date, config) {
  return (
    date.getHours() >= config.startHour && date.getHours() < config.endHour
  );
}

function nextRunTime(now, config) {
  if (inWindow(now, config)) {
    return new Date(now.getTime() + config.intervalSeconds * 1000);
  }
  const next = new Date(now);
  next.setHours(config.startHour, 0, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  return next;
}

async function sleepUntil(target) {
  const delay = Math.max(0, target.getTime() - Date.now());
  console.log(
    `[Grade Monitor] 下次检查：${target.toLocaleString("zh-CN", { hour12: false })}`,
  );
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function runMonitor(config) {
  ensureCredentials(config);
  console.log(
    `[Grade Monitor] 监控时段 ${String(config.startHour).padStart(2, "0")}:00-${String(config.endHour).padStart(2, "0")}:00，间隔 ${config.intervalSeconds} 秒`,
  );
  while (true) {
    const now = new Date();
    if (inWindow(now, config)) {
      try {
        await runCheck(config);
      } catch (error) {
        console.error("[Grade Monitor] 检查失败：", error);
      }
      await sleepUntil(nextRunTime(new Date(), config));
    } else {
      await sleepUntil(nextRunTime(now, config));
    }
  }
}

async function testDingTalk() {
  const result = await dingTalkMarkdown(
    "### 成绩监控测试\n- **状态**\t钉钉通知配置正常",
    "成绩监控测试",
  );
  if (!result.sent) {
    throw new Error("钉钉未启用，请检查 ENABLE_DINGTALK 和 DINGTALK_WEBHOOK");
  }
  console.log("[Grade Monitor] 钉钉测试消息发送成功");
}

function printHelp() {
  console.log(`用法：node zdbk.zju/gradeMonitor.js <command>

命令：
  check              立即检查一次成绩
  monitor            在配置时段内持续监控
  test-ding          发送钉钉测试消息
`);
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return command ? 0 : 1;
  }
  const config = buildConfig();
  if (command === "check") {
    await runCheck(config);
    return 0;
  }
  if (command === "monitor") {
    await runMonitor(config);
    return 0;
  }
  if (command === "test-ding") {
    await testDingTalk();
    return 0;
  }
  throw new Error(`未知命令：${command}`);
}

main()
  .then((exitCode) => {
    if (typeof exitCode === "number") process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`[Grade Monitor] ${error.message}`);
    process.exitCode = 1;
  });
