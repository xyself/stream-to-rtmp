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
// 遵循 Bot API 10.4 规范：
// - 使用原生 --tg-theme-* CSS 变量适配明暗主题
// - 通过 TelegramWidget.chatData 读取状态，监听 chatDataChanged / themeChanged
// - 通过 TelegramWidget.request() 发操作并展示请求状态与返回值
// - 控制紧凑布局使总高度在 50~560px 内，避免被气泡裁剪
const WIDGET_HTML = `<!DOCTYPE html><html><head><meta charset=utf-8><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:12px/1.35 -apple-system,sans-serif;padding:8px 10px;color:var(--tg-theme-text-color,#e6edf3);background:transparent}
.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.tt{font-size:11px;font-weight:700;color:var(--tg-theme-hint-color,#8b949e);letter-spacing:.4px}
.res{display:flex;gap:5px;margin-bottom:6px}
.ri{flex:1;background:var(--tg-theme-secondary-bg-color,rgba(128,128,128,.12));border-radius:6px;padding:5px 7px}
.rl{font-size:10px;color:var(--tg-theme-hint-color,#8b949e)}
.rv{font-size:12px;font-weight:700;margin-top:1px}
.bar{height:3px;border-radius:2px;background:rgba(128,128,128,.22);margin-top:3px;overflow:hidden}
.bf{height:100%;border-radius:2px;background:#2ea043}
.bf.w{background:#d29922}.bf.r{background:var(--tg-theme-destructive-text-color,#f85149)}
.card{background:var(--tg-theme-secondary-bg-color,rgba(128,128,128,.12));border-radius:6px;padding:6px 8px;margin-bottom:4px;border-left:3px solid var(--tg-theme-hint-color,#8b949e)}
.card.L{border-left-color:#2ea043}
.row{display:flex;justify-content:space-between;align-items:center;gap:6px}
.row+.row{margin-top:4px}
.nm{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:165px}
.bdg{font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(128,128,128,.16);color:var(--tg-theme-hint-color,#8b949e)}
.bdg.L{background:rgba(46,160,67,.18);color:#2ea043}
.kbps{font-size:11px;color:#2ea043;font-weight:600}.kbps.z{color:var(--tg-theme-hint-color,#8b949e);font-weight:400}
.acts{display:flex;gap:4px}
.btn{font-size:11px;padding:3px 7px;border-radius:5px;border:none;cursor:pointer;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff)}
.btn.s{background:rgba(128,128,128,.2);color:var(--tg-theme-text-color,#e6edf3)}
.btn.r{background:var(--tg-theme-destructive-text-color,#e53935);color:#fff}
.btn[disabled]{opacity:.5}
.empty{padding:10px;text-align:center;color:var(--tg-theme-hint-color,#8b949e);font-size:11px}
.ft{display:flex;justify-content:space-between;align-items:center;margin-top:4px;font-size:10px;color:var(--tg-theme-hint-color,#8b949e)}
.msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
</style></head><body>
<div class=hd><span class=tt id=th>直播转播监控</span><button class="btn s" id=rf>🔄 刷新</button></div>
<div class=res id=res></div>
<div id=tasks></div>
<div class=ft><span class=msg id=msg>就绪</span><span id=ts></span></div>
<script>
const W=window.TelegramWidget;
let st={},busy=false;
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
  $('res').innerHTML=
    '<div class=ri><div class=rl>内存</div><div class=rv>'+(r.m!=null?r.m+'%':'?')+'</div><div class=bar><div class="bf'+bc(mp)+'" style="width:'+mp+'%"></div></div></div>'+
    '<div class=ri><div class=rl>CPU</div><div class=rv>'+(r.c!=null?r.c+'%':'?')+'</div><div class=bar><div class="bf'+bc(cp)+'" style="width:'+cp+'%"></div></div></div>'+
    '<div class=ri><div class=rl>运行</div><div class=rv style="font-size:11px">'+(esc(r.up)||'?')+'</div></div>';
  const tasks=st.t||[];
  $('th').textContent='直播转播监控 ('+tasks.length+')';
  if(!tasks.length){
    $('tasks').innerHTML='<div class=empty>暂无配置房间，发送 /addroom 添加</div>';
  }else{
    const shown=tasks.slice(0,5);
    let html=shown.map(function(t){
      const live=t.on&&t.k>0;
      const cls=!t.en?'P':live?'L':'D';
      const badge=!t.en?'已暂停':live?'推流中':'待机';
      const kbps=live?t.k+' kbps':(t.on?'推流启动中':'等待开播');
      return '<div class="card '+cls+'">'+
        '<div class=row><span class=nm>'+esc(t.p)+' #'+esc(t.r)+'</span><span class="bdg '+cls+'">'+badge+'</span></div>'+
        '<div class=row><span class="kbps'+(live?'':' z')+'">'+kbps+'</span>'+
        '<span class=acts>'+
        '<button class="btn s" data-i="'+t.id+'" data-a="snap"'+(busy?' disabled':'')+'>📷</button>'+
        '<button class="btn '+(t.en?'r':'')+'" data-i="'+t.id+'" data-a="tog"'+(busy?' disabled':'')+'>'+(t.en?'■ 停止':'▶ 开启')+'</button>'+
        '</span></div></div>';
    }).join('');
    if(tasks.length>5)html+='<div class=empty>其余 '+(tasks.length-5)+' 个房间请发送 /status 查看</div>';
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

  const mappedTasks = tasks.map((entry) => ({
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
  return `📊 实时监控 · 推流 ${active}/${enabled} · CPU ${cpu} · 内存 ${mem}`;
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
