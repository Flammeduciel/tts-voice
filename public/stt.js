/* Transcription (parole → texte) par la reconnaissance vocale du navigateur.
 *
 * - Fichier : l'audio est lu (son coupé si voulu) et sa piste est passée à SpeechRecognition.start(track).
 * - Micro : reconnaissance du micro, enregistrement conservé pour la réécoute.
 * - Horodatages : l'audio est décodé localement pour repérer les silences ; les phrases sont
 *   découpées sur ces silences (début/fin précis) et les mots y sont placés d'après le moment
 *   où le navigateur les a reconnus, puis répartis sur les passages parlés.
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// start(track) est récent ; available() a été livré en même temps et sert d'indice de support
const SR_TRACK = !!SR && typeof SR.available === 'function';

const STT_LANGS = [
    ['fr-FR', 'Français (France)'], ['fr-CA', 'Français (Canada)'], ['fr-BE', 'Français (Belgique)'], ['fr-CH', 'Français (Suisse)'],
    ['en-US', 'Anglais (États-Unis)'], ['en-GB', 'Anglais (Royaume-Uni)'], ['es-ES', 'Espagnol (Espagne)'], ['es-MX', 'Espagnol (Mexique)'],
    ['de-DE', 'Allemand'], ['it-IT', 'Italien'], ['pt-BR', 'Portugais (Brésil)'], ['pt-PT', 'Portugais (Portugal)'],
    ['nl-NL', 'Néerlandais'], ['pl-PL', 'Polonais'], ['ru-RU', 'Russe'], ['tr-TR', 'Turc'], ['ar-SA', 'Arabe'],
    ['hi-IN', 'Hindi'], ['zh-CN', 'Chinois (mandarin)'], ['ja-JP', 'Japonais'], ['ko-KR', 'Coréen'],
];

const REC_LATENCY = 0.35;     // retard moyen entre la parole et l'apparition du mot (s)
const FRAME = 0.02;           // analyse de l'énergie par trames de 20 ms
const WORD_GAP = 0.25;        // silence plus court : à l'intérieur d'un mot / d'une phrase
const SENTENCE_GAP = 0.5;     // silence plus long : fin de phrase
const MAX_SENTENCE = 15;      // au-delà (s), une phrase est coupée sur son plus long silence interne

const stt = {
    mode: 'file',
    file: null,
    running: false,
    result: null,
    urls: [],
};

// ==================== RECONNAISSANCE ====================

/** Session de reconnaissance qui redémarre seule (le navigateur coupe après un silence ou une durée). */
function recognize({ lang, track, clock, onUpdate }) {
    const committed = [];       // mots validés des sessions précédentes
    const seen = [];            // instant (clock) d'apparition de chaque mot
    let session = [];
    let rec = null;
    let stopping = false;
    let lastError = null;
    let done;
    const finished = new Promise(r => { done = r; });

    const words = text => text.trim().split(/\s+/).filter(Boolean);

    function startSession() {
        rec = new SR();
        rec.lang = lang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        let finals = [];
        rec.onresult = e => {
            const now = clock();
            finals = [];
            let interim = [];
            for (const res of e.results) (res.isFinal ? finals : interim).push(...words(res[0].transcript));
            session = finals.concat(interim);
            const all = committed.concat(session);
            if (seen.length > all.length) seen.length = all.length;     // correction : les mots suivants seront re-datés
            for (let k = 0; k < all.length; k++) if (seen[k] == null) seen[k] = now;
            onUpdate({ final: committed.concat(finals).join(' '), interim: interim.join(' ') });
        };
        rec.onerror = e => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            lastError = e.error;
        };
        rec.onend = () => {
            committed.push(...finals);
            seen.length = Math.min(seen.length, committed.length);
            session = [];
            const fatal = ['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(lastError);
            if (stopping || fatal) return done({ words: committed.slice(), seen: seen.slice(), error: lastError });
            lastError = null;
            setTimeout(() => { try { startSession(); } catch (err) { done({ words: committed.slice(), seen: seen.slice(), error: err.message }); } }, 50);
        };
        track ? rec.start(track) : rec.start();
    }

    startSession();
    return {
        finished,
        stop() {
            if (stopping) return;
            stopping = true;
            try { rec.stop(); } catch {}
            setTimeout(() => { try { rec.abort(); } catch {} }, 4000);    // filet de sécurité
        },
    };
}

