const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { encodeRgbaToPng } = require('../core/curve-chart');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 生成一张极简深灰底色 PNG（320x180，推流时 FFmpeg 会缩放到 1280x720，文件极小且零依赖）
 */
function buildDefaultFallbackPngBuffer() {
  const width = 320;
  const height = 180;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // 柔和深灰渐变底色 (#111827 -> #1f2937)
      const ratio = y / height;
      rgba[idx] = Math.round(17 + ratio * 14);
      rgba[idx + 1] = Math.round(24 + ratio * 17);
      rgba[idx + 2] = Math.round(39 + ratio * 16);
      rgba[idx + 3] = 255;
    }
  }
  return encodeRgbaToPng(width, height, rgba);
}

function getCustomImagePath() {
  return config.fallback.imagePath;
}

function getDefaultImagePath() {
  return config.fallback.defaultImagePath;
}

function hasCustomFallbackImage() {
  const customPath = getCustomImagePath();
  try {
    return fs.existsSync(customPath) && fs.statSync(customPath).size > 0;
  } catch {
    return false;
  }
}

function ensureFallbackImage() {
  if (hasCustomFallbackImage()) {
    return getCustomImagePath();
  }
  const defaultPath = getDefaultImagePath();
  if (!fs.existsSync(defaultPath) || fs.statSync(defaultPath).size === 0) {
    ensureDir(defaultPath);
    fs.writeFileSync(defaultPath, buildDefaultFallbackPngBuffer());
  }
  return defaultPath;
}

function saveCustomFallbackImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('图片数据为空');
  }
  const customPath = getCustomImagePath();
  ensureDir(customPath);
  fs.writeFileSync(customPath, buffer);
  return customPath;
}

function clearCustomFallbackImage() {
  const customPath = getCustomImagePath();
  if (fs.existsSync(customPath)) {
    fs.unlinkSync(customPath);
    return true;
  }
  return false;
}

function getFallbackImageInfo() {
  const isCustom = hasCustomFallbackImage();
  const activePath = isCustom ? getCustomImagePath() : getDefaultImagePath();
  let sizeBytes = 0;
  try {
    if (fs.existsSync(activePath)) {
      sizeBytes = fs.statSync(activePath).size;
    }
  } catch {}
  return {
    isCustom,
    path: activePath,
    sizeBytes,
  };
}

module.exports = {
  buildDefaultFallbackPngBuffer,
  ensureFallbackImage,
  saveCustomFallbackImage,
  clearCustomFallbackImage,
  hasCustomFallbackImage,
  getFallbackImageInfo,
};
