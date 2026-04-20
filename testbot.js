const { Bot, InlineKeyboard, Keyboard, session } = require("grammy");
const { conversations, createConversation } = require("@grammyjs/conversations");
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const bot = new Bot(process.env.TG_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

/** * 1. 自动化：添加房间对话流 (Conversation)
 */
async function addRoomConversation(conversation, ctx) {
    await ctx.reply("✨ **开始添加新直播间**\n请输入直播间 ID：");
    const idMsg = await conversation.wait();
    const rid = idMsg.message.text;

    const platKey = new InlineKeyboard().text("B站", "p:bili").text("斗鱼", "p:dy");
    await ctx.reply("选择平台：", { reply_markup: platKey });
    const { callbackQuery } = await conversation.waitForCallbackQuery(/^p:/);
    await ctx.answerCallbackQuery();

    await ctx.reply(`✅ 成功添加房间 \`${rid}\`！\n状态已进入：**静默监控** 模式。`, { parse_mode: "Markdown" });
}
bot.use(createConversation(addRoomConversation));

/**
 * 2. 底部常驻菜单 (你说的下方小方块)
 */
const mainKeyboard = new Keyboard()
    .text("🏠 房间管理").text("➕ 添加房间")
    .row()
    .text("📊 流量详情").text("🛠️ 运维工具")
    .resized(); // 关键：让按钮变小，不遮挡屏幕

/**
 * 3. 指令与菜单逻辑
 */
bot.command("start", async (ctx) => {
    await ctx.reply("🚀 **直播转播控制中心**\n点击下方按钮进行操作：", {
        reply_markup: mainKeyboard
    });
});

// 处理底部“添加房间”按钮
bot.hears("➕ 添加房间", async (ctx) => {
    await ctx.conversation.enter("addRoomConversation");
});

// 房间管理（多路推流与画质）
bot.hears("🏠 房间管理", async (ctx) => {
    const inlineKey = new InlineKeyboard()
        .text("🔗 管理推流地址", "manage_targets").row()
        .text("⚙️ 画质: 原画", "set_qn").text("🖼️ 截图预览", "get_shot").row()
        .text("🛑 停止监控", "stop_mon");

    await ctx.reply("📂 **当前监控房间: 123456**\n选择管理项：", { reply_markup: inlineKey });
});

// 运维工具（日志与负载）
bot.hears("🛠️ 运维工具", async (ctx) => {
    const text = `💻 **系统负载**: 45%\n📄 **最后日志**: \`FFmpeg Running...\``;
    await ctx.reply(text, { parse_mode: "Markdown" });
});

bot.start({ onStart: () => console.log("✅ 全功能机器人已启动。") });