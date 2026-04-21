require('dotenv').config();
const r2sync = require('../src/db/r2-sync');

if (!r2sync.isConfigured()) {
  console.log('[R2] 未配置 R2，跳过恢复');
  process.exit(0);
}

r2sync.downloadDefault()
  .then(() => {
    console.log('[R2] 预启动恢复完成');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[R2] 预启动恢复失败:', err);
    process.exit(1);
  });
