/**
 * 已废弃：功能已并入 reminders.js。
 *
 * 合并的理由：这两个脚本原本各自 spawn 一次 courses.zju/todolist.js、
 * 各自做一次完整 CAS 登录、各自拉一遍 /api/todos，约 120 行逐字重复。
 * reminders.js 用一次登录同时产出「新待办」和「多级截止」两类提醒。
 *
 * 改用：
 *   node reminders.js              跑一轮
 *   node reminders.js --loop       常驻轮询
 *   systemctl start zju-reminders.service    （推荐，等同跑一轮）
 */

import { main } from "./reminders.js";

console.warn("[deprecated] new-todo-reminder.js 已并入 reminders.js，正在转发…");
await main();
