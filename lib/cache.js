/**
 * Cache disque simple : les segments Google (réutilisés d'une synthèse à l'autre)
 * et les rendus finaux (servis avec support des Range requests).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.TTS_CACHE_DIR || path.join(__dirname, '..', '.cache'));
const MAX_BYTES = (parseInt(process.env.TTS_CACHE_MAX_MB, 10) || 1024) * 1024 * 1024;
const DIRS = { chunks: path.join(ROOT, 'chunks'), renders: path.join(ROOT, 'renders') };
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const hash = (...parts) => crypto.createHash('sha256').update(parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join('\u0000')).digest('hex').slice(0, 24);

function read(file) {
    try { return fs.readFileSync(file); } catch { return null; }
}

function write(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

const chunks = {
    key: (text, tl, slow) => hash('v1', tl, slow ? 'slow' : 'normal', text),
    get: key => read(path.join(DIRS.chunks, `${key}.mp3`)),
    set: (key, buf) => write(path.join(DIRS.chunks, `${key}.mp3`), buf),
};

const renders = {
    audioPath: (id, ext) => path.join(DIRS.renders, `${id}.${ext}`),
    getMeta(id) {
        if (!/^[a-f0-9]{24}$/.test(id)) return null;
        const raw = read(path.join(DIRS.renders, `${id}.json`));
        if (!raw) return null;
        const meta = JSON.parse(raw);
        return fs.existsSync(this.audioPath(id, meta.extension)) ? meta : null;
    },
    set(id, audio, meta) {
        write(this.audioPath(id, meta.extension), audio);
        write(path.join(DIRS.renders, `${id}.json`), JSON.stringify(meta));
    },
};

/** Supprime les fichiers les plus anciens si le cache dépasse TTS_CACHE_MAX_MB. */
function prune() {
    const files = Object.values(DIRS).flatMap(d => fs.readdirSync(d).map(f => {
        const p = path.join(d, f);
        try { const s = fs.statSync(p); return { p, size: s.size, t: s.atimeMs }; } catch { return null; }
    })).filter(Boolean);
    let total = files.reduce((a, f) => a + f.size, 0);
    if (total <= MAX_BYTES) return;
    for (const f of files.sort((a, b) => a.t - b.t)) {
        if (total <= MAX_BYTES * 0.8) break;
        try { fs.unlinkSync(f.p); total -= f.size; } catch {}
    }
}

module.exports = { ROOT, hash, chunks, renders, prune };
