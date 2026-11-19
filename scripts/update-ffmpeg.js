#!/usr/bin/env node
'use strict';

const {
  downloadLatestFfmpeg,
  probeFfmpegBinary,
  resolveFfmpegBin,
} = require('../src/services/ffmpeg-installer');

async function main() {
  const currentBin = resolveFfmpegBin();
  const currentProbe = probeFfmpegBinary(currentBin);
  if (currentProbe.ok) {
    console.log(`ℹ️ 当前 FFmpeg: ${currentProbe.version} (${currentProbe.binPath})`);
  } else {
    console.log('ℹ️ 当前未检测到可用 FFmpeg，准备下载最新静态构建版...');
  }

  try {
    const res = await downloadLatestFfmpeg({ logger: console });
    console.log(`🎉 已成功更新至最新 FFmpeg: ${res.version}`);
    console.log(`📍 路径: ${res.binPath}（.env 中 FFMPEG_PATH 留空时将自动优先调用此内置最新版）`);
  } catch (err) {
    console.error(`❌ 自动下载最新 FFmpeg 失败: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
