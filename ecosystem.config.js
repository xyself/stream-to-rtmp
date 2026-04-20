module.exports = {
  apps: [{
    name: 'live-relay-bot',         // 进程名称
    script: 'main.js',              // 入口文件
    instances: 1,                   // 实例数量
    autorestart: true,              // 自动重启
    watch: false,                   // 生产环境不建议开启监听
    max_memory_restart: '500M',     // 超过 500M 内存自动重启（防止 FFmpeg 内存泄漏）
    
    // 环境变量配置
    env: {
      NODE_ENV: 'production',
      // 如果没有使用 .env 文件，可以直接在这里写配置
      // TG_TOKEN: '你的Token'
    },

    // 日志配置
    error_file: './logs/err.log',   // 错误日志路径
    out_file: './logs/out.log',     // 标准输出日志路径
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,               // 集群模式下合并日志

    // 优雅退出配置
    kill_timeout: 10000,            // 给程序 10 秒时间执行 main.js 中的 gracefulShutdown
    wait_ready: true,               // 等待程序发送 ready 信号
    listen_timeout: 15000,
  }]
};