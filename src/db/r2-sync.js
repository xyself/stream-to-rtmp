const fs = require('node:fs');
const path = require('node:path');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

function isConfigured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function createClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function getKey() {
  return process.env.R2_KEY || 'data.db';
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function download(localPath) {
  if (!isConfigured()) {
    console.log('[R2] 未配置，跳过下载');
    return false;
  }

  const client = createClient();
  try {
    const res = await client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: getKey(),
    }));

    const buf = await streamToBuffer(res.Body);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buf);
    console.log(`[R2] ✅ 数据库已从 R2 恢复 (${(buf.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log('[R2] 首次部署，R2 暂无数据库文件，将创建新数据库');
      return false;
    }
    console.error('[R2] ❌ 下载失败:', err.message);
    return false;
  }
}

async function upload(localPath) {
  if (!isConfigured()) return false;

  if (!fs.existsSync(localPath)) {
    console.warn('[R2] 数据库文件不存在，跳过上传');
    return false;
  }

  const client = createClient();
  try {
    const buf = fs.readFileSync(localPath);
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: getKey(),
      Body: buf,
      ContentType: 'application/octet-stream',
    }));
    console.log(`[R2] ✅ 数据库已备份到 R2 (${(buf.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    console.error('[R2] ❌ 上传失败:', err.message);
    return false;
  }
}

function getDefaultLocalPath() {
  const configured = process.env.DATABASE_PATH;
  return configured ? path.resolve(configured) : path.join(__dirname, '../../data/data.db');
}

async function downloadDefault() {
  return download(getDefaultLocalPath());
}

async function uploadDefault() {
  return upload(getDefaultLocalPath());
}

module.exports = { download, upload, downloadDefault, uploadDefault, isConfigured };
