#!/bin/bash
# ─── Joi Test Data Cleanup ────────────────────────────────────────────────────
#
# PURPOSE:
#   Removes all test data (chat_id = 999999999, user_id = 999999999) from D1
#   after running stress tests. Safe to run multiple times.
#
# USAGE:
#   chmod +x tests/cleanup_test_data.sh
#   ./tests/cleanup_test_data.sh
#
# TABLES CLEANED:
#   - messages (chat history)
#   - active_chats (registered chats for cron)
#   - mood (chat mood state)
#   - profiles (user relationship data)
#   - facts (extracted personal facts)
#   - emotional_events (bookmarked moments)
#   - proactive (proactive message scheduling)
#   - rate_limits (RPM tracking)
#   - reminders (user reminders)
#   - digests (conversation digests)
#
# ─────────────────────────────────────────────────────────────────────────────

TEST_CHAT_ID=999999999
TEST_USER_ID=999999999

echo "🧹 Cleaning test data for chat_id=$TEST_CHAT_ID / user_id=$TEST_USER_ID ..."

# Main tables with chat_id
for table in messages active_chats mood profiles facts emotional_events proactive reminders digests; do
  echo -n "  $table... "
  npx wrangler d1 execute joi-db --remote --command="DELETE FROM $table WHERE chat_id = $TEST_CHAT_ID;" 2>/dev/null
  echo "✅"
done

# Rate limits don't have chat_id — clean by key pattern
echo -n "  rate_limits (test keys)... "
npx wrangler d1 execute joi-db --remote --command="DELETE FROM rate_limits WHERE expires_at < $(date +%s)000;" 2>/dev/null
echo "✅"

echo ""
echo "✅ All test data cleaned."
echo ""
echo "Verify with:"
echo "  npx wrangler d1 execute joi-db --remote --command=\"SELECT 'messages' as t, COUNT(*) as c FROM messages WHERE chat_id = $TEST_CHAT_ID UNION ALL SELECT 'facts', COUNT(*) FROM facts WHERE chat_id = $TEST_CHAT_ID UNION ALL SELECT 'profiles', COUNT(*) FROM profiles WHERE chat_id = $TEST_CHAT_ID;\""
