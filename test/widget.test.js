const test = require('node:test');
const assert = require('node:assert/strict');
const widget = require('../src/bot/widget');
const { createChatGuard } = require('../src/bot');

test('WIDGET_HTML complies with Bot API 10.4 size, encoding, and TelegramWidget API rules', () => {
  const rawBytes = Buffer.byteLength(widget.WIDGET_HTML, 'utf8');
  const compressedBytes = widget.getCompressedSize();

  assert.ok(rawBytes > 0 && rawBytes <= widget.MAX_HTML_BYTES, `rawBytes=${rawBytes}`);
  assert.ok(compressedBytes <= widget.MAX_COMPRESSED_BYTES, `compressedBytes=${compressedBytes}`);
  assert.equal(widget.WIDGET_HTML.includes('\u0000'), false);
  assert.equal(widget.WIDGET_HTML.includes('onChatData'), false);
  assert.equal(widget.WIDGET_HTML.includes("onEvent('chatDataChanged'"), true);
  assert.equal(widget.WIDGET_HTML.includes('W.chatData'), true);
});

test('buildChatData stays valid JSON within 1024 UTF-8 bytes even with many rooms', () => {
  const manyTasks = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    platform: ['bilibili', 'douyu', 'douyin'][i % 3],
    room_id: `1000000000000${i}`,
    status: 'ENABLED',
    traffic: { running: i % 2 === 0, bitrateKbps: 4500 },
  }));

  const payload = widget.buildChatData({
    tasks: manyTasks,
    system: { memPct: 45, cpuPercent: 12, uptime: '3天 5小时', serviceMem: '89.2 MB' },
  });

  assert.ok(Buffer.byteLength(payload, 'utf8') <= widget.MAX_DATA_BYTES);
  const parsed = JSON.parse(payload);
  assert.ok(Array.isArray(parsed.t));
  assert.equal(typeof parsed.r.m, 'number');
});

test('sendWidget, editWidgetData, and answerWidgetQuery use official Bot API 10.4 parameters', async () => {
  const calls = [];
  const fakeBot = {
    api: {
      raw: {
        sendWidget: async (p) => { calls.push(['sendWidget', p]); return { message_id: 77 }; },
        editMessageWidgetData: async (p) => {
          calls.push(['editMessageWidgetData', p]);
          if (p.chat_data === 'same') throw new Error('Bad Request: message is not modified');
          return true;
        },
        answerWidgetQuery: async (p) => { calls.push(['answerWidgetQuery', p]); return true; },
      },
    },
  };

  const sent = await widget.sendWidget(fakeBot, 12345, '{"r":{},"t":[]}', { caption: '监控面板' });
  assert.equal(sent.message_id, 77);
  assert.equal(calls[0][0], 'sendWidget');
  assert.equal(calls[0][1].allow_queries, true);
  assert.equal(calls[0][1].caption, '监控面板');

  const notModifiedResult = await widget.editWidgetData(fakeBot, 12345, 77, 'same');
  assert.equal(notModifiedResult, true);

  await widget.answerWidgetQuery(fakeBot, 'q-1', '🔄 已刷新');
  assert.equal(calls[2][0], 'answerWidgetQuery');
  assert.equal(calls[2][1].data, '🔄 已刷新');
  assert.equal('text' in calls[2][1], false);
});

test('createChatGuard authorizes widget_query via query.chat.id or query.from.id even when ctx.chat is undefined', async () => {
  const guard = createChatGuard(new Set(['999']));
  let allowedPassed = false;
  await guard(
    {
      chat: undefined,
      update: { widget_query: { id: 'q-ok', chat: { id: 999 }, from: { id: 999 } } },
      api: { raw: { answerWidgetQuery: async () => {} } },
    },
    async () => { allowedPassed = true; }
  );
  assert.equal(allowedPassed, true);

  let blockedPassed = false;
  let answeredDenied = false;
  await guard(
    {
      chat: undefined,
      update: { widget_query: { id: 'q-bad', chat: { id: 111 }, from: { id: 111 } } },
      api: {
        raw: {
          answerWidgetQuery: async (p) => {
            if (p.widget_query_id === 'q-bad') answeredDenied = true;
          },
        },
      },
    },
    async () => { blockedPassed = true; }
  );
  assert.equal(blockedPassed, false);
  assert.equal(answeredDenied, true);
});
