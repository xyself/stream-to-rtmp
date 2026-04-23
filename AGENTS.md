# AI Agent Guide: Stream-to-RTMP Codebase

**Project**: Telegram-controlled live stream relay bot (Bilibili/Douyu → YouTube/RTMP)  
**Language**: JavaScript (CommonJS, Node.js 25.8.2+)  
**Architecture**: Scheduler + Per-room Manager + FFmpeg process wrapper

---
11
## Quick Start

**Build/Run Commands**:
```bash
npm install                # Install dependencies
npm start                  # Start bot (node main.js)
```

**Required Environment**:
- `.env` file with `TG_TOKEN`, `TG_CHAT_ID`, `FFMPEG_PATH`, `DATABASE_PATH`
- See [README.md](README.md) Environment Variables section

**Entry Point**: [`main.js`](main.js) → bootstraps scheduler, bot, database, then long-polls for Telegram updates.

---

## Architecture Overview

**Layered Design** (top to bottom):

```
┌─────────────────────────────────────┐
│  Telegram Bot (src/bot/)            │ Command handlers, UI rendering
├─────────────────────────────────────┤
│  Scheduler (src/core/scheduler.js)  │ 30s ticker, lifecycle mgmt
├─────────────────────────────────────┤
│  StreamManager (src/core/manager.js)│ Per-room state machine
├─────────────────────────────────────┤
│  Room + Engine (src/rooms/engines/) │ Platform abstraction
│  FFmpeg Service (src/services/)     │ Subprocess + multi-RTMP
│  Database (src/db/)                 │ SQLite persistence
└─────────────────────────────────────┘
```

**Component Responsibilities**:

| Component | Path | Role |
|-----------|------|------|
| **Bot** | `src/bot/index.js` + `views.js` | Telegram commands, inline keyboards, conversation state |
| **Scheduler** | `src/core/scheduler.js` | Polls DB every 30s, starts/stops StreamManagers |
| **Manager** | `src/core/manager.js` | Core state machine: fetch URL → start FFmpeg → retry on error → poll |
| **Engines** | `src/engines/{bilibili,douyu}.js` | API wrappers: `getStreamUrl()` resolves live stream URL |
| **Rooms** | `src/rooms/` | Factory + base class; routes to platform-specific engines |
| **FFmpegService** | `src/services/ffmpeg-service.js` | Subprocess wrapper; supports multi-target `tee` output |
| **Database** | `src/db/index.js` | SQLite; auto-migrates from JSON; prepared statements only |

**Information Flow**:
1. User sends `/addroom` via Telegram
2. Bot collects room_id, platform, rtmp_url via conversation
3. Saved to DB → `scheduler.tick()` runs immediately
4. Scheduler finds new task → starts `StreamManager`
5. Manager fetches stream URL via engine → spawns FFmpeg subprocess
6. On error/end → retries with backoff (RetryPolicy) or polls for next stream (PollPolicy)

---

## Key Design Patterns

