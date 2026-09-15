#!/usr/bin/env bash
set -u

cd /opt/ZJU-live-better

LOG_FILE="/tmp/zju-todolist.log"

node courses.zju/todolist.js > "$LOG_FILE" 2>&1

cat "$LOG_FILE"

node send-text-dingtalk.js "$LOG_FILE"
