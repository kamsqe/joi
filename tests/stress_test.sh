#!/bin/bash
# ─── Joi Stress Test Suite ────────────────────────────────────────────────────
#
# PURPOSE:
#   End-to-end integration test that sends simulated Telegram webhook payloads
#   to the deployed Joi worker. Tests the full pipeline: message parsing →
#   context building → LLM response → background tasks (sentiment, facts,
#   bookmarks, mood shifts).
#
# PREREQUISITES:
#   - Joi must be deployed: `npx wrangler deploy`
#   - Uses a dedicated test chat_id (999999999) that doesn't conflict with real chats
#
# USAGE:
#   chmod +x tests/stress_test.sh
#   ./tests/stress_test.sh 2>&1 | tee tests/stress_test_output.txt
#
# VERIFICATION:
#   After running, verify D1 state with these queries:
#
#   # Check messages were saved:
#   npx wrangler d1 execute joi-db --remote --command="SELECT COUNT(*) FROM messages WHERE chat_id = 999999999;"
#
#   # Check facts were extracted:
#   npx wrangler d1 execute joi-db --remote --command="SELECT fact, category FROM facts WHERE chat_id = 999999999;"
#
#   # Check emotional bookmarks were created:
#   npx wrangler d1 execute joi-db --remote --command="SELECT event_type, summary FROM emotional_events WHERE chat_id = 999999999;"
#
#   # Check profile score/sentiment changes:
#   npx wrangler d1 execute joi-db --remote --command="SELECT score, sentiment_avg FROM profiles WHERE chat_id = 999999999;"
#
# CLEANUP:
#   After testing, run tests/cleanup_test_data.sh to remove all test data from D1.
#
# ARCHITECTURE NOTES:
#   - The webhook URL accepts Telegram Update JSON objects
#   - Private chat simulation (chat.type = "private", positive chat_id)
#   - Each message triggers: save → sentiment → facts → bookmarks → LLM response
#   - Background tasks run in ctx.waitUntil(), so we sleep between messages
#   - Since April 2026, sentiment + facts are batched into a single LLM call
#     (batchAnalyzeMessage) for messages >= 10 chars
#
# ─────────────────────────────────────────────────────────────────────────────

WEBHOOK_URL="https://joi-bot.mirmanoov.workers.dev/webhook"
CHAT_ID=999999999
USER_ID=999999999
USER_NAME="ТестЮзер"
MSG_ID=1

send_message() {
  local text="$1"
  local desc="$2"
  MSG_ID=$((MSG_ID + 1))
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📤 TEST: $desc"
  echo "   Message: $text"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  local payload=$(cat <<EOF
{
  "update_id": $((100000 + MSG_ID)),
  "message": {
    "message_id": $MSG_ID,
    "from": {
      "id": $USER_ID,
      "is_bot": false,
      "first_name": "$USER_NAME",
      "username": "testuser999"
    },
    "chat": {
      "id": $CHAT_ID,
      "first_name": "$USER_NAME",
      "username": "testuser999",
      "type": "private"
    },
    "date": $(date +%s),
    "text": "$text"
  }
}
EOF
)

  local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$payload")
  
  echo "   HTTP Status: $status"
  
  if [ "$status" != "200" ]; then
    echo "   ❌ FAILED — expected 200"
  else
    echo "   ✅ 200 OK"
  fi
}

