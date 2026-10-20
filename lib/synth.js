/**
 * Moteur de synthèse : options → plan de requêtes → téléchargement (cache + parallélisme)
 * → assemblage audio → rendu final mis en cache, avec minutage de chaque segment (sous-titres).
 */

const { resolveVoice, engines } = require('./catalog');
const text = require('./text');
const google = require('./google');
const edge = require('./edge');
const audio = require('./audio');
const cache = require('./cache');

const MAX_TEXT = parseInt(process.env.TTS_MAX_TEXT, 10) || 100000;

class ApiError extends Error {
    constructor(status, code, message, field) {
        super(message);
        Object.assign(this, { status, code, field });
    }
}

const DEFAULTS = {
    voice: 'fr-FR', speed: 1, pitch: 0, volume: 0, format: 'mp3', bitrate: null, sampleRate: 24000,
    sentencePause: 350, paragraphPause: 800, slow: false, normalize: false, cleanup: false, markup: true,
};

function num(input, field, min, max, def) {
    if (input[field] === undefined || input[field] === null || input[field] === '') return def;
    const v = Number(input[field]);
    if (!Number.isFinite(v) || v < min || v > max) throw new ApiError(400, 'invalid_parameter', `"${field}" doit être un nombre entre ${min} et ${max}`, field);
    return v;
}
const bool = (v, def) => v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === '1' || v === 1;

/** Valide et normalise les paramètres d'entrée (JSON ou query string). Accepte les anciens noms (lang, slow). */
function normalizeOptions(input = {}) {
    if (typeof input.text !== 'string' || !input.text.trim()) throw new ApiError(400, 'missing_text', 'Le champ "text" est requis (chaîne non vide)', 'text');
    if (input.text.length > MAX_TEXT) throw new ApiError(413, 'text_too_long', `Texte trop long (${input.text.length} > ${MAX_TEXT} caractères)`, 'text');

    const voiceId = input.voice ?? input.lang ?? DEFAULTS.voice;
    const voice = resolveVoice(voiceId);
    if (!voice) {
        const hint = /neural$/i.test(voiceId) && !engines().edge.available ? ' (moteur Edge indisponible sur ce serveur)' : '';
        throw new ApiError(400, 'invalid_voice', `Voix inconnue : "${voiceId}"${hint}. Voir GET /v1/voices`, 'voice');
    }

    const format = String(input.format ?? DEFAULTS.format).toLowerCase();
    if (!audio.FORMATS[format]) throw new ApiError(400, 'invalid_parameter', `"format" doit être l'un de : ${Object.keys(audio.FORMATS).join(', ')}`, 'format');

    const opts = {
        text: input.text,
        voice: voice.id,
        speed: num(input, 'speed', 0.25, 4, DEFAULTS.speed),
        pitch: num(input, 'pitch', -12, 12, DEFAULTS.pitch),
        volume: num(input, 'volume', -20, 20, DEFAULTS.volume),
        format,
        bitrate: num(input, 'bitrate', 16, 320, DEFAULTS.bitrate),
        sampleRate: num(input, 'sampleRate', 8000, 48000, DEFAULTS.sampleRate),
        sentencePause: num(input, 'sentencePause', 0, 5000, DEFAULTS.sentencePause),
        paragraphPause: num(input, 'paragraphPause', 0, 10000, DEFAULTS.paragraphPause),
        slow: bool(input.slow, DEFAULTS.slow),
        normalize: bool(input.normalize, DEFAULTS.normalize),
        cleanup: bool(input.cleanup, DEFAULTS.cleanup),
        markup: bool(input.markup, DEFAULTS.markup),
    };
    if (format === 'ogg' && ![8000, 12000, 16000, 24000, 48000].includes(opts.sampleRate)) {
        throw new ApiError(400, 'invalid_parameter', 'Le format ogg (Opus) n\'accepte que 8000, 12000, 16000, 24000 ou 48000 Hz', 'sampleRate');
    }
    if (!audio.hasFfmpeg()) {
        const needsFfmpeg = format !== 'mp3' || opts.speed !== 1 || opts.pitch || opts.volume || opts.normalize || opts.sampleRate !== 24000;
        if (needsFfmpeg) throw new ApiError(501, 'ffmpeg_required', 'Ce réglage nécessite ffmpeg, absent sur ce serveur (seul mp3 brut est disponible)');
    }
    return opts;
}

/** Découpe sans rien télécharger : utile pour prévisualiser / estimer. */
function plan(opts) {
    const source = opts.cleanup ? text.cleanText(opts.text) : opts.text;
    const blocks = text.parseMarkup(source, { voice: resolveVoice(opts.voice), slow: opts.slow, markup: opts.markup, resolveVoice });
    const pauses = { sentence: opts.sentencePause, paragraph: opts.paragraphPause, clause: Math.round(opts.sentencePause * 0.45), word: 40 };
    return text.buildPlan(blocks, pauses);
}

const renderId = opts => cache.hash('render-v2', opts);

/**
 * Répartition de la vitesse : Edge sait parler plus vite/lentement nativement (0.5× – 2×, meilleure qualité),
 * le reste est appliqué localement (atempo). Google n'a pas de vitesse native.
 * [slow] = mode lent natif chez Google, 0.8× natif chez Edge.
 */