// ==================== ANALYSE AUDIO ====================

/** Décode l'audio (mono 16 kHz) et renvoie l'énergie par trame en dB. */
async function analyzeAudio(blob) {
    const ctx = new AudioContext({ sampleRate: 16000 });
    try {
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        const data = buf.getChannelData(0);
        const step = Math.round(buf.sampleRate * FRAME);
        const db = new Float32Array(Math.floor(data.length / step));
        for (let f = 0; f < db.length; f++) {
            let sum = 0;
            for (let i = f * step, end = i + step; i < end; i++) sum += data[i] * data[i];
            db[f] = 10 * Math.log10(sum / step + 1e-10);
        }
        return { duration: buf.duration, db };
    } finally {
        ctx.close();
    }
}

/** Passages parlés [{start, end}] à partir de l'énergie (seuil adaptatif au bruit de fond). */
function speechRegions({ db }) {
    const sorted = Float32Array.from(db).sort();
    const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -100;
    const peak = sorted[Math.floor(sorted.length * 0.98)] ?? 0;
    const threshold = Math.max(floor + 0.25 * (peak - floor), floor + 8, -55);
    const regions = [];
    let start = -1;
    for (let f = 0; f <= db.length; f++) {
        const loud = f < db.length && db[f] > threshold;
        if (loud && start < 0) start = f;
        if (!loud && start >= 0) { regions.push({ start: start * FRAME, end: f * FRAME }); start = -1; }
    }
    // Fusionne les micro-coupures, retire les clics isolés
    const merged = [];
    for (const r of regions) {
        const last = merged.at(-1);
        if (last && r.start - last.end < WORD_GAP) last.end = r.end;
        else merged.push({ ...r });
    }
    return merged.filter(r => r.end - r.start >= 0.08);
}

/** Groupe les passages parlés en phrases (coupure sur les silences longs). */
function sentenceChunks(regions) {
    const chunks = [];
    for (const r of regions) {
        const last = chunks.at(-1);
        if (last && r.start - last.end < SENTENCE_GAP) { last.end = r.end; last.parts.push(r); }
        else chunks.push({ start: r.start, end: r.end, parts: [r] });
    }
    // Phrases trop longues : coupe sur le plus long silence interne, récursivement
    const out = [];
    const split = c => {
        if (c.end - c.start <= MAX_SENTENCE || c.parts.length < 2) return out.push(c);
        let best = 1, gap = -1;
        for (let i = 1; i < c.parts.length; i++) {
            const g = c.parts[i].start - c.parts[i - 1].end;
            if (g > gap) { gap = g; best = i; }
        }
        const a = c.parts.slice(0, best), b = c.parts.slice(best);
        split({ start: a[0].start, end: a.at(-1).end, parts: a });
        split({ start: b[0].start, end: b.at(-1).end, parts: b });
    };
    chunks.forEach(split);
    return out;
}

// ==================== ALIGNEMENT ====================

