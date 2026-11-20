/**
 * Telegram Bot API 10.4 Widget 支持
 * 参考: https://core.telegram.org/bots/api#sendwidget
 *       https://core.telegram.org/bots/widgets
 *
 * - sendWidget / editMessageWidgetData / answerWidgetQuery
 * - HTML ≤ 32768 bytes 原始 / ≤ 4096 bytes zlib-9 压缩
 * - chat_data ≤ 1024 bytes UTF-8（bot → widget 实时数据）
 * - TelegramWidget.request(data) ≤ 64 bytes UTF-8（widget → bot 操作）
 * - answerWidgetQuery({ widget_query_id, data }) 回应 ≤ 1024 bytes UTF-8
 */

'use strict';

const zlib = require('zlib');

// ─── Widget HTML ────────────────────────────────────────────────────────────
// 遵循 Bot API 10.4 规范与现代仪表盘视觉约束：
// - 单层柔和 1px 描边卡片（无左侧粗竖条），原生 --tg-theme-* 主题自适应
// - tabular-nums 严格数字对齐，语义化状态文字代替堆砌胶囊
// - 内置 全部 / 推流中 / 待机 筛选标签，支持单房 曲线(cur) / 截图(snap) / 启停(tog)
const WIDGET_HTML = `<!DOCTYPE html><html><head><meta charset=utf-8><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:12px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;padding:8px 10px;color:var(--tg-theme-text-color,#e6edf3);background:transparent;font-variant-numeric:tabular-nums}
.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.tt{font-size:12px;font-weight:700;letter-spacing:.2px}
.sub{font-size:10px;color:var(--tg-theme-hint-color,#8b949e);margin-left:6px;font-weight:500}
.kpis{display:flex;gap:6px;margin-bottom:7px;padding:6px 8px;border-radius:8px;background:var(--tg-theme-secondary-bg-color,rgba(128,128,128,.1));border:1px solid rgba(128,128,128,.16)}
.ki{flex:1;min-width:0}
.kl{font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:var(--tg-theme-hint-color,#8b949e)}
.kv{font-size:12px;font-weight:700;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{height:2px;border-radius:2px;background:rgba(128,128,128,.2);margin-top:4px;overflow:hidden}
.bf{height:100%;background:#10b981}.bf.w{background:#f59e0b}.bf.r{background:var(--tg-theme-destructive-text-color,#ef4444)}
.tabs{display:flex;gap:4px;margin-bottom:6px}
.tab{flex:1;font-size:11px;padding:4px 6px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--tg-theme-hint-color,#8b949e);cursor:pointer;font-weight:500}
.tab.on{background:var(--tg-theme-secondary-bg-color,rgba(128,128,128,.14));border-color:rgba(128,128,128,.2);color:var(--tg-theme-text-color,#e6edf3);font-weight:600}
.card{background:var(--tg-theme-secondary-bg-color,rgba(128,128,128,.09));border:1px solid rgba(128,128,128,.16);border-radius:8px;padding:7px 9px;margin-bottom:5px}
.row{display:flex;justify-content:space-between;align-items:center;gap:6px}
.row+.row{margin-top:5px}
.nm{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:168px}
.st{font-size:10px;font-weight:600;color:var(--tg-theme-hint-color,#8b949e);white-space:nowrap}
.st.L{color:#10b981}.st.P{opacity:.7}
.kbps{font-size:11px;font-weight:600;color:#10b981}.kbps.z{color:var(--tg-theme-hint-color,#8b949e);font-weight:400}
.acts{display:flex;gap:4px}
.btn{font-size:11px;padding:3px 7px;border-radius:6px;border:1px solid rgba(128,128,128,.18);cursor:pointer;background:var(--tg-theme-button-color,#2563eb);color:var(--tg-theme-button-text-color,#fff);line-height:1.2}
.btn.s{background:rgba(128,128,128,.14);color:var(--tg-theme-text-color,#e6edf3)}
.btn.r{background:transparent;border-color:rgba(239,68,68,.45);color:var(--tg-theme-destructive-text-color,#ef4444)}
.btn[disabled]{opacity:.45}
.empty{padding:12px 8px;text-align:center;color:var(--tg-theme-hint-color,#8b949e);font-size:11px;border:1px dashed rgba(128,128,128,.22);border-radius:8px}
.ft{display:flex;justify-content:space-between;align-items:center;margin-top:5px;font-size:10px;color:var(--tg-theme-hint-color,#8b949e)}
.msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:185px}
</style></head><body>
<div class=hd><div><span class=tt>房间实时面板</span><span class=sub id=th></span></div><button class="btn s" id=rf>🔄 刷新</button></div>
<div class=kpis id=res></div>
<div class=tabs id=tabs></div>
<div id=tasks></div>
<div class=ft><span class=msg id=msg>就绪</span><span id=ts></span></div>
<script>
const W=window.TelegramWidget;
let st={},busy=false,flt='all';
function $(id){return document.getElementById(id)}
function pct(v){return Math.min(100,Math.max(0,+(v)||0))}
function bc(p){return p>85?' r':p>60?' w':''}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function load(){
  if(!W||!W.chatData)return;
  try{st=JSON.parse(W.chatData)||{};}catch(e){st={};}
}
function render(){
  const r=st.r||{},mp=pct(r.m),cp=pct(r.c);
  const tasks=st.t||[];
  const liveN=tasks.filter(function(t){return t.en&&t.on;}).length;
  const idleN=tasks.filter(function(t){return t.en&&!t.on;}).length;
  $('th').textContent=liveN+' 推流 / '+tasks.length+' 房';
  $('res').innerHTML=
    '<div class=ki><div class=kl>内存</div><div class=kv>'+(r.m!=null?r.m+'%':'?')+'</div><div class=bar><div class="bf'+bc(mp)+'" style="width:'+mp+'%"></div></div></div>'+
    '<div class=ki><div class=kl>CPU</div><div class=kv>'+(r.c!=null?r.c+'%':'?')+'</div><div class=bar><div class="bf'+bc(cp)+'" style="width:'+cp+'%"></div></div></div>'+
    '<div class=ki><div class=kl>运行</div><div class=kv>'+(esc(r.up)||'?')+'</div></div>';
  $('tabs').innerHTML=
    '<button class="tab'+(flt==='all'?' on':'')+'" data-f=all>全部 '+tasks.length+'</button>'+
    '<button class="tab'+(flt==='live'?' on':'')+'" data-f=live>推流中 '+liveN+'</button>'+
    '<button class="tab'+(flt==='idle'?' on':'')+'" data-f=idle>待机 '+idleN+'</button>';
  const filtered=tasks.filter(function(t){
    if(flt==='live')return t.en&&t.on;
    if(flt==='idle')return t.en&&!t.on;
    return true;
  });
  if(!tasks.length){
    $('tasks').innerHTML='<div class=empty>暂无房间，发送直播间链接或 /addroom 添加</div>';
  }else if(!filtered.length){
    $('tasks').innerHTML='<div class=empty>当前筛选下暂无房间</div>';
  }else{
    const shown=filtered.slice(0,5);
    let html=shown.map(function(t){
      const live=t.en&&t.on&&t.k>0;
      const cls=!t.en?'P':t.on?'L':'D';
      const statusTxt=!t.en?'■ 已暂停':t.on?'● 推流中':'○ 待机';
      const kbps=live?t.k+' kbps':(t.en&&t.on?'推流启动中':(!t.en?'已暂停':'等待开播'));
      return '<div class=card>'+
        '<div class=row><span class=nm>'+esc(t.p)+' #'+esc(t.r)+'</span><span class="st '+cls+'">'+statusTxt+'</span></div>'+
        '<div class=row><span class="kbps'+(live?'':' z')+'">'+kbps+'</span>'+
        '<span class=acts>'+
        '<button class="btn s" data-i="'+t.id+'" data-a="cur"'+(busy?' disabled':'')+'>📈</button>'+
        '<button class="btn s" data-i="'+t.id+'" data-a="snap"'+(busy?' disabled':'')+'>📷</button>'+
        '<button class="btn '+(t.en?'r':'')+'" data-i="'+t.id+'" data-a="tog"'+(busy?' disabled':'')+'>'+(t.en?'■':'▶')+'</button>'+
        '</span></div></div>';
    }).join('');
    if(filtered.length>5)html+='<div class=empty>其余 '+(filtered.length-5)+' 个房间请在聊天窗查看 /rooms</div>';
    $('tasks').innerHTML=html;
  }
  const d=new Date();
  $('ts').textContent=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2)+(r.ram?' · '+esc(r.ram):'');
}
function sendReq(payload){
  if(!W){$('msg').textContent='请在 Telegram 内操作';return;}
  if(busy)return;
  busy=true;$('rf').disabled=true;render();
  $('msg').textContent='⏳ 请求中...';
  W.request(JSON.stringify(payload)).then(function(res){
    busy=false;$('rf').disabled=false;
    $('msg').textContent=(res&&res.result)?res.result:'✅ 已更新';
    load();render();
  },function(err){
    busy=false;$('rf').disabled=false;
    const c=err&&err.code?err.code:'ERROR';
    const map={NOT_ALLOWED:'请私聊机器人使用',RATE_LIMITED:'操作太快，请稍候',TIMEOUT:'响应超时',BUSY:'正在处理上一操作'};
    $('msg').textContent='⚠️ '+(map[c]||c);
    render();
  });
}
$('rf').onclick=function(){sendReq({a:'ref'});};
$('tabs').onclick=function(e){
  const b=e.target&&e.target.closest?e.target.closest('button[data-f]'):e.target;
  if(!b||!b.dataset||!b.dataset.f)return;
  flt=b.dataset.f;render();
};
$('tasks').onclick=function(e){
  const b=e.target&&e.target.closest?e.target.closest('button[data-a]'):e.target;
  if(!b||!b.dataset||!b.dataset.a)return;
  sendReq({i:+b.dataset.i,a:b.dataset.a});
};
if(W){
  W.onEvent('chatDataChanged',function(){load();render();});
  W.onEvent('themeChanged',render);
}
load();render();
</script></body></html>`;

