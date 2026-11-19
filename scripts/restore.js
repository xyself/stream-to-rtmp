require('dotenv').config();
const { restoreOnce } = require('../src/init/restore');

restoreOnce().catch((err) => {
  console.error('[restore] ❌ 预启动恢复异常:', err.message);
  process.exitCode = 1;
});