const INTERROGATIVE = /^(est-ce|pourquoi|comment|combien|quand|où|qui|quel|quelle|quels|quelles|que|qu'est-ce|why|how|what|when|where|who|which|is|are|do|does|can)\b/i;

function finishSentence(words) {
    if (!words.length) return '';
    words[0].word = words[0].word.charAt(0).toLocaleUpperCase() + words[0].word.slice(1);
    let text = words.map(w => w.word).join(' ');
    if (!/[.!?…]$/.test(text)) {
        const end = INTERROGATIVE.test(text) ? ' ?' : '.';
        text += end;
        words.at(-1).word += end;
    }
    return text.replace(/\s+([,.])/g, '$1');
}

/**
 * Place les mots reconnus dans les phrases détectées.
 * words[k] a été vu à seen[k] (horloge de l'audio) ; il a été prononcé un peu avant.
 */
function align(words, seen, audioInfo) {
    const r3 = x => Math.round(x * 1000) / 1000;
    let est = words.map((_, k) => Math.max(0, (seen[k] ?? seen.at(-1) ?? 0) - REC_LATENCY));
    for (let k = 1; k < est.length; k++) est[k] = Math.max(est[k], est[k - 1]);

    const chunks = audioInfo ? sentenceChunks(speechRegions(audioInfo)) : [];
    if (!chunks.length) {
        // Sans analyse audio : phrases coupées sur les pauses de reconnaissance
        chunks.length = 0;
        let cur = null;
        est.forEach((t, k) => {
            if (!cur || t - est[k - 1] > 1.2) { cur = { start: Math.max(0, t - 0.3), end: t + 0.4, parts: [] }; chunks.push(cur); }
            cur.end = t + 0.4;
        });
        chunks.forEach(c => c.parts.push({ start: c.start, end: c.end }));
    }

    // Chaque mot va dans la phrase qui contient (ou précède de plus près) son instant estimé
    const groups = chunks.map(() => []);
    let ci = 0;
    words.forEach((w, k) => {
        const t = est[k];
        while (ci < chunks.length - 1) {
            const next = chunks[ci + 1];
            const gapMid = (chunks[ci].end + next.start) / 2;
            if (t >= next.start || t > gapMid + REC_LATENCY) ci++;
            else break;
        }
        groups[ci].push(w);
    });

    const sentences = [];
    chunks.forEach((c, i) => {
        if (!groups[i].length) return;      // passage sans parole reconnue (musique, bruit)
        // Répartit les mots sur le temps réellement parlé, au prorata de leur longueur
        const speech = c.parts.reduce((s, p) => s + (p.end - p.start), 0);
        const weights = groups[i].map(w => w.length + 2);
        const total = weights.reduce((a, b) => a + b, 0);
        const at = x => {   // position x ∈ [0, speech] → temps réel
            for (const p of c.parts) {
                const len = p.end - p.start;
                if (x <= len) return p.start + x;
                x -= len;
            }
            return c.end;
        };
        let acc = 0;
        const ws = groups[i].map((w, j) => {
            const s = at(acc / total * speech);
            acc += weights[j];
            return { word: w, start: r3(s), end: r3(at(acc / total * speech - 0.02)) };
        });
        const text = finishSentence(ws);
        sentences.push({ id: sentences.length, start: r3(c.start), end: r3(c.end), text, words: ws });
    });
    return sentences;
}

// ==================== EXPORTS ====================

const ts = (s, sep) => {
    const ms = Math.round(s * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
};
const clockLabel = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** Sous-titres : une phrase par sous-titre, coupée si elle dépasse 2 lignes de 42 caractères. */
function cues(sentences) {
    const out = [];
    for (const s of sentences) {
        let cur = [];
        const flush = () => {
            if (!cur.length) return;
            out.push({ start: cur[0].start, end: cur.at(-1).end, text: wrap(cur.map(w => w.word).join(' ')) });
            cur = [];
        };
        for (const w of s.words) {
            const len = cur.map(x => x.word).join(' ').length + w.word.length + 1;
            if (cur.length && (len > 84 || w.end - cur[0].start > 7)) flush();
            cur.push(w);
        }
        flush();
        out.at(-1).end = Math.max(out.at(-1).end, s.end);
    }
    return out;
}
function wrap(text) {
    if (text.length <= 42) return text;
    const mid = text.length / 2;
    let cut = -1;
    for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
    return cut < 0 ? text : `${text.slice(0, cut)}\n${text.slice(cut + 1)}`;
}
const toSrt = r => cues(r.sentences).map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${c.text}\n`).join('\n');
const toVtt = r => 'WEBVTT\n\n' + cues(r.sentences).map(c => `${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${c.text}\n`).join('\n');
const toTxt = r => r.sentences.map(s => s.text).join('\n') + '\n';

// ==================== INTERFACE ====================

function sttError(msg) {
    $('#sttError').textContent = msg || '';
    $('#sttError').hidden = !msg;
}

const SR_ERRORS = {
    'not-allowed': 'Accès au micro ou à la reconnaissance refusé par le navigateur.',
    'service-not-allowed': 'Le service de reconnaissance du navigateur est désactivé.',
    'language-not-supported': 'Langue non prise en charge par la reconnaissance du navigateur.',
    'audio-capture': 'Aucun micro détecté.',
    network: 'Le service de reconnaissance du navigateur est injoignable (connexion ?).',
};

function setMode(mode) {
    stt.mode = mode;
    $$('#sttMode button').forEach(b => b.classList.toggle('on', b.dataset.v === mode));
    $('#sttDrop').hidden = mode !== 'file';
    $('#sttMicBox').hidden = mode !== 'mic';
    $('#sttListenWrap').hidden = mode !== 'file';
    updateMicBox();
    updateStartButton();
}

function updateStartButton() {
    const ok = !!SR && (stt.mode === 'mic' || (stt.file && SR_TRACK));
    $('#sttStart').disabled = stt.running || !ok;
}

function pickFile(file) {
    if (!file) return;
    if (!/^(audio|video)\//.test(file.type) && !/\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|mp4|mov|mkv)$/i.test(file.name)) {
        return sttError('Ce fichier ne semble pas être un fichier audio ou vidéo.');
    }
    sttError('');
    stt.file = file;
    $('#sttFileName').textContent = file.name;
    $('#sttFileInfo').textContent = `${fmtSize(file.size)} · durée en cours de lecture…`;
    const probe = new Audio(URL.createObjectURL(file));
    probe.onloadedmetadata = () => {
        // Aperçu du temps de transcription : tranches lues en même temps, à 1,5× (hauteur conservée)
        const n = Math.max(2, Math.min(MAX_PARALLEL, Math.round(probe.duration / CHUNK_TARGET)));
        const speed = SR_TRACK && probe.duration > CHUNK_TARGET * 1.5 ? n * FAST_RATE : 1;
        const wait = fmtTime(probe.duration / speed);
        $('#sttFileInfo').textContent = `${fmtSize(file.size)} · ${fmtTime(probe.duration)} · transcription ≈ ${wait}`;
        URL.revokeObjectURL(probe.src);
    };
    probe.onerror = () => sttError('Format non lisible par le navigateur.');
    updateStartButton();
}

function updateMicBox() {
    const on = stt.running && stt.mode === 'mic';
    $('#sttMicBox').classList.toggle('recording', on);
    $('#sttMicTitle').textContent = on ? 'Je vous écoute… (cliquez pour arrêter)' : 'Cliquez pour transcrire votre voix';
}

function setRunning(running) {
    stt.running = running;
    $('#sttStop').hidden = !running;
    $('#sttProgress').hidden = !running;
    $('#sttLive').hidden = !running;
    $$('#sttMode button, #sttLang').forEach(el => { el.disabled = running; });
    $('#sttStart').querySelector('span').textContent = running ? 'Transcription…' : 'Transcrire';
    updateMicBox();
    updateStartButton();
}

function showLive({ final, interim }) {
    const el = $('#sttLiveText');
    el.textContent = final;
    if (interim) {
        const i = document.createElement('span');
        i.className = 'muted';
        i.textContent = (final ? ' ' : '') + interim;
        el.append(i);
    }
    el.scrollTop = el.scrollHeight;
}

function progress(done, total, label) {
    $('#sttProgressBar').style.width = total ? `${Math.min(100, done / total * 100)}%` : '100%';
    $('#sttProgressText').textContent = label;
}

async function start() {
    if (stt.running) return;
    sttError('');
    $('#sttLiveText').textContent = '';
    const lang = $('#sttLang').value;
    store.set('sttLang', lang);
    setRunning(true);
    try {
        const out = stt.mode === 'file' ? await runFile(lang) : await runMic(lang);
        if (out) showSttResult(out);
    } catch (e) {
        sttError(e.message);
    } finally {
        setRunning(false);
        stt.stop = null;
    }
}

/**
 * Lecture du fichier en tranches lues en même temps (qui ne se chevauchent pas) et reconnues chacune
 * par sa propre session, à vitesse accélérée (hauteur du son conservée). Sur un fichier d'une heure :
 * ~quatre tranches de 15 min en même temps, à 1,5×, soit ~5 minutes au lieu d'une heure.
 */
const MAX_PARALLEL = 4;    // tranches lues simultanément
const CHUNK_TARGET = 25;   // durée visée d'une tranche, en secondes
const FAST_RATE = 1.5;     // vitesse de lecture des tranches (hauteur conservée)

/** Points de coupe placés sur le silence le plus proche de chaque coupe idéale. */
function cutPoints(regions, duration, n) {
    const cuts = [];
    for (let k = 1; k < n; k++) {
        const ideal = k * duration / n;
        let best = ideal, dist = Infinity;
        for (const r of regions) {
            const mid = (r.start + r.end) / 2;
            const d = Math.abs(mid - ideal);
            if (d < dist && mid > (cuts.at(-1) ?? 0) + 1) { dist = d; best = mid; }
        }
        cuts.push(best);
    }
    return cuts;
}

/** Points d'erreur liés à la mise en place (lecture, découpage) : ne pas retenter différemment. */
const SETUP_ERROR = /captureStream|piste audio|Format non lisible/i;
const isFatal = err => ['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(err);

/** Lecture audible du fichier pendant la transcription (l'utilisateur suit l'enregistrement). */
function playListening(file) {
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.play().catch(() => {});
    return audio;
}

/**
 * Reconnaît la tranche [from, to] du fichier, lue en sourdine à la vitesse demandée.
 * Renvoie { words, seen } (instants estampillés en temps du fichier) ou lève une erreur de mise en place.
 */
async function runSegment(file, lang, { from, to }, rate, onUpdate, slot, read) {
    const audio = new Audio();
    read[slot] = audio;                       // pour l'arrêt global et la progression
    audio.src = URL.createObjectURL(file);
    audio.muted = true;
    audio.preservesPitch = true;              // accélération sans écart de hauteur
    audio.playbackRate = rate;
    let track;
    try {
        await new Promise((ok, ko) => { audio.oncanplay = ok; audio.onerror = () => ko(new Error('Format non lisible par le navigateur.')); });
        if (!audio.captureStream) throw new Error('Ce navigateur ne sait pas lire un fichier pour la transcription. Essayez Chrome ou Edge.');
        audio.currentTime = from;
        track = audio.captureStream().getAudioTracks()[0];
        if (!track) throw new Error('Aucune piste audio dans ce fichier.');
        await audio.play();
    } catch (e) {
        URL.revokeObjectURL(audio.src);
        e.fatal = true;
        throw e;
    }

    const session = recognize({ lang, track, clock: () => audio.currentTime, onUpdate });
    const timer = setInterval(() => {
        if (stt.canceled || audio.currentTime >= to) { audio.pause(); if (stt.canceled) session.stop(); else setTimeout(() => session.stop(), 1000); }
    }, 100);
    try {
        return await session.finished;
    } finally {
        clearInterval(timer);
        audio.pause();
        URL.revokeObjectURL(audio.src);
    }
}

/** Transcription d'un fichier par tranches coupées aux silences et lues en même temps, à 1,5×. */
async function runParallel(file, lang, info, listen) {
    const n = Math.max(2, Math.min(MAX_PARALLEL, Math.round(info.duration / CHUNK_TARGET)));
    const cuts = cutPoints(speechRegions(info), info.duration, n);
    const segments = [];
    for (let k = 0; k < n; k++) segments.push({ from: k ? cuts[k - 1] : 0, to: k < n - 1 ? cuts[k] : info.duration });
    const read = [];                            // éléments <audio> des tranches, pour progression et arrêt
    const listeners = [];
    if (listen) listeners.push(playListening(file));
    stt.live = null;
    stt.stop = () => {                         // bouton Arrêter : coupe toutes les tranches
        stt.canceled = true;
        listeners.forEach(a => a.pause());
    };

    progress(0, 1, `Transcription rapide : ${n} tranches à la fois, vitesse ×${FAST_RATE}`);
    const timer = setInterval(() => {          // progression : positions réelles des tranches
        let done = 0, total = 0;
        for (let k = 0; k < n; k++) {
            total += segments[k].to - segments[k].from;
            done += read[k] ? Math.max(0, Math.min(segments[k].to, read[k].currentTime) - segments[k].from) : 0;
        }
        progress(done, total, `Transcription rapide ×${(FAST_RATE * Math.min(n, MAX_PARALLEL)).toFixed(1).replace('.', ',')}`);
    }, 250);
    const results = await Promise.all(segments.map(async ({ from, to }, k) => {
        const seg = { from, to };
        try {
            const out = await runSegment(file, lang, seg, FAST_RATE, live => showLiveMerged(k, live), k, read);
            return { ...out, seg };
        } catch (e) {
            return { words: [], seen: [], error: e.message, fatal: !!e.fatal };
        }
    }));
    clearInterval(timer);
    listeners.forEach(a => a.pause());
    URL.revokeObjectURL(listeners[0]?.src ?? '');
    if (stt.canceled) return null;

    if (!results.some(r => r.words.length)) {
        const first = results[0] ?? {};
        const e = new Error(first.error ? (SR_ERRORS[first.error] || first.error) : 'Aucune parole reconnue.');
        e.fatal = !!first.fatal || (first.error ? isFatal(first.error) : false);
        throw e;
    }
    // Remet les mots dans l'ordre du fichier (les tranches ne finissent pas toutes en même temps)
    const words = [], seen = [];
    results.forEach(r => r.words.forEach((w, i) => { words.push(w); seen.push(r.seen[i] ?? 0); }));
    progress(1, 1, 'Calcul des horodatages…');
    return { words, seen, info, duration: info.duration, lang, file, merge: true };
}

/** Ancienne méthode : playback intégral à vitesse normale. Sert de repli si la transcription rapide échoue. */
async function runSequential(file, lang, info, listen) {
    if (stt.canceled) return null;
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.muted = !listen;                      // sans écoute : en sourdine ; avec écoute : c'est elle la lecture audible
    await new Promise((ok, ko) => { audio.oncanplay = ok; audio.onerror = () => ko(new Error('Format non lisible par le navigateur.')); });
    if (!audio.captureStream) throw new Error('Ce navigateur ne sait pas lire un fichier pour la transcription. Essayez Chrome ou Edge.');
    const track = audio.captureStream().getAudioTracks()[0];
    if (!track) throw new Error('Aucune piste audio dans ce fichier.');
    await audio.play();

    let canceled = false;
    let session;
    stt.stop = () => { canceled = true; stt.canceled = true; audio.pause(); session.stop(); };
    session = recognize({ lang, track, clock: () => audio.currentTime, onUpdate: showLive });
    const timer = setInterval(() => progress(audio.currentTime, audio.duration, `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`), 250);
    audio.onended = () => setTimeout(() => session.stop(), 1200);   // laisse arriver les derniers mots

    const { words, seen, error } = await session.finished;
    clearInterval(timer);
    audio.pause();
    URL.revokeObjectURL(audio.src);
    if (canceled) return null;
    if (error && !words.length && isFatal(error)) throw new Error(SR_ERRORS[error] || `Erreur de reconnaissance : ${error}`);
    if (!words.length) throw new Error('Aucune parole reconnue. Vérifiez la langue choisie.');
    return { words, seen, info, duration: info?.duration ?? audio.duration, lang, file };
}

/** Regroupe les mots des tranches, les remet dans l'ordre du fichier et construit le résultat. */
function finishFile({ words, seen, info, duration, lang, file, merge }) {
    if (!words.length) throw new Error('Aucune parole reconnue. Vérifiez la langue choisie.');
    let ori = words;
    let seq = seen;
    if (merge) {                                // tranches : remise dans l'ordre chronologique du fichier
        const zipped = words.map((w, k) => [seen[k] ?? 0, w]).sort((a, b) => a[0] - b[0]);
        ori = zipped.map(x => x[1]);
        seq = zipped.map(x => x[0]);
    }
    progress(1, 1, 'Calcul des horodatages…');
    return build({ words: ori, seen: seq, info, duration, lang, blob: file, source: { type: 'file', name: file.name } });
}

/** Texte « en direct » regroupé : chaque tranche contribue dans son ordre du fichier. */
function showLiveMerged(index, live) {
    stt.live ??= [];
    stt.live[index] = [live.final, live.interim].filter(Boolean).join(' ');
    const el = $('#sttLiveText');
    el.textContent = stt.live.filter(Boolean).join(' ');
    el.scrollTop = el.scrollHeight;
}

async function runFile(lang) {
    stt.canceled = false;
    const file = stt.file;
    const listen = $('#sttListen').checked;
    store.set('sttListen', listen);

    // Les tranches sont coupées sur les silences : l'analyse doit être prête avant d'ouvrir les tranches
    const info = await analyzeAudio(file).catch(() => null);
    let fast = null;
    if (info && info.duration > CHUNK_TARGET * 1.5 && SR_TRACK) {
        try {
            fast = await runParallel(file, lang, info, listen);
        } catch (e) {
            if (stt.canceled || e.fatal || SETUP_ERROR.test(e.message)) throw e;
            fast = null;                        // repli : lecture simple
        }
    }
    if (fast) return finishFile(fast);
    const slow = await runSequential(file, lang, info, listen);
    return slow ? finishFile(slow) : null;
}

async function runMic(lang) {
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
        throw new Error(SR_ERRORS['not-allowed']);
    }
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    const t0 = performance.now();
    const clock = () => (performance.now() - t0) / 1000;
    recorder.start(1000);

    const track = SR_TRACK ? stream.getAudioTracks()[0] : null;
    const session = recognize({ lang, track, clock, onUpdate: showLive });
    stt.stop = () => session.stop();
    const timer = setInterval(() => progress(0, 0, `Écoute… ${fmtTime(clock())}`), 250);

    const { words, seen, error } = await session.finished;
    clearInterval(timer);
    const recorded = new Promise(r => { recorder.onstop = r; });
    recorder.stop();
    await recorded;
    stream.getTracks().forEach(t => t.stop());
    if (error && !words.length) throw new Error(SR_ERRORS[error] || `Erreur de reconnaissance : ${error}`);
    if (!words.length) throw new Error('Aucune parole reconnue.');

    progress(1, 1, 'Calcul des horodatages…');
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const info = await analyzeAudio(blob).catch(() => null);
    return build({ words, seen, info, duration: info?.duration ?? clock(), lang, blob, source: { type: 'microphone' } });
}

function build({ words, seen, info, duration, lang, blob, source }) {
    const sentences = align(words, seen, info);
    return {
        engine: 'browser',
        language: lang,
        duration: Math.round(duration * 1000) / 1000,
        source,
        createdAt: new Date().toISOString(),
        text: sentences.map(s => s.text).join(' '),
        sentences,
        blob,
    };
}

function download(id, content, type, name) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    stt.urls.push(url);
    $(id).href = url;
    $(id).download = name;
}

function showSttResult(r) {
    stt.urls.forEach(URL.revokeObjectURL);
    stt.urls = [];
    stt.result = r;
    const base = (r.source.name || 'micro').replace(/\.[^.]+$/, '') || 'transcription';
    const { blob, ...json } = r;
    download('#sttDlSrt', toSrt(r), 'application/x-subrip', `${base}.srt`);
    download('#sttDlVtt', toVtt(r), 'text/vtt', `${base}.vtt`);
    download('#sttDlTxt', toTxt(r), 'text/plain', `${base}.txt`);
    download('#sttDlJson', JSON.stringify(json, null, 2), 'application/json', `${base}.json`);

    const audioUrl = URL.createObjectURL(blob);
    stt.urls.push(audioUrl);
    $('#sttAudio').src = audioUrl;

    const nWords = r.sentences.reduce((n, s) => n + s.words.length, 0);
    $('#sttInfo').textContent = [fmtTime(r.duration), STT_LANGS.find(l => l[0] === r.language)?.[1] || r.language,
        `${r.sentences.length} phrase${r.sentences.length > 1 ? 's' : ''}`, `${nWords} mots`].join(' · ');

    const box = $('#sttSentences');
    box.innerHTML = '';
    for (const s of r.sentences) {
        const row = document.createElement('div');
        row.className = 'stt-sentence';
        row.dataset.i = s.id;
        const time = document.createElement('button');
        time.className = 'stt-time';
        time.textContent = clockLabel(s.start);
        time.title = `${clockLabel(s.start)} → ${clockLabel(s.end)}`;
        time.onclick = () => seek(s.start);
        const p = document.createElement('p');
        s.words.forEach((w, j) => {
            const span = document.createElement('span');
            span.textContent = w.word;
            span.title = `${clockLabel(w.start)} → ${clockLabel(w.end)}`;
            span.onclick = () => seek(w.start);
            p.append(span, j < s.words.length - 1 ? ' ' : '');
        });
        row.append(time, p);
        box.append(row);
    }
    $('#sttResult').hidden = false;
    $('#sttResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function seek(t) {
    const a = $('#sttAudio');
    a.currentTime = t + 0.01;
    a.play().catch(() => {});
}

let sttActive = '';
function syncStt() {
    const r = stt.result;
    if (!r) return;
    const t = $('#sttAudio').currentTime;
    const si = r.sentences.findIndex(s => t >= s.start && t < s.end + 0.15);
    const wi = si < 0 ? -1 : r.sentences[si].words.findIndex(w => t >= w.start && t < w.end + 0.05);
    const key = `${si}:${wi}`;
    if (key === sttActive) return;
    sttActive = key;
    $$('#sttSentences .stt-sentence').forEach((row, i) => {
        row.classList.toggle('current', i === si);
        row.classList.toggle('past', r.sentences[i].end <= t);
        row.querySelectorAll('p span').forEach((sp, j) => {
            sp.classList.toggle('current', i === si && j === wi);
        });
    });
    const row = $(`#sttSentences .stt-sentence[data-i="${si}"]`);
    if (row && $('#sttFollow').checked) {
        const box = $('#sttSentences');
        const top = row.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 60) box.scrollTo({ top: top - 40, behavior: 'smooth' });
    }
}
function sttTick() {
    syncStt();
    if (!$('#sttAudio').paused) requestAnimationFrame(sttTick);
}

// ==================== DICTÉE DANS LE STUDIO ====================

function initDictation() {
    const btn = $('#dictateBtn');
    if (!SR) return;
    btn.hidden = false;
    let session = null;
    btn.onclick = async () => {
        if (session) return session.stop();
        const ta = textarea();
        const before = ta.value.slice(0, ta.selectionStart);
        const after = ta.value.slice(ta.selectionEnd);
        const sep = before && !/\s$/.test(before) ? ' ' : '';
        btn.classList.add('recording');
        btn.querySelector('span').textContent = 'Arrêter';
        const t0 = performance.now();
        session = recognize({
            lang: store.get('sttLang', 'fr-FR'),
            clock: () => (performance.now() - t0) / 1000,
            onUpdate: ({ final, interim }) => {
                const text = [final, interim].filter(Boolean).join(' ');
                ta.value = before + sep + text + after;
                ta.selectionStart = ta.selectionEnd = (before + sep + text).length;
                onTextChange();
            },
        });
        const { words, error } = await session.finished;
        if (error && !words.length) toast(SR_ERRORS[error] || `Dictée : ${error}`);
        ta.value = before + sep + words.join(' ') + after;
        onTextChange();
        session = null;
        btn.classList.remove('recording');
        btn.querySelector('span').textContent = 'Dicter';
    };
}

// ==================== INITIALISATION ====================

function initStt() {
    const lang = $('#sttLang');
    const saved = store.get('sttLang', null);
    const nav = STT_LANGS.find(([code]) => code === navigator.language)?.[0];
    lang.innerHTML = STT_LANGS.map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
    lang.value = saved || nav || 'fr-FR';
    $('#sttListen').checked = store.get('sttListen', false);

    if (!SR) {
        $('#sttUnsupported').hidden = false;
    } else if (!SR_TRACK) {
        $('#sttUnsupported').hidden = false;
        $('#sttUnsupported').textContent = 'Votre navigateur ne sait transcrire que le micro. Pour transcrire un fichier, utilisez une version récente de Chrome.';
    }

    $$('#sttMode button').forEach(b => b.onclick = () => setMode(b.dataset.v));
    $('#sttFile').onchange = e => pickFile(e.target.files[0]);
    const dz = $('#sttDrop');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); pickFile(e.dataTransfer.files[0]); });

    $('#sttStart').onclick = start;
    $('#sttStop').onclick = () => stt.stop?.();
    $('#sttMicBox').onclick = () => stt.running ? stt.stop?.() : start();
    const audio = $('#sttAudio');
    audio.addEventListener('play', () => requestAnimationFrame(sttTick));
    audio.addEventListener('seeked', syncStt);
    $('#sttCopy').onclick = () => stt.result && navigator.clipboard.writeText(toTxt(stt.result)).then(() => toast('Texte copié'));
    $('#sttToStudio').onclick = () => {
        if (!stt.result) return;
        textarea().value = stt.result.sentences.map(s => s.text).join(' ');
        onTextChange();
        $('.tab[data-tab="studio"]').click();
        toast('Texte envoyé dans le Studio');
    };

    setMode(SR && !SR_TRACK ? 'mic' : 'file');
    initDictation();
}

initStt();
