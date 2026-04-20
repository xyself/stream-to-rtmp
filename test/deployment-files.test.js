const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(name) {
  return fs.readFileSync(path.join(rootDir, name), 'utf8');
}

test('example env file documents the Telegram bot configuration and SQLite database path', () => {
  const envExample = readProjectFile('.env.example');

  assert.match(envExample, /^TG_TOKEN=\*\*\*$/m);
  assert.match(envExample, /^TG_CHAT_ID=/m);
  assert.match(envExample, /^# .*ffmpeg/im);
  assert.match(envExample, /^# .*SQLite.*\/app\/data/im);
  assert.match(envExample, /^DATABASE_PATH=\.\/data\/data\.db$/m);
});

test('ecosystem config waits for ready signal and runs main.js', () => {
  const ecosystemConfig = readProjectFile('ecosystem.config.js');

  assert.match(ecosystemConfig, /script:\s*'main\.js'/);
  assert.match(ecosystemConfig, /wait_ready:\s*true/);
  assert.match(ecosystemConfig, /kill_timeout:\s*10000/);
});

test('Docker assets use main.js entrypoint and keep secrets out of build context', () => {
  const dockerfile = readProjectFile('Dockerfile');
  const dockerignore = readProjectFile('.dockerignore');

  assert.match(dockerfile, /ffmpeg/i);
  assert.match(dockerfile, /WORKDIR \/app/);
  assert.match(dockerfile, /npm ci --omit=dev|npm install --omit=dev/i);
  assert.match(dockerfile, /CMD \["node", "main\.js"\]/);

  assert.match(dockerignore, /^node_modules\/?$/m);
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^data\.db\*?$/m);
});

test('README documents local startup pm2 and Docker deployment flows plus SQLite persistence', () => {
  const readme = readProjectFile('README.md');

  assert.match(readme, /npm install/i);
  assert.match(readme, /node main\.js/i);
  assert.match(readme, /pm2 start ecosystem\.config\.js/i);
  assert.match(readme, /docker build/i);
  assert.match(readme, /docker compose up -d/i);
  assert.match(readme, /TG_TOKEN/i);
  assert.match(readme, /SQLite/i);
  assert.match(readme, /DATABASE_PATH=\.\/data\/data\.db/i);
  assert.match(readme, /\/app\/data/);
  assert.match(readme, /可直接启动部署|直接启动部署/);
});

test('docker compose provides direct deployment entry with persistent data mounts', () => {
  const compose = readProjectFile('docker-compose.yml');

  assert.match(compose, /build:\s*\./);
  assert.match(compose, /restart:\s*unless-stopped/);
  assert.match(compose, /env_file:/);
  assert.match(compose, /\.\/data:\/app\/data/);
  assert.match(compose, /\.\/logs:\/app\/logs/);
  assert.match(compose, /DATABASE_PATH:\s*\/app\/data\/data\.db/);
});
