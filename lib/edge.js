/**
 * Moteur Microsoft Edge (voix neuronales « Natural » de la lecture à voix haute d'Edge).
 *
 * Le protocole (jeton Sec-MS-GEC, en-têtes) change régulièrement côté Microsoft : on délègue donc
 * à la bibliothèque Python edge-tts, maintenue par sa communauté, via un process persistant
 * (lib/edge_bridge.py). Installation / mise à jour : npm run setup:edge
 * Service non officiel : il peut cesser de fonctionner sans préavis.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const { UpstreamError } = require('./google');

const PYTHON = process.env.EDGE_TTS_PYTHON || 'python3';
const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(__dirname, 'edge_bridge.py');
const ENV = { ...process.env, PYTHONPATH: [path.join(ROOT, '.python'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONIOENCODING: 'utf-8' };

const settings = {
    enabled: process.env.EDGE_TTS !== '0',
    concurrency: parseInt(process.env.EDGE_CONCURRENCY, 10) || 4,
    timeoutMs: 60000,
};

let installed;
/** edge-tts est-il importable ? (vérifié une seule fois) */
function isInstalled() {
    if (installed === undefined) {
        const r = settings.enabled && spawnSync(PYTHON, ['-c', 'import edge_tts'], { env: ENV, timeout: 15000 });
        installed = !!r && r.status === 0;
    }
    return installed;
}

// ==================== PROCESS PERSISTANT ====================

let proc = null, nextId = 1, keepAlive = null;
const pending = new Map();

// Le process Python est détaché (n'empêche pas Node de quitter), sauf pendant qu'une requête est en cours
function track() {
    if (pending.size && !keepAlive) keepAlive = setInterval(() => {}, 1 << 30);
    if (!pending.size && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

function startBridge() {
    proc = spawn(PYTHON, [BRIDGE], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        track();
        clearTimeout(p.timer);
        msg.ok ? p.resolve(msg) : p.reject(new UpstreamError(`Edge : ${msg.error}`, { retryable: !/NoAudioReceived|ValueError/.test(msg.error) }));
    });
    proc.stderr.on('data', d => process.env.DEBUG && process.stderr.write(`[edge] ${d}`));
    proc.stdin.on('error', () => {});
    proc.on('exit', () => {
        proc = null;
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new UpstreamError('Le process edge-tts s\'est arrêté', { retryable: true })); }
        pending.clear();
        track();
    });
    proc.unref();
    proc.stdin.unref?.(); proc.stdout.unref?.(); proc.stderr.unref?.();
}

function call(payload, signal) {
    if (!isInstalled()) return Promise.reject(new UpstreamError('Moteur Edge indisponible : lancez « npm run setup:edge »', { status: 503, code: 'engine_unavailable' }));
    if (!proc) startBridge();
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); track(); reject(new UpstreamError('Edge ne répond pas (timeout)', { retryable: true })); }, settings.timeoutMs);
        pending.set(id, { resolve, reject, timer });
        track();
        signal?.addEventListener('abort', () => {
            if (pending.delete(id)) { clearTimeout(timer); track(); reject(signal.reason); }
        }, { once: true });
        proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
}

// Limiteur : nombre de synthèses Edge simultanées
let active = 0;
const queue = [];
async function limited(fn) {
    if (active >= settings.concurrency) await new Promise(r => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
}

// ==================== API ====================

const pct = v => `${v >= 0 ? '+' : ''}${Math.round(v)}%`;

/**
 * Synthétise un segment. rate : facteur de vitesse natif (0.5 – 2).
 * Renvoie un MP3 24 kHz mono 48 kb/s.
 */
async function fetchSpeech(text, voice, { rate = 1, signal } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            const msg = await limited(() => call({ op: 'synth', text, voice, rate: pct((rate - 1) * 100) }, signal));
            return Buffer.from(msg.audio, 'base64');
        } catch (err) {
            if (signal?.aborted) throw signal.reason;
            if (!err.retryable || attempt >= 3) throw err;
            await new Promise(r => setTimeout(r, 800 * attempt));
        }
    }
}

const VOICES_CACHE = path.join(path.resolve(process.env.TTS_CACHE_DIR || path.join(ROOT, '.cache')), 'edge-voices.json');
const VOICES_TTL = 24 * 3600 * 1000;

/** Liste brute des voix Edge (mise en cache 24 h sur disque, ancienne liste réutilisée si hors ligne). */
async function listVoices() {
    let cached = null;
    try {
        cached = JSON.parse(fs.readFileSync(VOICES_CACHE, 'utf8'));
        if (Date.now() - cached.at < VOICES_TTL) return cached.voices;
    } catch {}
    try {
        const { voices } = await call({ op: 'voices' }, AbortSignal.timeout(20000));
        fs.mkdirSync(path.dirname(VOICES_CACHE), { recursive: true });
        fs.writeFileSync(VOICES_CACHE, JSON.stringify({ at: Date.now(), voices }));
        return voices;
    } catch (err) {
        if (cached) return cached.voices;
        throw err;
    }
}

module.exports = { isInstalled, fetchSpeech, listVoices, settings };