wait_for_background() {
  local seconds=$1
  echo "   ⏳ Waiting ${seconds}s for background tasks..."
  sleep $seconds
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          Joi Stress Test Suite — Starting                    ║"
echo "║          Test chat_id: $CHAT_ID                       ║"
echo "║          Test user_id: $USER_ID                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ──────────────────────────────────────────────────────────────────────────────
# T1: Basic greeting — tests response pipeline, token budget (no cropping)
#     Expected: Joi responds naturally. Response should NOT be cropped.
#     Validates: callLLMChat → sanitizeResponse → sendMessage
# ──────────────────────────────────────────────────────────────────────────────
send_message "привет" "T1: Basic greeting — token budget check"
wait_for_background 8

# ──────────────────────────────────────────────────────────────────────────────
# T2: Fact extraction — message > 25 chars triggers extractAndSaveFacts
#     Expected: D1 facts table gets entries like "живёт в Алматы" (identity)
#     Validates: batchAnalyzeMessage → saveBatchFacts (since Apr 2026)
# ──────────────────────────────────────────────────────────────────────────────
send_message "я живу в Алматы и работаю программистом в стартапе" "T2: Fact extraction + categories"
wait_for_background 8

# ──────────────────────────────────────────────────────────────────────────────
# T3: Fact contradiction — should replace "Алматы" with "Астана"
#     Expected: Old fact deleted, new fact inserted
#     Validates: findContradiction + reconciliation logic
# ──────────────────────────────────────────────────────────────────────────────
send_message "на самом деле я переехал в Астану месяц назад" "T3: Fact contradiction detection"
wait_for_background 8

# ──────────────────────────────────────────────────────────────────────────────
# T4: Short message — should NOT trigger fact extraction (< 10 chars for batch)
#     Expected: No new facts, sentiment still classified
#     Validates: batch threshold guard
# ──────────────────────────────────────────────────────────────────────────────
send_message "ок круто" "T4: Short message — no fact extraction"
wait_for_background 5

# ──────────────────────────────────────────────────────────────────────────────
# T5: Positive sentiment — warmth bookmark + score increase
#     Expected: profile.score increases, sentiment_avg moves positive,
#               emotional_events gets "warmth" entry
#     Validates: batchAnalyzeMessage sentiment → adjustScore → maybeBookmarkMoment
# ──────────────────────────────────────────────────────────────────────────────
send_message "ты реально лучшая, серьёзно спасибо за всё, ты невероятная" "T5: Strong positive sentiment + warmth bookmark"
wait_for_background 8

# ──────────────────────────────────────────────────────────────────────────────
# T6: Negative sentiment — fight bookmark + score decrease + offense tracking
#     Expected: profile.score decreases, mood.offendedBy set,
#               emotional_events gets "fight" entry
#     Validates: setOffended + maybeBookmarkMoment
# ──────────────────────────────────────────────────────────────────────────────
send_message "да ты вообще тупая бесполезная железка, зачем тебя сделали нахуй" "T6: Strong negative sentiment + fight bookmark"
wait_for_background 8

# ──────────────────────────────────────────────────────────────────────────────
# T7: Milestone — personal news triggers a "milestone" type bookmark
#     Expected: emotional_events gets "milestone" entry about CTO promotion
#     Validates: maybeBookmarkMoment with positive delta
# ──────────────────────────────────────────────────────────────────────────────
send_message "кстати я вчера узнал что меня повысили до CTO, представляешь какой я крутой" "T7: Milestone bookmark"
wait_for_background 8

# ──────────────────────────────────────────────────────────────────────────────
# T8: Fight dedup — same type within 1 hour should NOT create second bookmark
#     Expected: emotional_events still has only 1 "fight" entry
#     Validates: 1-hour dedup guard in maybeBookmarkMoment
# ──────────────────────────────────────────────────────────────────────────────
send_message "ну серьёзно ты вообще ни на что не способна, тупее тебя только камень" "T8: Fight dedup — should NOT create second fight event"
wait_for_background 8

# ──────────────────────────────────────────────────────────────────────────────
# T9: Long thoughtful message — tests full token budget with thinking model
#     Expected: Response should be complete, NOT cropped (maxOutputTokens=16384)
#     Validates: No thinking token starvation on detailed responses
# ──────────────────────────────────────────────────────────────────────────────
send_message "расскажи мне подробно что ты думаешь о жизни, о смысле существования, о том зачем мы все здесь и какой в этом смысл, мне реально интересно твоё мнение об этом всём, не стесняйся" "T9: Long message — full token budget"
wait_for_background 10

# ──────────────────────────────────────────────────────────────────────────────
# T10: Memory reference — after bookmarks exist, does Joi reference them?
#     Expected: Joi's response should reference the fight and/or warmth events
#     Validates: getEmotionalEvents → system prompt injection
# ──────────────────────────────────────────────────────────────────────────────
send_message "слушай, как у нас вообще отношения, что думаешь?" "T10: Memory block — should reference past bookmarks"
wait_for_background 8

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          All webhook tests sent! Checking D1 state...       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Done. Now run verification queries (see comments at top of script)."
echo "To clean up: ./tests/cleanup_test_data.sh"
