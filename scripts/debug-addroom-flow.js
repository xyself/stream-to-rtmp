const path = require('node:path');

process.env.TG_TOKEN = process.env.TG_TOKEN || '123456:TEST_TOKEN';
process.env.DATABASE_PATH = path.resolve(__dirname, '../data/debug-conversation.db');

const botModule = require('../src/bot');

function createConversationScript(events) {
  let index = 0;
  return {
    async wait() {
      const next = events[index++];
      console.log('[debug] conversation.wait ->', JSON.stringify(next));
      return next;
    },
    async waitForCallbackQuery(pattern) {
      const next = events[index++];
      console.log('[debug] conversation.waitForCallbackQuery ->', JSON.stringify(next));
      if (!next?.callbackQuery?.data || !pattern.test(next.callbackQuery.data)) {
        throw new Error(`callback mismatch: ${JSON.stringify(next)}`);
      }
      return {
        callbackQuery: next.callbackQuery,
        answerCallbackQuery: async () => {
          console.log('[debug] answerCallbackQuery');
        },
      };
    },
    async external(fn) {
      return fn();
    },
  };
}

async function main() {
  const replies = [];
  const ctx = {
    reply: async (text, extra) => {
      replies.push({ text, extra });
      console.log('[debug] ctx.reply ->', text, extra ? JSON.stringify(extra) : '');
    },
  };

  const conversation = createConversationScript([
    { message: { text: '1728485804' } },
    { callbackQuery: { data: 'p:bilibili' } },
    { message: { text: 'rtmp://live.restream.io/live/re_11554500_event70a7a270eab84bf9b499a58adfa05a88' } },
  ]);

  try {
    await botModule.addRoomConversation(conversation, ctx);
    console.log('\n[debug] done');
  } catch (err) {
    console.error('\n[debug] failed:', err?.stack || err);
  }

  console.log('\n[debug] replies:', JSON.stringify(replies, null, 2));
}

main();