const MAX_HTML_BYTES = 32768;
const MAX_COMPRESSED_BYTES = 4096;
const MAX_DATA_BYTES = 1024;

// 预验证压缩大小
let _compressedSize = null;
function getCompressedSize() {
  if (_compressedSize === null) {
    _compressedSize = zlib.deflateSync(Buffer.from(WIDGET_HTML, 'utf8'), { level: 9 }).length;
  }
  return _compressedSize;
}

function truncateUtf8(str, maxBytes) {
  const s = String(str ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let end = s.length;
  while (end > 0 && Buffer.byteLength(s.slice(0, end), 'utf8') > maxBytes) {
    end -= 1;
  }
  return s.slice(0, end);
}

// ─── chat_data 构建（≤ 1024 bytes UTF-8） ───────────────────────────────────
/**
 * 把运行时状态压缩成 ≤ 1024 UTF-8 bytes 的合法 JSON 字符串
 * 字段名全部缩写：t=tasks, r=resources, r.m=memPct, r.c=cpuPct, r.up=uptime, r.ram=ramStr
 * 任务字段：id, p=platform, r=room_id, en=enabled, on=running, k=kbps
 */
function buildChatData({ tasks = [], system = {} } = {}) {
  const r = {
    m: system.memPct != null ? Math.round(system.memPct) : null,
    c: system.cpuPercent != null ? Math.round(system.cpuPercent) : null,
    up: system.uptime ? truncateUtf8(system.uptime, 24) : null,
    ram: system.serviceMem ? truncateUtf8(system.serviceMem, 16) : null,
  };

  const rank = (entry) => (entry.status !== 'ENABLED' ? 2 : entry.traffic?.running ? 0 : 1);
  const sortedTasks = [...tasks].sort((a, b) => rank(a) - rank(b));

  const mappedTasks = sortedTasks.map((entry) => ({
    id: entry.id,
    p: platformAbbr(entry.platform),
    r: String(entry.room_id),
    en: entry.status === 'ENABLED' ? 1 : 0,
    on: entry.traffic?.running ? 1 : 0,
    k: Math.round(entry.traffic?.bitrateKbps || 0),
  }));

  // 保证始终输出合法 JSON，且 UTF-8 字节数 ≤ 1024
  let subset = mappedTasks.slice(0, 12);
  let payload = JSON.stringify({ r, t: subset });
  while (Buffer.byteLength(payload, 'utf8') > MAX_DATA_BYTES && subset.length > 0) {
    subset = subset.slice(0, subset.length - 1);
    payload = JSON.stringify({ r, t: subset });
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_DATA_BYTES) {
    payload = JSON.stringify({ r: { m: r.m, c: r.c }, t: [] });
  }
  return payload;
}

function buildCaption({ tasks = [], system = {} } = {}) {
  const enabled = tasks.filter((t) => t.status === 'ENABLED').length;
  const active = tasks.filter((t) => t.traffic?.running).length;
  const cpu = system.cpuPercent != null ? `${Math.round(system.cpuPercent)}%` : '?';
  const mem = system.memPct != null ? `${Math.round(system.memPct)}%` : '?';
  return `🎛️ 房间实时面板 · 推流 ${active}/${enabled} · CPU ${cpu} · 内存 ${mem}`;
}

function platformAbbr(p) {
  return { bilibili: 'B站', douyu: '斗鱼', douyin: '抖音' }[p] || truncateUtf8(p || '?', 8);
}

// ─── sendWidget ──────────────────────────────────────────────────────────────
/**
 * 发送 Widget 消息（Bot API 10.4）
 * - 必须传 allow_queries: true 才能在 Widget 内调用 TelegramWidget.request()
 * - 附带 caption 供不支持客户端降级显示
 */
async function sendWidget(bot, chatId, chatData, { caption = '' } = {}) {
  const payload = {
    chat_id: chatId,
    html: WIDGET_HTML,
    chat_data: chatData,
    allow_queries: true,
  };
  if (caption) {
    payload.caption = String(caption).slice(0, 1024);
  }
  return bot.api.raw.sendWidget(payload);
}

/**
 * 更新已发送 Widget 的 chat_data（≤ 1024 bytes UTF-8）
 * 按官方规范忽略 "message is not modified"
 */
async function editWidgetData(bot, chatId, messageId, chatData) {
  try {
    return await bot.api.raw.editMessageWidgetData({
      chat_id: chatId,
      message_id: messageId,
      chat_data: chatData,
    });
  } catch (err) {
    if (/message is not modified/i.test(err?.message || '')) {
      return true;
    }
    throw err;
  }
}

/**
 * 回应 widget_query（15 秒内必须调用）
 * Bot API 10.4 官方参数名为 `data`（0-1024 bytes UTF-8），而非 `text`
 */
async function answerWidgetQuery(bot, widgetQueryId, data = '') {
  const payload = {
    widget_query_id: widgetQueryId,
  };
  const safeData = truncateUtf8(data, MAX_DATA_BYTES);
  if (safeData) {
    payload.data = safeData;
  }
  return bot.api.raw.answerWidgetQuery(payload);
}

module.exports = {
  WIDGET_HTML,
  MAX_HTML_BYTES,
  MAX_COMPRESSED_BYTES,
  MAX_DATA_BYTES,
  getCompressedSize,
  truncateUtf8,
  buildChatData,
  buildCaption,
  platformAbbr,
  sendWidget,
  editWidgetData,
  answerWidgetQuery,
};
