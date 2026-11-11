/**
 * Telegram Bot API 10.4 Widget 支持
 * - sendWidget / editMessageWidgetData / answerWidgetQuery
 * - HTML ≤ 32KB 原始 / ≤ 4KB zlib-9 压缩
 * - chat_data ≤ 1024 bytes（bot → widget 实时数据）
 * - TelegramWidget.request(data) ≤ 64 bytes（widget → bot 操作）
 * - answerWidgetQuery 回应 ≤ 1024 bytes
 */

'use strict';

const zlib = require('zlib');

// ─── Widget HTML ────────────────────────────────────────────────────────────
// 极简暗色面板：资源仪表 + 任务卡片列表 + 操作按钮
// 通过 TelegramWidget.onChatData 接收 JSON，通过 TelegramWidget.request 发送操作
const WIDGET_HTML = `<!DOCTYPE html><html><head><meta charset=utf-8><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:12px/1.4 -apple-system,sans-serif;background:#0d1117;color:#c9d1d9;padding:6px}
h4{font-size:10px;color:#8b949e;margin:0 0 3px;text-transform:uppercase;letter-spacing:.5px}
.card{background:#161b22;border-radius:6px;padding:5px 7px;margin-bottom:3px;border-left:3px solid #30363d}
.card.L{border-left-color:#3fb950}.card.D{border-left-color:#30363d}.card.P{border-left-color:#8b949e}
.row{display:flex;justify-content:space-between;align-items:center;margin-top:2px}
.nm{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
.kbps{font-size:11px;color:#3fb950}.kbps.z{color:#8b949e}
.bdg{font-size:9px;padding:1px 4px;border-radius:3px;background:#21262d;color:#8b949e}
.bdg.L{background:#1f3028;color:#3fb950}.bdg.D{background:#21262d;color:#8b949e}.bdg.P{color:#6e7681}
.btn{font-size:10px;padding:2px 7px;border-radius:4px;border:none;cursor:pointer;background:#21262d;color:#c9d1d9;margin-left:3px}
.btn:active{opacity:.7}.btn.g{background:#1f3028;color:#3fb950}.btn.r{background:#3d1f20;color:#f85149}
.sep{height:1px;background:#21262d;margin:4px 0}
.res{display:flex;gap:5px;margin-bottom:4px}
.ri{flex:1;background:#161b22;border-radius:4px;padding:4px 6px}
.rl{font-size:9px;color:#8b949e}.rv{font-size:11px;font-weight:600}
.bar{height:3px;border-radius:2px;background:#21262d;margin-top:2px}
.bf{height:100%;border-radius:2px;background:#3fb950;transition:width .5s}
.bf.w{background:#e3b341}.bf.r{background:#f85149}
.ts{font-size:9px;color:#8b949e;text-align:right;margin-top:3px}
.empty{padding:12px;text-align:center;color:#8b949e;font-size:11px}
</style></head><body>
<div class=res id=res></div>
<div class=sep></div>
<h4 id=th>任务</h4>
<div id=tasks></div>
<div class=ts id=ts>等待数据...</div>
<script>
const W=window.TelegramWidget;
let st={};
function pct(v){return Math.min(100,Math.max(0,+(v)||0))}
function bc(p){return p>85?' r':p>60?' w':''}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function render(){
  const r=st.r||{};
  const mp=pct(r.m),cp=pct(r.c);
  document.getElementById('res').innerHTML=
    '<div class=ri><div class=rl>内存</div><div class=rv>'+(r.m!=null?r.m+'%':'?')+'</div>'+
    '<div class=bar><div class="bf'+bc(mp)+'" style="width:'+mp+'%"></div></div></div>'+
    '<div class=ri><div class=rl>CPU</div><div class=rv>'+(r.c!=null?r.c+'%':'?')+'</div>'+
    '<div class=bar><div class="bf'+bc(cp)+'" style="width:'+cp+'%"></div></div></div>'+
    '<div class=ri><div class=rl>运行</div><div class=rv style="font-size:10px">'+(r.up||'?')+'</div></div>';
  const tasks=st.t||[];
  document.getElementById('th').textContent='任务 ('+tasks.length+')';
  if(!tasks.length){
    document.getElementById('tasks').innerHTML='<div class=empty>暂无配置房间</div>';
  }else{
    document.getElementById('tasks').innerHTML=tasks.map(function(t){
      const live=t.on&&t.k>0;
      const cls=!t.en?'P':live?'L':'D';
      const badge=!t.en?'已暂停':live?'推流中':'待机';
      const kbpsStr=live?t.k+'kbps':'等待开播';
      const btnCls=t.en?'btn r':'btn g';
      const btnTxt=t.en?'■ 停止':'▶ 开启';
      return '<div class="card '+cls+'">'+
        '<div class=row><span class=nm>'+esc(t.p)+' #'+esc(t.r)+'</span>'+
        '<span class="bdg '+cls+'">'+badge+'</span></div>'+
        '<div class=row>'+
        '<span class="kbps'+(live?'':' z')+'">'+kbpsStr+'</span>'+
        '<span>'+
        '<button class="btn" onclick="act('+t.id+',\'snap\')" title="截图">📷</button>'+
        '<button class="'+btnCls+'" onclick="act('+t.id+',\'tog\')">'+btnTxt+'</button>'+
        '</span></div></div>';
    }).join('');
  }
  const now=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('ts').textContent='刷新于 '+now+(r.ram?' · RAM '+r.ram:'');
}
function act(id,a){
  try{W.request(JSON.stringify({i:id,a:a}));}catch(e){}
}
W.onChatData(function(d){
  try{st=d?JSON.parse(d):{};}catch(e){st={};}
  render();
});
render();
</script></body></html>`;

