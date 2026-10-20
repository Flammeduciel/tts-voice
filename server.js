#!/usr/bin/env node
/**
 * Serveur HTTP TTS (gratuit, local) basé sur l'endpoint translate_tts de Google Traduction.
 *
 * API v1 (détails : GET /openapi.json, ou l'onglet « API » du playground) :
 *   GET    /v1/health                     état + capacités
 *   GET    /v1/voices                     voix disponibles (?language=fr)
 *   POST   /v1/speech                     texte → audio (ou JSON avec ?response=json|base64)
 *   GET    /v1/speech?text=...            idem, utilisable directement dans <audio src>
 *   POST   /v1/plan                       aperçu du découpage, sans synthèse
 *   POST   /v1/jobs                       synthèse asynchrone (textes longs)
 *   GET    /v1/jobs/:id[/events]          état / progression en direct (SSE)
 *   DELETE /v1/jobs/:id                   annulation
 *   GET    /v1/audio/:id                  audio rendu (Range supporté)
 *   GET    /v1/audio/:id/subtitles.srt|vtt
 * Routes historiques conservées : POST /tts, POST /tts/base64, GET /tts/stream, GET /voices, GET /health
 */

// Charge .env (s'il existe) avant tout : les modules lisent leur configuration au chargement.
// Les variables déjà définies (terminal, Dokploy…) restent prioritaires.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch {}

const fs = require('fs');
const express = require('express');
const cors = require('cors');
const path = require('path');

const { VOICES, loadEdgeVoices, engines } = require('./lib/catalog');
const synth = require('./lib/synth');
const jobs = require('./lib/jobs');
const cache = require('./lib/cache');
const audio = require('./lib/audio');
const google = require('./lib/google');
const openapi = require('./lib/openapi');
const pkg = require('./package.json');