### 1. **Policy Objects** (`RetryPolicy` / `PollPolicy`)
Decouples retry logic from state machine. Located in [`src/core/manager.js`](src/core/manager.js#L52-L102).

```javascript
class RetryPolicy {
  nextDelay(attempts) {
    return Math.min(attempts * 10 + 30, 300) * 1000;  // Exponential backoff, cap at 5min
  }
}
```
**Why**: Easy to adjust retry behavior without touching manager logic.

### 2. **Registry Factory Pattern** (Platform extensibility)
In [`src/engines/index.js`](src/engines/index.js):
```javascript
const registry = { bilibili, douyu };
module.exports = { get: (platform) => registry[platform] };
```
**How to add new platform**: Create `src/engines/huya.js`, export `getStreamUrl()`, register in `registry`. No other files touched.

### 3. **Dependency Injection**
[`main.js`](main.js) injects all dependencies.

```javascript
function createApp({ scheduler, bot, db, logger, processRef }) {
  // All injected
}
```

### 4. **Callback-Based Event Handling** (no EventEmitter)
[`FFmpegService`](src/services/ffmpeg-service.js) callbacks: `onStart`, `onError`, `onEnd`.
```javascript
const ffmpeg = new FFmpegService({
  onStart: () => db.updateError(null),
  onError: (err) => manager.handleFfmpegError(err.message),
  onEnd: () => manager.handleStreamEnded()
});
```
**Why**: Simple, no global event pollution.

### 5. **Telegram Conversation State**
Uses grammY's `@grammyjs/conversations` middleware to maintain multi-step dialog state across messages.  
Located in [`src/bot/index.js`](src/bot/index.js#L115-L140).

---

## Code Organization & Conventions

### Naming Conventions
- **Async functions**: Return Promise (`room.getStreamUrl()`, `manager.start()`)
- **Callbacks**: Named `onXxx` (`onStart`, `onError`, `onEnd`)
- **Private fields**: Use `_fieldName` or don't export
- **Constants**: SCREAMING_SNAKE_CASE
- **Localization**: All logs/errors in Chinese (中文)

### File Structure
```
src/
├─ bot/
│  ├─ index.js          # Command routing, middleware, conversation handlers
│  └─ views.js          # Pure rendering functions (no side effects)
├─ core/
│  ├─ scheduler.js      # Orchestrator: per-30s tick, start/stop managers
│  └─ manager.js        # State machine + Policy classes
├─ services/
│  └─ ffmpeg-service.js # Subprocess wrapper
├─ engines/
│  ├─ index.js          # Registry factory
│  ├─ bilibili.js       # Bilibili API client
│  └─ douyu.js          # Douyu API client
├─ rooms/
│  ├─ index.js          # Room factory
│  ├─ base-room.js      # Abstract base
│  ├─ bilibili-room.js  # Bilibili implementation
│  └─ douyu-room.js     # Douyu implementation
└─ db/
   └─ index.js          # SQLite singleton + prepared statements
```

### Database Conventions
- **All queries**: Use prepared statements (parameterized queries)
- **Transactions**: Wrap multi-step operations in `BEGIN IMMEDIATE TRANSACTION ... COMMIT`
- **Files**: `data/data.db` + optional `-wal` and `-shm` files (WAL mode)
- **Auto-migration**: From JSON to SQLite on first run

---

## Common Development Tasks

### Adding a New Platform (e.g., Huya)
1. Create [`src/engines/huya.js`](src/engines/index.js) with `async getStreamUrl(roomId, headers)` export
2. Create [`src/rooms/huya-room.js`](src/rooms/base-room.js) extending BaseRoom (optional if Huya works like Douyu)
3. Register in [`src/engines/index.js`](src/engines/index.js): `const huya = require('./huya'); registry.huya = huya;`
4. Document usage in [`README.md`](README.md)

### Adding a Telegram Command
1. Define handler in [`src/bot/index.js`](src/bot/index.js#L140)
   ```javascript
   bot.command('mycommand', async (ctx) => {
     // Handle command
   });
   ```
2. Add UI rendering in [`src/bot/views.js`](src/bot/views.js) if needed

### Debugging FFmpeg Issues
1. Check [`src/services/ffmpeg-service.js`](src/services/ffmpeg-service.js) for spawn args
2. Add `FFMPEG_DEBUG=1` to `.env` for verbose logging (if implemented)
3. Inspect actual FFmpeg command in logs: `[FFmpeg] Command: ffmpeg ...`
4. Common codes: exit code 152 (auth fail), 224/187 (connection issues), SIGSEGV (crash)

### Adding Error Recovery
1. Identify error type in `manager.js` `handleRoomError()` or `handleFfmpegError()`
2. Choose retry strategy: `RetryPolicy` (exponential backoff) or `PollPolicy` (fixed delay)
3. Update [`src/core/manager.js`](src/core/manager.js#L52-L102) policy logic if needed

---

## Critical Patterns & Pitfalls

### ✅ DO:
- **Use prepared statements** for all DB queries (prevent SQL injection)
- **Await async functions** in manager; use Promise.all() for parallel ops
- **Clean up FFmpeg processes** on error/stop (subprocess must terminate)
- **Check ProcessRef capabilities** before sending signals (PM2 only has `.send()`)
- **Validate RTMP URLs** before saving (must not contain `\|` for tee format)

### ❌ DON'T:
- **Modify Policy delays directly** in manager logic; adjust RetryPolicy/PollPolicy instead
- **Add engine-specific code to manager**; keep room/engine abstraction clean
- **Hardcode Telegram chat IDs**; always read from `.env` or DB
- **Forget to register new engines** in `src/engines/index.js`
- **Use `console.log()` for errors**; they should go through logger for consistency

### 🚨 Known Issues & Workarounds:

| Issue | Root Cause | Workaround |
|-------|-----------|-----------|
| **Bilibili short ID** | `https://live.bilibili.com/12345` needs real ID fetch | `manager.js` auto-handles via `room.getRealId()` |
| **Douyu crypto dependency** | Loads CryptoJS from CDN dynamically | Offline mode fails; ensure network access |
| **FFmpeg tee format URL encoding** | Special chars in RTMP URLs break tee syntax | Validate & encode RTMP URLs before save |
| **ProcessRef signal handling** | Code assumes PM2 has `.send()` method | Will fail gracefully if not PM2; logs warning |
| **Database WAL files** | Docker volume mount must include `-wal` and `-shm` | Mount `/app/data` as persistent volume |
| **Telegram conversation ordering** | API may deliver messages out-of-order | `state.step` guard prevents most issues; reset state on errors |
| **FFmpeg connection timeout** | No read timeout, only connect timeout | Relies on FFmpeg `-reconnect` param (already configured) |
| **Infinite retry loop** | No absolute limit on retries (only exponential cap) | Theoretically infinite; monitor for zombie processes |

---

## Important Files & Where to Edit

| Task | Edit |
|------|------|
| Add command | [`src/bot/index.js`](src/bot/index.js) |
| Add platform | [`src/engines/[platform].js`](src/engines/bilibili.js) + [`src/rooms/[platform]-room.js`](src/rooms/bilibili-room.js) |
| Adjust retries | [`src/core/manager.js`](src/core/manager.js#L52-L102) (Policy classes) |
| UI layout | [`src/bot/views.js`](src/bot/views.js) |
| DB schema | [`src/db/index.js`](src/db/index.js) |
| FFmpeg args | [`src/services/ffmpeg-service.js`](src/services/ffmpeg-service.js) |

---

## Navigation Tips

- **Understand flow**: Start with [`main.js`](main.js) → [`src/core/scheduler.js`](src/core/scheduler.js) → [`src/core/manager.js`](src/core/manager.js)
- **Understand Telegram UI**: [`src/bot/index.js`](src/bot/index.js) + [`src/bot/views.js`](src/bot/views.js)
- **Add platform**: Copy [`src/engines/bilibili.js`](src/engines/bilibili.js) → modify API client logic
- **Debug production**: Enable PM2 logs via `pm2 logs live-relay-bot` or Docker logs via `docker compose logs -f`

---

## Quick Reference: Response Codes & Meanings

**FFmpeg Exit Codes** (from logs):
- `0` = Normal exit (stream ended)
- `152` = Auth failure (invalid stream URL or credentials)
- `187`, `224` = Connection/network errors
- `SIGSEGV` = Segmentation fault (FFmpeg crash, rare)
- `null (signal: SIGTERM)` = Manual process termination

**Telegram Errors**:
- `400: Bad Request: message is not modified` = No content change between edits (safe, ignore)
- `401: Unauthorized` = Invalid TG_TOKEN
- `403: Forbidden` = Bot not member of target chat

---

## Related Documentation

- **Deployment**: [README.md - PM2 & Docker sections](README.md)
- **Environment Setup**: [README.md - Environment Variables](README.md)
- **Architecture Decisions**: [docs/superpowers/specs/](docs/superpowers/specs/)
