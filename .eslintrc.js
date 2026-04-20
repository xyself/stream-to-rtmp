module.exports = {
  "env": {
    "node": true,       // 启用 Node.js 全局变量
    "es2024": true      // 支持最新 ES 特性，适配 Node 25 运行时
  },
  "extends": "eslint:recommended", // 使用官方推荐的基础规则
  "parserOptions": {
    "ecmaVersion": "latest", // 自动解析 Node 25 支持的最前沿语法
    "sourceType": "script"   // 匹配你目前使用的 CommonJS (require) 模式
  },
  "globals": {
    "fetch": "readonly"      // 显式允许 Node.js 25 原生的 fetch API
  },
  "rules": {
    // 提醒未使用的变量，防止代码冗余
    "no-unused-vars": "warn",
    
    // 允许 console，转播工具需要实时输出推流状态和日志
    "no-console": "off",
    
    // 允许 while(true) 等常驻内存的轮询循环
    "no-constant-condition": ["error", { "checkLoops": false }],
    
    // 严格禁止未定义变量，这是防止脚本在无人值守时崩溃的第一道防线
    "no-undef": "error",
    
    // 建议使用 const，增加代码的逻辑稳定性
    "prefer-const": "warn"
  }
};