const { ApiError } = synth;
const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_KEYS = (process.env.TTS_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const RATE_LIMIT = parseInt(process.env.TTS_RATE_LIMIT ?? '60', 10); // synthèses / minute / IP (0 = illimité)
// Sans clé (playground, curieux) quand TTS_API_KEYS est défini : accès autorisé mais limite plus stricte
const ANON_RATE_LIMIT = parseInt(process.env.TTS_ANON_RATE_LIMIT ?? '10', 10);

const app = express();
app.disable('x-powered-by');
// Derrière un reverse proxy (Traefik/Dokploy, nginx…) : vraie IP client pour la limite de débit
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(cors({ exposedHeaders: ['X-Audio-Id', 'X-Audio-Duration', 'X-Requests', 'X-Cache', 'Content-Disposition', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'] }));
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// ==================== PAGES ET SEO ====================

// URL publique pour les balises canonical / Open Graph (sinon déduite de la requête, derrière proxy via TRUST_PROXY)
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const baseUrl = req => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

app.get(['/', '/index.html'], (req, res) => {
    res.type('html').set('Cache-Control', 'no-cache').send(INDEX_HTML.replaceAll('%BASE_URL%', baseUrl(req)));
});
app.get('/robots.txt', (req, res) => {
    res.type('text').send(`User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /tts\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl(req)}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>
</urlset>
`);
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ==================== MIDDLEWARES ====================

/**
 * Clé d'API optionnelle. Sans TTS_API_KEYS tout est ouvert (limite TTS_RATE_LIMIT).
 * Avec TTS_API_KEYS : clé valide → TTS_RATE_LIMIT ; sans clé → TTS_ANON_RATE_LIMIT ; clé invalide → 401.
 */
function auth(req, res, next) {
    if (!API_KEYS.length) { req.limit = RATE_LIMIT; return next(); }
    const header = req.get('authorization') || '';
    const key = req.get('x-api-key') || (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.key;
    if (key && !API_KEYS.includes(key)) throw new ApiError(401, 'unauthorized', 'Clé d\'API invalide (en-tête "Authorization: Bearer <clé>" ou "X-API-Key")');
    req.authed = !!key;
    req.limit = key ? RATE_LIMIT : ANON_RATE_LIMIT;
    next();
}

/** Limite simple par IP (fenêtre glissante d'une minute), compteurs séparés avec / sans clé. */
const hits = new Map();
function rateLimit(req, res, next) {
    const limit = req.limit;
    if (!limit) return next();
    const now = Date.now();
    const bucket = `${req.authed ? 'key' : 'anon'}:${req.ip}`;
    const list = (hits.get(bucket) || []).filter(t => now - t < 60000);
    res.set('X-RateLimit-Limit', String(limit));
    if (list.length >= limit) {
        res.set('Retry-After', String(Math.ceil((list[0] + 60000 - now) / 1000)));
        const hint = req.authed || !API_KEYS.length ? '' : ' — une clé d\'API donne une limite plus élevée';
        throw new ApiError(429, 'rate_limited', `Trop de requêtes (max ${limit}/min)${hint}`);
    }
    list.push(now);
    hits.set(bucket, list);
    res.set('X-RateLimit-Remaining', String(limit - list.length));
    next();
}
setInterval(() => { const now = Date.now(); for (const [b, l] of hits) if (l.every(t => now - t > 60000)) hits.delete(b); }, 60000).unref();

/** Fusionne query string et corps ; un corps text/plain est le texte lui-même. */
const readInput = req => typeof req.body === 'string'
    ? { ...req.query, text: req.body }
    : { ...req.query, ...(req.body || {}) };

// ==================== HELPERS ====================

const isTrue = v => v === true || v === 'true' || v === '1';

function audioLinks(id) {
    return { audioUrl: `/v1/audio/${id}`, subtitles: { srt: `/v1/audio/${id}/subtitles.srt`, vtt: `/v1/audio/${id}/subtitles.vtt` } };
}

function describe(result) {
    const { segments, options, extension, ...rest } = result;
    return { ...rest, ...audioLinks(result.id), segments, options };
}

function sendAudio(res, meta, { download = false, filename, cached } = {}) {
    const name = (filename ? String(filename).replace(/[^\w.\- ]+/g, '_').replace(/\.[a-z0-9]+$/i, '') : `speech-${meta.id}`) + `.${meta.extension}`;
    res.set({
        'X-Audio-Id': meta.id,
        'X-Audio-Duration': String(meta.duration),
        'X-Requests': String(meta.requests),
        'X-Cache': cached === undefined ? 'HIT' : (cached ? 'HIT' : 'MISS'),
        'Cache-Control': 'public, max-age=86400, immutable',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
    });
    res.type(meta.mimeType);
    return res.sendFile(cache.renders.audioPath(meta.id, meta.extension), { dotfiles: 'allow' });
}

async function speech(req, res) {
    const input = readInput(req);
    const opts = synth.normalizeOptions(input);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(new Error('client disconnected')); });
    const result = await synth.render(opts, { signal: controller.signal });

    const mode = String(input.response || 'audio').toLowerCase();
    if (mode === 'json') return res.json(describe(result));
    if (mode === 'base64') {
        const data = fs.readFileSync(cache.renders.audioPath(result.id, result.extension));
        return res.json({ ...describe(result), audioBase64: data.toString('base64') });
    }
    if (mode !== 'audio') throw new ApiError(400, 'invalid_parameter', '"response" doit être audio, json ou base64', 'response');
    return sendAudio(res, result, { download: isTrue(input.download), filename: input.filename, cached: result.cached });
}

// ==================== ROUTES v1 ====================

const v1 = express.Router();

v1.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: pkg.version,
        ffmpeg: audio.hasFfmpeg() || null,
        capabilities: {
            formats: audio.hasFfmpeg() ? Object.keys(audio.FORMATS) : ['mp3'],
            speed: [0.25, 4], pitch: [-12, 12], volume: [-20, 20], maxTextLength: synth.MAX_TEXT,
            markup: ['[pause 800ms]', '[voice en-US] … [voice]', '[slow] … [/slow]'],
        },
        auth: API_KEYS.length > 0,
        rateLimitPerMinute: RATE_LIMIT || null,
        anonymousRateLimitPerMinute: API_KEYS.length ? (ANON_RATE_LIMIT || null) : (RATE_LIMIT || null),
        engines: engines(),
        upstream: { googleConcurrency: google.settings.concurrency },
    });
});

/** Champs publics d'une voix. */
const voiceView = v => ({
    id: v.id, engine: v.engine, language: v.language, locale: v.locale || v.id, label: v.label, name: v.name || v.label,
    gender: v.gender, ...(v.engine === 'edge' && { multilingual: v.multilingual, personalities: v.personalities }),
});

v1.get('/voices', (req, res) => {
    const { language, engine, gender, q } = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v).toLowerCase()]));
    const voices = VOICES.filter(v =>
        (!language || v.language === language || v.id.toLowerCase().startsWith(language))
        && (!engine || v.engine === engine)
        && (!gender || v.gender === gender)
        && (!q || `${v.id} ${v.label}`.toLowerCase().includes(q)))
        .map(voiceView);
    res.json({ count: voices.length, default: synth.DEFAULTS.voice, engines: engines(), voices });
});

v1.get('/openapi.json', (req, res) => res.json(openapi));

v1.post('/plan', auth, (req, res) => {
    const opts = synth.normalizeOptions(readInput(req));
    const { items, leading } = synth.plan(opts);
    const chars = items.reduce((a, i) => a + i.text.length, 0);
    res.json({
        requests: items.length,
        characters: chars,
        estimatedDuration: +((chars / 14 + items.reduce((a, i) => a + i.gapAfter, leading) / 1000) / opts.speed).toFixed(1),
        chunks: items.map((i, index) => ({ index, text: i.text, voice: i.voice.id, slow: i.slow, pauseAfter: i.gapAfter })),
    });
});

v1.post('/speech', auth, rateLimit, speech);
v1.get('/speech', auth, rateLimit, speech);

