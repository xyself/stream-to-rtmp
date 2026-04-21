require('dotenv').config();
const r2sync = require('../src/db/r2-sync');

r2sync.downloadDefault()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[R2] 预启动恢复失败（非致命）:', err.message);
    process.exit(0);
  });
