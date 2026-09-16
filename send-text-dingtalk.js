/**
 * 把文本文件的内容发到钉钉。
 *
 * 用法：node send-text-dingtalk.js <file>
 *
 * 发送失败时以非 0 退出，方便调用方（shell / systemd）感知失败。
 */

import fs from "fs";

import "dotenv/config";

import { dingTalkMarkdown } from "./shared/dingtalk-webhook.js";

const file = process.argv[2];

if (!file) {
  console.error("用法：node send-text-dingtalk.js <file>");
  process.exit(2);
}

if (!fs.existsSync(file)) {
  console.error(`文件不存在：${file}`);
  process.exit(2);
}

const content = fs.readFileSync(file, "utf8").trim();

if (!content) {
  console.log("文件为空，无需发送。");
  process.exit(0);
}

// 钉钉 markdown 上限 20000 字节，留出标题和包裹的余量
const MAX_LEN = 1800;

// 截断保留**开头**：待办列表的头部是 "You have N things to do" 和最早截止的条目，
// 恰恰是最该看的部分。旧实现用的 slice(-MAX_LEN) 把开头砍掉了，只剩尾巴。
const body =
  content.length > MAX_LEN
    ? `${content.slice(0, MAX_LEN)}\n\n...（已截断，共 ${content.length} 字符）`
    : content;

const message = `### ZJU-live-better 待办提醒\n\n${body}`;

try {
  const result = await dingTalkMarkdown(message, "ZJU-live-better 待办提醒");

  if (!result.sent) {
    console.log(`钉钉未启用（${result.reason}），内容如下：`);
    console.log(message);
    process.exit(0);
  }

  console.log("已发送。");
} catch (err) {
  console.error(`发送失败：${err.message}`);
  process.exit(1);
}
