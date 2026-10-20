/**
 * Traitement audio local via ffmpeg (tout passe par des pipes : compatible ffmpeg en snap).
 *
 * Chaîne : MP3 Google → PCM 24 kHz (silences de bord retirés) → assemblage avec pauses maîtrisées
 *          (vitesse appliquée par segment) → filtres (hauteur, volume, normalisation) → encodage au format demandé.
 */

const { spawn, spawnSync } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SOURCE_RATE = 24000; // fréquence native de l'audio Google

const FORMATS = {
    mp3: { mime: 'audio/mpeg', ext: 'mp3', args: br => ['-c:a', 'libmp3lame', '-b:a', `${br || 96}k`, '-f', 'mp3'] },
    ogg: { mime: 'audio/ogg', ext: 'ogg', args: br => ['-c:a', 'libopus', '-b:a', `${br || 48}k`, '-f', 'ogg'] },
    aac: { mime: 'audio/aac', ext: 'aac', args: br => ['-c:a', 'aac', '-b:a', `${br || 96}k`, '-f', 'adts'] },
    flac: { mime: 'audio/flac', ext: 'flac', args: () => ['-c:a', 'flac', '-sample_fmt', 's16', '-f', 'flac'] },
    wav: { mime: 'audio/wav', ext: 'wav', args: () => ['-c:a', 'pcm_s16le', '-f', 's16le'] }, // en-tête ajouté en JS
};

let ffmpegAvailable;
function hasFfmpeg() {
    if (ffmpegAvailable === undefined) {
        const r = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10000 });
        ffmpegAvailable = r.status === 0 ? (r.stdout.split('\n')[0] || 'ffmpeg') : false;
    }
    return ffmpegAvailable;
}

// Limite le nombre de process ffmpeg simultanés
const MAX_PROCS = 4;
let procs = 0;
const procQueue = [];
async function withProc(fn) {
    if (procs >= MAX_PROCS) await new Promise(r => procQueue.push(r));
    procs++;
    try { return await fn(); } finally { procs--; procQueue.shift()?.(); }
}

function run(args, input, signal) {
    return withProc(() => new Promise((resolve, reject) => {
        const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { signal });
        const out = [], err = [];
        p.stdout.on('data', d => out.push(d));
        p.stderr.on('data', d => err.push(d));
        p.on('error', reject);
        p.on('close', code => code === 0
            ? resolve(Buffer.concat(out))
            : reject(new Error(`ffmpeg (${code}) : ${Buffer.concat(err).toString().trim().slice(-500)}`)));
        p.stdin.on('error', () => {}); // EPIPE si ffmpeg échoue tôt : l'erreur remonte via 'close'
        p.stdin.end(input);
    }));
}

const TRIM = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,'
           + 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse';

/** MP3 → PCM s16le mono 24 kHz, silences de début/fin retirés, tempo éventuel (sans changer la hauteur). */
function decode(mp3, { tempo = 1, signal } = {}) {
    const filters = [TRIM, ...atempoChain(tempo)].join(',');
    return run(['-f', 'mp3', '-i', 'pipe:0', '-af', filters, '-f', 's16le', '-ac', '1', '-ar', String(SOURCE_RATE), 'pipe:1'], mp3, signal);
}

const silence = ms => Buffer.alloc(Math.round(SOURCE_RATE * ms / 1000) * 2);
const pcmSeconds = buf => buf.length / 2 / SOURCE_RATE;

/** atempo n'accepte que [0.5, 100] en ffmpeg 4.x : on enchaîne pour les valeurs plus basses. */
function atempoChain(factor) {
    const parts = [];
    while (factor < 0.5) { parts.push('atempo=0.5'); factor /= 0.5; }
    if (Math.abs(factor - 1) > 1e-3) parts.push(`atempo=${factor.toFixed(4)}`);
    return parts;
}

/** Filtres globaux (la vitesse est appliquée segment par segment, voir decode / synth). */
function buildFilters({ pitch = 0, volume = 0, normalize = false, sampleRate }) {
    const f = [];
    if (pitch) {
        // Décalage de hauteur en demi-tons sans changer la durée
        const ratio = 2 ** (pitch / 12);
        f.push(`asetrate=${Math.round(SOURCE_RATE * ratio)}`, `aresample=${SOURCE_RATE}`, ...atempoChain(1 / ratio));
    }
    if (normalize) f.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    if (volume) f.push(`volume=${volume}dB`);
    if (normalize || volume > 0) f.push('alimiter=limit=0.97');
    f.push(`aresample=${sampleRate}`);
    return f;
}

function wavHeader(dataLength, sampleRate) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + dataLength, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(dataLength, 40);
    return h;
}

/** PCM assemblé → fichier final au format demandé. */
async function encode(pcm, opts, { signal } = {}) {
    const fmt = FORMATS[opts.format];
    const args = ['-f', 's16le', '-ac', '1', '-ar', String(SOURCE_RATE), '-i', 'pipe:0',
        '-af', buildFilters(opts).join(','), '-ac', '1', '-ar', String(opts.sampleRate), ...fmt.args(opts.bitrate), 'pipe:1'];
    const out = await run(args, pcm, signal);
    return opts.format === 'wav' ? Buffer.concat([wavHeader(out.length, opts.sampleRate), out]) : out;
}

module.exports = { FORMATS, SOURCE_RATE, hasFfmpeg, decode, encode, silence, pcmSeconds };
