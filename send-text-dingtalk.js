import crypto from "crypto";
import fs from "fs";
import "dotenv/config";

const webhook = process.env.DINGTALK_WEBHOOK;
const secret = process.env.DINGTALK_SECRET;
const file = process.argv[2];

if (!webhook) {
  throw new Error("DINGTALK_WEBHOOK is empty");
}

const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const content = raw.trim();

if (!content) {
  console.log("No content to send.");
  process.exit(0);
}

let url = webhook;

if (secret) {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;

  const sign = crypto
    .createHmac("sha256", secret)
    .update(stringToSign)
    .digest("base64");

  url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

const maxLen = 1800;
const message = [
  "【ZJU-live-better 待办提醒】",
  "",
  content.slice(-maxLen),
].join("\n");

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    msgtype: "text",
    text: {
      content: message,
    },
  }),
});

console.log(await res.text());
