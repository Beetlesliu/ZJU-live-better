#!/usr/bin/env bash
set -u

cd /opt/ZJU-live-better

while true; do
  echo "========== $(date '+%F %T') new todo check ==========" | tee -a /var/log/zju-new-todo.log

  TZ=Asia/Shanghai \
  HTTP_PROXY=http://127.0.0.1:1081 \
  HTTPS_PROXY=http://127.0.0.1:1081 \
  ALL_PROXY=socks5h://127.0.0.1:1080 \
  node new-todo-reminder.js 2>&1 | tee -a /var/log/zju-new-todo.log

  echo "========== sleep 600s ==========" | tee -a /var/log/zju-new-todo.log
  sleep 600
done
