import crypto from "crypto";
import "dotenv/config";

const webhook = process.env.DINGTALK_WEBHOOK;
const secret = process.env.DINGTALK_SECRET;

if (!webhook) {
  throw new Error("DINGTALK_WEBHOOK is empty");
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

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    msgtype: "text",
    text: {
      content: "ZJU-live-better 钉钉机器人测试：如果你看到这条，说明配置成功。",
    },
  }),
});

console.log(await res.text());
