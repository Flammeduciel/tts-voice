/**
 * Client de l'endpoint gratuit translate_tts de Google Traduction.
 *
 * Ce qui a été vérifié sur l'endpoint :
 *  - 200 caractères max par requête (HTTP 400 au-delà, ou si la langue n'est pas supportée)
 *  - MP3 mono 24 kHz 64 kb/s
 *  - `ttsspeed` n'a aucun effet réel, sauf ≤ ~0.3 qui active le mode lent natif (0.24)
 *  - `client=gtx` et `client=tw-ob` produisent le même audio
 * La vitesse, la hauteur, le volume et les pauses sont donc traités localement (ffmpeg).
 */

const ENDPOINT = 'https://translate.google.com/translate_tts';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Referer': 'https://translate.google.com/',
    'Accept': 'audio/mpeg,*/*',
};

const settings = {
    concurrency: parseInt(process.env.TTS_CONCURRENCY, 10) || 4, // requêtes simultanées vers Google (global)
    spacingMs: parseInt(process.env.TTS_SPACING_MS, 10) || 150,   // écart minimal entre deux départs
    retries: 4,
    timeoutMs: 15000,
};

// Limiteur global partagé par toutes les synthèses du process
let active = 0, lastStart = 0;
const waiting = [];
function acquire() {
    return new Promise(resolve => { waiting.push(resolve); pump(); });
}
function pump() {
    if (!waiting.length || active >= settings.concurrency) return;
    const wait = lastStart + settings.spacingMs - Date.now();
    if (wait > 0) return void setTimeout(pump, wait);
    active++; lastStart = Date.now();
    waiting.shift()();
    pump();
}
function release() { active--; pump(); }

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

function buildUrl(text, tl, slow) {
    const params = new URLSearchParams({
        ie: 'UTF-8', q: text, tl, client: 'tw-ob', total: '1', idx: '0', textlen: String(text.length),
    });
    if (slow) params.set('ttsspeed', '0.24');
    return `${ENDPOINT}?${params}`;
}

class UpstreamError extends Error {
    constructor(message, { status = 502, code = 'upstream_error', retryable = false } = {}) {
        super(message);
        Object.assign(this, { status, code, retryable });
    }
}

async function fetchOnce(url, signal) {
    const res = await fetch(url, {
        headers: HEADERS,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]) : AbortSignal.timeout(settings.timeoutMs),
    });
    if (res.status === 400) throw new UpstreamError('Google a refusé le segment (langue non supportée ou texte invalide)', { status: 400, code: 'upstream_rejected' });
    if (res.status === 429) throw new UpstreamError('Google limite le débit (HTTP 429)', { status: 503, code: 'rate_limited', retryable: true });
    if (!res.ok) throw new UpstreamError(`Google a répondu HTTP ${res.status}`, { retryable: res.status >= 500 });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new UpstreamError('Réponse audio vide', { retryable: true });
    return buf;
}

/** Télécharge le MP3 d'un segment (≤ 200 caractères), avec retries et backoff exponentiel. */
async function fetchSpeech(text, tl, { slow = false, signal } = {}) {
    const url = buildUrl(text, tl, slow);
    for (let attempt = 1; ; attempt++) {
        await acquire();
        try {
            return await fetchOnce(url, signal);
        } catch (err) {
            if (signal?.aborted) throw signal.reason;
            const retryable = err.retryable || err.name === 'TimeoutError' || err.name === 'TypeError';
            if (!retryable || attempt >= settings.retries) {
                if (err instanceof UpstreamError) throw err;
                throw new UpstreamError(`Impossible de joindre Google : ${err.message}`, { code: 'upstream_unreachable' });
            }
        } finally {
            release();
        }
        await sleep(600 * 2 ** attempt + Math.random() * 400, signal);
    }
}

module.exports = { fetchSpeech, buildUrl, settings, UpstreamError };