function speedPlan(item, speed) {
    if (item.voice.engine !== 'edge') return { native: 1, tempo: speed };
    const wanted = speed * (item.slow ? 0.8 : 1);
    const native = Math.min(2, Math.max(0.5, Math.round(wanted * 100) / 100));
    return { native, tempo: wanted / native };
}

/** Télécharge un segment via le cache disque. */
async function getChunk(item, native, signal) {
    const isEdge = item.voice.engine === 'edge';
    const key = isEdge
        ? cache.chunks.key(item.text, `edge:${item.voice.id}:rate:${native}`, false)
        : cache.chunks.key(item.text, item.voice.tl, item.slow);
    const hit = cache.chunks.get(key);
    if (hit) return { buf: hit, cached: true };
    const buf = isEdge
        ? await edge.fetchSpeech(item.text, item.voice.id, { rate: native, signal })
        : await google.fetchSpeech(item.text, item.voice.tl, { slow: item.slow, signal });
    cache.chunks.set(key, buf);
    return { buf, cached: false };
}

async function synthesize(opts, { onProgress, signal } = {}) {
    const { items, leading } = plan(opts);
    if (!items.length) throw new ApiError(400, 'empty_text', 'Aucun texte à lire après nettoyage/balises', 'text');

    let done = 0, cachedCount = 0;
    onProgress?.({ done, total: items.length });

    // Téléchargement + décodage en parallèle (le limiteur global protège Google).
    // Au premier échec, on annule le reste.
    const ac = new AbortController();
    signal?.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
    const results = await Promise.all(items.map(async item => {
        const { native, tempo } = speedPlan(item, opts.speed);
        const { buf, cached } = await getChunk(item, native, ac.signal);
        const pcm = audio.hasFfmpeg() ? await audio.decode(buf, { tempo, signal: ac.signal }) : null;
        if (cached) cachedCount++;
        onProgress?.({ done: ++done, total: items.length, text: item.text });
        return { buf, pcm };
    })).catch(err => { ac.abort(err); throw signal?.aborted ? signal.reason : err; });

    const segments = [];
    const gap = ms => ms / opts.speed; // les pauses suivent la vitesse
    let output;
    if (audio.hasFfmpeg()) {
        const parts = [audio.silence(gap(leading))];
        let t = gap(leading) / 1000;
        results.forEach(({ pcm }, i) => {
            const d = audio.pcmSeconds(pcm);
            segments.push({ index: i, text: items[i].text, voice: items[i].voice.id, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
            parts.push(pcm, audio.silence(gap(items[i].gapAfter)));
            t += d + gap(items[i].gapAfter) / 1000;
        });
        output = await audio.encode(Buffer.concat(parts), opts, { signal });
    } else {
        // Sans ffmpeg : concaténation MP3 brute, minutage estimé (Google 64 kb/s, Edge 48 kb/s)
        let t = 0;
        results.forEach(({ buf }, i) => {
            const d = buf.length * 8 / (items[i].voice.engine === 'edge' ? 48000 : 64000);
            segments.push({ index: i, text: items[i].text, voice: items[i].voice.id, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
            t += d;
        });
        output = Buffer.concat(results.map(r => r.buf));
    }

    const duration = segments.length ? segments[segments.length - 1].end + gap(items[items.length - 1].gapAfter) / 1000 : 0;
    return { audio: output, segments, duration: +duration.toFixed(3), requests: items.length, cachedRequests: cachedCount };
}

const inflight = new Map();

/**
 * Point d'entrée principal : renvoie le rendu (depuis le cache si identique),
 * et déduplique les rendus identiques lancés en même temps.
 */
async function render(opts, { onProgress, signal } = {}) {
    const id = renderId(opts);
    const existing = cache.renders.getMeta(id);
    if (existing) {
        onProgress?.({ done: existing.requests, total: existing.requests });
        return { ...existing, cached: true };
    }
    if (inflight.has(id)) return inflight.get(id);

    const p = (async () => {
        const r = await synthesize(opts, { onProgress, signal });
        const fmt = audio.FORMATS[opts.format];
        const meta = {
            id, format: opts.format, mimeType: fmt.mime, extension: fmt.ext, size: r.audio.length,
            duration: r.duration, requests: r.requests, segments: r.segments,
            options: { ...opts, text: undefined, characters: opts.text.length }, createdAt: new Date().toISOString(),
        };
        cache.renders.set(id, r.audio, meta);
        return { ...meta, cached: false, cachedRequests: r.cachedRequests };
    })();
    inflight.set(id, p);
    try { return await p; } finally { inflight.delete(id); }
}

/** Sous-titres SRT / WebVTT à partir du minutage des segments. */
function subtitles(segments, kind) {
    const ts = (s, sep) => {
        const ms = Math.round(s * 1000);
        const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
        const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
        const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
        return `${h}:${m}:${sec}${sep}${String(ms % 1000).padStart(3, '0')}`;
    };
    if (kind === 'vtt') return 'WEBVTT\n\n' + segments.map(s => `${s.index + 1}\n${ts(s.start, '.')} --> ${ts(s.end, '.')}\n${s.text}\n`).join('\n');
    return segments.map(s => `${s.index + 1}\n${ts(s.start, ',')} --> ${ts(s.end, ',')}\n${s.text}\n`).join('\n');
}

module.exports = { ApiError, DEFAULTS, MAX_TEXT, normalizeOptions, plan, render, renderId, subtitles };
