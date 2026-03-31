#!/bin/bash
# CLI AI Proxy 端到端测试
# 使用前确保服务已启动: node dist/index.js

BASE="http://127.0.0.1:9090"
PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  local expected="$3"

  if echo "$result" | grep -q "$expected"; then
    echo "✅ PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "❌ FAIL: $name"
    echo "   Expected to contain: $expected"
    echo "   Got: $(echo "$result" | head -5)"
    FAIL=$((FAIL + 1))
  fi
}

echo "═══════════════════════════════════════"
echo "  CLI AI Proxy - E2E Tests"
echo "═══════════════════════════════════════"
echo ""

# ─── 1. Health check ───
echo "--- Health Check ---"
RESULT=$(curl -s "$BASE/health")
check "Health endpoint returns ok" "$RESULT" '"status":"ok"'
check "Gemini CLI available" "$RESULT" '"gemini":{"available":true'
check "Claude CLI available" "$RESULT" '"claude":{"available":true'

# ─── 2. Models list ───
echo ""
echo "--- Models List ---"
RESULT=$(curl -s "$BASE/v1/models")
check "Models endpoint returns list" "$RESULT" '"object":"list"'
check "Gemini model listed" "$RESULT" '"id":"gemini"'
check "Claude model listed" "$RESULT" '"id":"claude"'

# ─── 3. Error handling ───
echo ""
echo "--- Error Handling ---"

# Invalid JSON
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d 'not json')
check "Invalid JSON returns error" "$RESULT" '"Invalid JSON'

# Missing messages
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini"}')
check "Missing messages returns error" "$RESULT" '"messages is required'

# Empty messages
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","messages":[]}')
check "Empty messages returns error" "$RESULT" '"messages is required'

# Unknown model
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"nonexistent","messages":[{"role":"user","content":"hi"}]}')
check "Unknown model returns error" "$RESULT" '"Unknown model'

# Invalid role
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"invalid","content":"hi"}]}')
check "Invalid role returns error" "$RESULT" '"Invalid message role'

# 404
RESULT=$(curl -s "$BASE/v1/nonexistent")
check "404 for unknown path" "$RESULT" '"Not found'

# ─── 4. Gemini non-streaming ───
echo ""
echo "--- Gemini Non-Streaming ---"
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
check "Gemini returns chat.completion" "$RESULT" '"object":"chat.completion"'
check "Gemini returns choices" "$RESULT" '"choices"'
check "Gemini returns assistant role" "$RESULT" '"role":"assistant"'
check "Gemini returns finish_reason" "$RESULT" '"finish_reason"'
check "Gemini returns model" "$RESULT" '"model"'

# ─── 5. Claude non-streaming ───
echo ""
echo "--- Claude Non-Streaming ---"
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
check "Claude returns chat.completion" "$RESULT" '"object":"chat.completion"'
check "Claude returns choices" "$RESULT" '"choices"'
check "Claude returns session_id header" "$(curl -si -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[{"role":"user","content":"Say OK"}]}')" "X-Session-Id"

# ─── 6. Gemini streaming ───
echo ""
echo "--- Gemini Streaming ---"
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"stream":true}')
check "Gemini stream contains SSE data" "$RESULT" 'data: '
check "Gemini stream contains chunk object" "$RESULT" 'chat.completion.chunk'
check "Gemini stream ends with DONE" "$RESULT" '[DONE]'

# ─── 7. Claude streaming ───
echo ""
echo "--- Claude Streaming ---"
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"stream":true}')
check "Claude stream contains SSE data" "$RESULT" 'data: '
check "Claude stream contains chunk object" "$RESULT" 'chat.completion.chunk'
check "Claude stream ends with DONE" "$RESULT" '[DONE]'

# ─── 8. System prompt ───
echo ""
echo "--- System Prompt ---"
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[{"role":"system","content":"You must reply with exactly the word BANANA and nothing else"},{"role":"user","content":"What should you say?"}]}')
check "System prompt respected" "$RESULT" 'BANANA'

# ─── 9. Default model ───
echo ""
echo "--- Default Model ---"
RESULT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
check "Default model (no model field) works" "$RESULT" '"object":"chat.completion"'

# ─── 10. CORS ───
echo ""
echo "--- CORS ---"
HEADERS=$(curl -sI -X OPTIONS "$BASE/v1/chat/completions")
check "CORS preflight returns 204" "$HEADERS" "204"
check "CORS allows origin" "$HEADERS" "Access-Control-Allow-Origin"
check "CORS exposes session header" "$HEADERS" "X-Session-Id"

# ─── Summary ───
echo ""
echo "═══════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"

exit $FAIL
