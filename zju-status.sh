#!/usr/bin/env bash
# ZJU-live-better 统一状态检查
# 用法: zju-status [journal 回看窗口]     例: zju-status "7 days ago"

set -uo pipefail

PROJECT=/opt/ZJU-live-better
SINCE="${1:-24 hours ago}"

B=$'\033[1m'; R=$'\033[0m'
G=$'\033[32m'; Y=$'\033[33m'; E=$'\033[31m'; D=$'\033[2m'

hdr() { printf "\n%s%s%s\n" "$B" "$1" "$R"; }
hr()  { printf "%s%s%s\n" "$D" "────────────────────────────────────────────────────────" "$R"; }
state_of() { systemctl is-active "$1" 2>/dev/null || true; }

color_state() {
  case "$1" in
    active)     printf "%s● active%s"     "$G" "$R" ;;
    activating) printf "%s● activating%s" "$Y" "$R" ;;
    failed)     printf "%s● failed%s"     "$E" "$R" ;;
    inactive)   printf "%s● inactive%s"   "$E" "$R" ;;
    *)          printf "%s● %s%s"         "$Y" "${1:-unknown}" "$R" ;;
  esac
}

age() {
  local ts="$1" secs
  if [ -z "$ts" ] || [ "$ts" = "n/a" ]; then echo "-"; return; fi
  secs=$(( $(date +%s) - $(date -d "$ts" +%s 2>/dev/null || echo 0) ))
  if   [ "$secs" -lt 0 ]      ; then echo "-"
  elif [ "$secs" -lt 60 ]     ; then echo "${secs}s 前"
  elif [ "$secs" -lt 3600 ]   ; then echo "$((secs/60))m 前"
  elif [ "$secs" -lt 86400 ]  ; then echo "$((secs/3600))h 前"
  else echo "$((secs/86400))d 前"; fi
}

printf "%sZJU-live-better 状态%s   %s\n" "$B" "$R" "$(date "+%F %T %Z")"
hr

# ---------------- 服务 ----------------
hdr "服务"
for u in zju-autosign.service zju-reminders.timer zju-grades.service; do
  printf "  %-24s " "$u"
  color_state "$(state_of "$u")"
  printf "  (%s)" "$(systemctl is-enabled "$u" 2>/dev/null || echo -)"
  case "$u" in
    zju-autosign.service|zju-grades.service)
      printf "  重启 %s 次 | 运行 %s" \
        "$(systemctl show -p NRestarts --value "$u" 2>/dev/null)" \
        "$(age "$(systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)")"
      ;;
    zju-reminders.timer)
      printf "  下次 %s" "$(systemctl show -p NextElapseUSecRealtime --value "$u" 2>/dev/null)"
      ;;
  esac
  echo
done

# ---------------- autosign ----------------
hdr "autosign"
polls=$(journalctl -u zju-autosign.service --since "$SINCE" --no-pager -o cat 2>/dev/null | grep -c "No rollcalls found")
printf "  轮询无签到: %s 次\n" "${polls:-0}"
events=$(journalctl -u zju-autosign.service --since "$SINCE" --no-pager -o cat 2>/dev/null \
  | grep -E "radar rollcall|数字签到|限流|取不到签到码|went wrong" | tail -8)
if [ -n "$events" ]; then
  printf "  最近事件:\n"
  printf "%s\n" "$events" | sed "s/^/    /"
else
  printf "  %s窗口内无签到事件%s\n" "$D" "$R"
fi

# ---------------- 提醒 ----------------
hdr "提醒"
last=$(journalctl -u zju-reminders.service --no-pager -o cat 2>/dev/null \
  | grep -E "需要提醒|已发送|拉到|钉钉|失败" | tail -3)
if [ -n "$last" ]; then
  printf "%s\n" "$last" | sed "s/^/  /"
else
  printf "  %s暂无运行记录%s\n" "$D" "$R"
fi

# ---------------- 状态文件 ----------------
hdr "本地状态"

gf="$PROJECT/state/grades.json"
if [ -f "$gf" ]; then
  printf "  %-26s %s\n" "state/grades.json" "$(age "$(date -r "$gf" "+%F %T")")"
  node -e "
    const g=require(\"$gf\");
    console.log(\"    成绩记录 \"+Object.keys(g.scores||{}).length+\" 条，最后同步 \"+(g.last_sync||\"-\"));
  " 2>/dev/null
else
  printf "  %sservice/grades.json 不存在%s\n" "$E" "$R"
fi
sf="$PROJECT/.reminder-state.json"
if [ -f "$sf" ]; then
  printf "  %-26s %s\n" ".reminder-state.json" "$(age "$(date -r "$sf" "+%F %T")")"
  node -e "
    const s=require(\"$sf\");
    console.log(\"    待办基线 \"+Object.keys(s.todos||{}).length+\" 条，已发提醒记录 \"+Object.keys(s.ddlSent||{}).length+\" 条\");
  " 2>/dev/null
else
  printf "  %s.reminder-state.json 不存在%s\n" "$E" "$R"
fi

# ---------------- 钉钉 ----------------
hdr "钉钉推送"
if grep -qE "^ENABLE_DINGTALK=true" "$PROJECT/.env" 2>/dev/null; then
  printf "  %s已启用%s" "$G" "$R"
  if grep -qE "^DINGTALK_WEBHOOK=.*oapi\.dingtalk\.com" "$PROJECT/.env" 2>/dev/null; then
    printf "   webhook 已配置"
  else
    printf "   %swebhook 缺失或格式异常%s" "$E" "$R"
  fi
  grep -qE "^DINGTALK_SECRET=.+" "$PROJECT/.env" 2>/dev/null && printf "   签名已配置" || printf "   %s签名缺失%s" "$Y" "$R"
  echo
else
  printf "  %s未启用%s（.env 中 ENABLE_DINGTALK 非 true）\n" "$E" "$R"
fi

# ---------------- 日志占用 ----------------
hdr "journal 占用"
journalctl --disk-usage 2>/dev/null | sed "s/^/  /"
for u in zju-autosign zju-reminders zju-grades; do
  sz=$(journalctl -u "$u" --no-pager -o cat 2>/dev/null | wc -c)
  printf "  %-18s %s\n" "$u" "$(numfmt --to=iec "$sz" 2>/dev/null || echo "${sz}B")"
done
echo
