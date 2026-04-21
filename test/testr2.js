const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
// 如果你本地测试，需要安装 dotenv: npm install dotenv
require('dotenv').config(); 

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

async function testConnection() {
  console.log("⏳ 正在尝试连接 Cloudflare R2...");
  const client = createClient();

  try {
    // 发送 ListBuckets 命令
    const response = await client.send(new ListBucketsCommand({}));
    
    console.log("✅ 连接成功！");
    console.log("你的存储桶列表:");
    if (response.Buckets && response.Buckets.length > 0) {
      response.Buckets.forEach(bucket => {
        console.log(` - ${bucket.Name} (创建时间: ${bucket.CreationDate})`);
      });
    } else {
      console.log(" (你的账户下目前没有存储桶)");
    }
  } catch (err) {
    console.error("❌ 连接失败，请检查以下原因:");
    if (err.name === 'InvalidAccessKeyId') {
      console.error("   - ACCESS_KEY_ID 填写错误");
    } else if (err.name === 'SignatureDoesNotMatch') {
      console.error("   - SECRET_ACCESS_KEY 填写错误");
    } else {
      console.error(`   - 报错信息: ${err.message}`);
    }
  }
}

testConnection();