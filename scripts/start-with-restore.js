require('dotenv').config();

const { spawn } = require('child_process');
const path = require('path');

const restoreScript = path.join(__dirname, 'restore.js');
const mainScript = path.join(__dirname, '..', 'main.js');

console.log('🔄 Running restore script...');
const restore = spawn('node', [restoreScript], {
  stdio: 'inherit',
  env: process.env
});

restore.on('close', (code) => {
  if (code !== 0) {
    console.error(`❌ Restore script failed with code ${code}`);
    process.exit(1);
  }
  
  console.log('✅ Restore completed, starting main application...');
  const main = spawn('node', [mainScript], {
    stdio: 'inherit',
    env: process.env
  });
  
  main.on('close', (code) => {
    console.log(`Main application exited with code ${code}`);
    process.exit(code || 0);
  });
});

restore.on('error', (err) => {
  console.error('❌ Failed to start restore script:', err);
  process.exit(1);
});
