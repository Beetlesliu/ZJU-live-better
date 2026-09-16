/**
 * 钉钉机器人连通性测试。
 *
 * 用法：node test-dingtalk.js
 *
 * 注意：zdbk.zju/gradeMonitor.js 也带了一个 `test-ding` 子命令，
 * 两者都走 shared/dingtalk-webhook.js，效果等价。
 */

import "dotenv/config";

import { dingTalkMarkdown } from "./shared/dingtalk-webhook.js";

const message = [
  "### ZJU-live-better 钉钉机器人测试",
  "",
  "如果你看到这条消息，说明 DINGTALK_WEBHOOK / DINGTALK_SECRET 配置正确。",
  "",
  `- 发送时间：${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date())}`,
].join("\n");

try {
  const result = await dingTalkMarkdown(message, "ZJU-live-better 测试");

  if (!result.sent) {
    console.error(`钉钉未启用（${result.reason}）。请检查 .env 里的：`);
    console.error("  ENABLE_DINGTALK=true");
    console.error("  DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=...");
    process.exit(1);
  }

  console.log("发送成功，请查看钉钉群。");
} catch (err) {
  console.error(`发送失败：${err.message}`);
  process.exit(1);
}
