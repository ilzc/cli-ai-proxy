#!/bin/bash
# Uni AI Proxy 管理脚本

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.proxy.pid"
LOG_FILE="$DIR/proxy.log"
export PATH="/opt/homebrew/bin:$PATH"

red()   { echo -e "\033[31m$1\033[0m"; }
green() { echo -e "\033[32m$1\033[0m"; }
yellow(){ echo -e "\033[33m$1\033[0m"; }

get_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

do_status() {
  local pid
  if pid=$(get_pid); then
    green "Running (PID: $pid)"
    curl -s http://127.0.0.1:9090/health 2>/dev/null | python3 -m json.tool 2>/dev/null || true
  else
    yellow "Stopped"
  fi
}

do_start() {
  if pid=$(get_pid); then
    yellow "Already running (PID: $pid)"
    return 0
  fi

  echo "Building..."
  cd "$DIR" && npx tsc 2>&1
  if [ $? -ne 0 ]; then
    red "Build failed"
    return 1
  fi

  echo "Starting..."
  nohup node "$DIR/dist/index.js" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo $pid > "$PID_FILE"
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    green "Started (PID: $pid)"
    green "Log: $LOG_FILE"
  else
    red "Failed to start, check $LOG_FILE"
    rm -f "$PID_FILE"
    tail -5 "$LOG_FILE"
    return 1
  fi
}

do_stop() {
  local pid
  if pid=$(get_pid); then
    echo "Stopping (PID: $pid)..."
    kill "$pid"
    # 等待进程退出，最多 5 秒
    for i in $(seq 1 50); do
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        green "Stopped"
        return 0
      fi
      sleep 0.1
    done
    # 强制杀
    kill -9 "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    yellow "Force killed"
  else
    yellow "Not running"
  fi
}

do_restart() {
  do_stop
  sleep 1
  do_start
}

do_logs() {
  local lines=${1:-50}
  if [ -f "$LOG_FILE" ]; then
    tail -n "$lines" "$LOG_FILE"
  else
    yellow "No log file"
  fi
}

do_follow() {
  if [ -f "$LOG_FILE" ]; then
    tail -f "$LOG_FILE"
  else
    yellow "No log file"
  fi
}

do_test() {
  if ! get_pid >/dev/null; then
    red "Server not running. Start it first: $0 start"
    return 1
  fi
  bash "$DIR/test/e2e.sh"
}

do_build() {
  echo "Building..."
  cd "$DIR" && npx tsc 2>&1
  if [ $? -eq 0 ]; then
    green "Build succeeded"
  else
    red "Build failed"
    return 1
  fi
}

usage() {
  echo "Usage: $0 <command>"
  echo ""
  echo "Commands:"
  echo "  start       Build and start the proxy server"
  echo "  stop        Stop the proxy server"
  echo "  restart     Restart the proxy server"
  echo "  status      Show server status and health"
  echo "  logs [N]    Show last N lines of log (default: 50)"
  echo "  follow      Tail -f the log file"
  echo "  build       Build only (no start)"
  echo "  test        Run e2e tests (server must be running)"
}

case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs "$2" ;;
  follow)  do_follow ;;
  build)   do_build ;;
  test)    do_test ;;
  *)       usage ;;
esac