v1.post('/jobs', auth, rateLimit, (req, res) => {
    const job = jobs.create(synth.normalizeOptions(readInput(req)));
    res.status(202).location(`/v1/jobs/${job.id}`).json({
        ...jobs.publicView(job),
        links: { self: `/v1/jobs/${job.id}`, events: `/v1/jobs/${job.id}/events` },
    });
});

function findJob(req) {
    const job = jobs.get(req.params.id);
    if (!job) throw new ApiError(404, 'not_found', 'Job introuvable (expiré après 1 h)');
    return job;
}

v1.get('/jobs/:id', auth, (req, res) => res.json(jobs.publicView(findJob(req))));
v1.delete('/jobs/:id', auth, (req, res) => res.json(jobs.publicView(jobs.cancel(findJob(req).id))));

v1.get('/jobs/:id/events', auth, (req, res) => {
    const job = findJob(req);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = view => {
        res.write(`event: ${['done', 'error', 'cancelled'].includes(view.status) ? view.status : 'progress'}\ndata: ${JSON.stringify(view)}\n\n`);
        if (['done', 'error', 'cancelled'].includes(view.status)) res.end();
    };
    send(jobs.publicView(job));
    if (res.writableEnded) return;
    job.events.on('update', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => { clearInterval(ping); job.events.off('update', send); });
});

function findAudio(req) {
    const meta = cache.renders.getMeta(req.params.id);
    if (!meta) throw new ApiError(404, 'not_found', 'Audio introuvable (purgé du cache ?)');
    return meta;
}

v1.get('/audio/:id', (req, res) => sendAudio(res, findAudio(req), { download: isTrue(req.query.download), filename: req.query.filename }));
v1.get('/audio/:id/meta', (req, res) => res.json(describe(findAudio(req))));
v1.get('/audio/:id/subtitles.:kind', (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'srt' && kind !== 'vtt') throw new ApiError(404, 'not_found', 'Format de sous-titres : srt ou vtt');
    res.type(kind === 'vtt' ? 'text/vtt' : 'application/x-subrip').send(synth.subtitles(findAudio(req).segments, kind));
});

v1.use((req, res) => { throw new ApiError(404, 'not_found', `Route inconnue : ${req.method} ${req.originalUrl}`); });

app.use('/v1', v1);
app.get('/openapi.json', (req, res) => res.json(openapi));

// ==================== ROUTES HISTORIQUES (compatibilité) ====================

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/voices', (req, res) => res.json({ voices: Object.fromEntries(VOICES.map(v => [v.id, { label: v.label }])) }));
app.post('/tts', auth, rateLimit, speech);
app.get('/tts/stream', auth, rateLimit, speech);
app.post('/tts/base64', auth, rateLimit, async (req, res) => {
    const result = await synth.render(synth.normalizeOptions(readInput(req)));
    const data = fs.readFileSync(cache.renders.audioPath(result.id, result.extension));
    res.json({
        success: true, audioBase64: data.toString('base64'), mimeType: result.mimeType,
        filename: `speech-${result.id}.${result.extension}`, size: result.size, chunks: result.requests, cached: result.cached,
    });
});

// ==================== ERREURS ====================

app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new ApiError(400, 'invalid_json', 'Corps JSON invalide');
    else if (err.type === 'entity.too.large') err = new ApiError(413, 'payload_too_large', 'Corps de requête trop volumineux');
    const status = err.status || 500;
    if (status >= 500) console.error(`❌ ${req.method} ${req.originalUrl} :`, err.message);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: { code: err.code || 'internal_error', message: err.message, ...(err.field && { field: err.field }) } });
});

// ==================== DÉMARRAGE ====================

if (require.main === module) (async () => {
    cache.prune();
    await loadEdgeVoices();
    setInterval(cache.prune, 30 * 60 * 1000).unref();
    const server = app.listen(PORT, () => {
        const ff = audio.hasFfmpeg();
        console.log(`
🎤 TTS Server v${pkg.version} — http://localhost:${PORT}
   Playground : http://localhost:${PORT}/
   OpenAPI    : http://localhost:${PORT}/openapi.json
   ffmpeg     : ${ff || '❌ absent (mp3 brut uniquement, sans vitesse/hauteur/pauses)'}
   Voix       : Google ${engines().google.voices} · Edge ${engines().edge.available ? engines().edge.voices : `❌ ${engines().edge.error}`}
   Auth       : ${API_KEYS.length ? `${API_KEYS.length} clé(s), sans clé : ${ANON_RATE_LIMIT || '∞'}/min` : 'désactivée (TTS_API_KEYS)'}
   Cache      : ${cache.ROOT}

   curl -X POST http://localhost:${PORT}/v1/speech -H 'Content-Type: application/json' \\
        -d '{"text":"Bonjour !","voice":"fr-FR-HenriNeural","speed":1.1}' -o bonjour.mp3
`);
    });

    // Arrêt propre (docker stop / redéploiement) : on termine les requêtes en cours
    const shutdown = signal => {
        console.log(`${signal} reçu, arrêt…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
})();

module.exports = app;
