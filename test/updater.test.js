const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const updater = require('../src/services/updater');
const views = require('../src/bot/views');
const bot = require('../src/bot');

test('updater.getCurrentVersion returns valid Git short SHA', () => {
  const ver = updater.getCurrentVersion();
  assert.equal(ver.ok, true);
  assert.ok(typeof ver.sha === 'string' && ver.sha.length >= 7);
  assert.ok(typeof ver.msg === 'string' && ver.msg.length > 0);
});

test('updater.consumeUpdateState reads and deletes state file cleanly', () => {
  const testState = {
    updatedAt: Date.now(),
    fromSha: 'aaaaaaa',
    toSha: 'bbbbbbb',
    notifyChatId: 12345678,
    success: true,
  };

  fs.mkdirSync(path.dirname(updater.STATE_FILE), { recursive: true });
  fs.writeFileSync(updater.STATE_FILE, JSON.stringify(testState), 'utf8');

  assert.equal(fs.existsSync(updater.STATE_FILE), true);
  const consumed = updater.consumeUpdateState();
  assert.ok(consumed);
  assert.equal(consumed.fromSha, 'aaaaaaa');
  assert.equal(consumed.toSha, 'bbbbbbb');
  assert.equal(consumed.notifyChatId, 12345678);

  // 验证已被消费删除
  assert.equal(fs.existsSync(updater.STATE_FILE), false);
  assert.equal(updater.consumeUpdateState(), null);
});

test('views.renderDashboard displays gitSha in environment line', () => {
  const rendered = views.renderDashboard({
    system: {
      uptime: '1h',
      runtimeLabel: 'Serv00 FreeBSD',
      nodeVersion: 'v26.12.1',
      gitSha: 'c83c92c',
      cpuPercent: 0.5,
      memUsed: '168 MB',
      memTotal: '512 MB',
    },
    stats: {},
    recentErrors: [],
  });

  assert.ok(rendered.includes('Serv00 FreeBSD · Node v26.12.1'));
  assert.ok(rendered.includes('c83c92c'));
});

test('bot.buildDashboardKeyboard includes global_check_update button', () => {
  const kb = bot.buildDashboardKeyboard();
  const rows = kb.inline_keyboard || [];
  const allButtons = rows.flat();
  const updateBtn = allButtons.find((b) => b.callback_data === 'global_check_update');
  assert.ok(updateBtn, 'Dashboard keyboard should have global_check_update button');
  assert.ok(updateBtn.text.includes('检查更新'));
});