// 预验证压缩大小
let _compressedSize = null;
function getCompressedSize() {
  if (_compressedSize === null) {
    _compressedSize = zlib.deflateSync(Buffer.from(WIDGET_HTML), { level: 9 }).length;
  }
  return _compressedSize;
}

// ─── chat_data 构建（≤ 1024 bytes） ─────────────────────────────────────────
/**
 * 把运行时状态压缩成 ≤ 1024 bytes 的 JSON 字符串
 * 字段名全部缩写：t=tasks, r=resources, r.m=memPct, r.c=cpuPct, r.up=uptime, r.ram=ramStr
 * 任务字段：id, p=platform, r=room_id, en=enabled, on=running, k=kbps
 */
function buildChatData({ tasks = [], system = {} } = {}) {
  const r = {
    m: system.memPct != null ? Math.round(system.memPct) : null,
    c: system.cpuPercent != null ? Math.round(system.cpuPercent) : null,
    up: system.uptime || null,
    ram: system.serviceMem || null,
  };

  const t = tasks.map((entry) => ({
    id: entry.id,
    p: platformAbbr(entry.platform),
    r: String(entry.room_id),
    en: entry.status === 'ENABLED' ? 1 : 0,
    on: entry.traffic?.running ? 1 : 0,
    k: Math.round(entry.traffic?.bitrateKbps || 0),
  }));

  let payload = JSON.stringify({ r, t });

  // 若超 1024 bytes，逐步截断任务列表（最多 10 个）
  if (payload.length > 1024) {
    const shortened = t.map((x) => ({ id: x.id, p: x.p, r: x.r.slice(0, 8), en: x.en, on: x.on, k: x.k }));
    payload = JSON.stringify({ r: { m: r.m, c: r.c }, t: shortened });
  }
  if (payload.length > 1024) {
    payload = JSON.stringify({ r: { m: r.m }, t: t.slice(0, 8) });
  }

  return payload.slice(0, 1024);
}

function platformAbbr(p) {
  return { bilibili: 'B站', douyu: '斗鱼', douyin: '抖音' }[p] || (p || '?').slice(0, 4);
}

// ─── sendWidget ──────────────────────────────────────────────────────────────
/**
 * 发送 Widget 消息
 * grammy 1.42 可能还未收录 10.4 类型，使用 bot.api.raw.sendWidget()
 * 返回 sent message（含 message_id），供后续 editMessageWidgetData 使用
 */
async function sendWidget(bot, chatId, chatData) {
  return bot.api.raw.sendWidget({
    chat_id: chatId,
    html: WIDGET_HTML,
    chat_data: chatData,
  });
}

/**
 * 更新已发送 Widget 的 chat_data（≤ 1024 bytes）
 */
async function editWidgetData(bot, chatId, messageId, chatData) {
  return bot.api.raw.editMessageWidgetData({
    chat_id: chatId,
    message_id: messageId,
    chat_data: chatData,
  });
}

/**
 * 回应 widget_query（15 秒内必须调用）
 * text: 展示给用户的提示（可空），≤ 1024 bytes
 */
async function answerWidgetQuery(bot, widgetQueryId, text = '') {
  return bot.api.raw.answerWidgetQuery({
    widget_query_id: widgetQueryId,
    text: String(text).slice(0, 200),
  });
}

module.exports = {
  WIDGET_HTML,
  getCompressedSize,
  buildChatData,
  platformAbbr,
  sendWidget,
  editWidgetData,
  answerWidgetQuery,
};
