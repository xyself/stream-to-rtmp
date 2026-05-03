module.exports = {
  apps: [{
    name: 'stream-to-rtmp',
    script: './scripts/start-with-restore.js',
    instances: 1,
    exec_mode: 'fork',
    interpreter: 'node',
    interpreter_args: '--max-old-space-size=2048',
    env: {
      NODE_ENV: 'production',
      PORT: 8080,
      // Telegram 配置
      TG_TOKEN: process.env.TG_TOKEN,
      TG_CHAT_ID: process.env.TG_CHAT_ID,
      // Gist 备份配置
      GIST_ID: process.env.GIST_ID,
      GIST_TOKEN: process.env.GIST_TOKEN,
      // FFmpeg 路径（GitHub Actions 会安装到系统路径）
      FFMPEG_PATH: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg'
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 8080
    },
    // 日志配置
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    // 自动重启配置
    watch: false,
    max_memory_restart: '1G',
    // 进程管理
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    // 优雅退出
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    // 其他配置
    merge_logs: true,
    autorestart: true,
    // GitHub Actions 特定配置
    cron_restart: null,
    exp_backoff_restart_delay: 100
  }]
};
