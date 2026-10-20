/**
 * Préparation du texte : nettoyage, balises de contrôle, découpage en requêtes ≤ 200 caractères.
 *
 * Balises supportées dans le texte (si markup activé) :
 *   [pause]  [pause 800ms]  [pause 2s]   → silence explicite (défaut 1s)
 *   [voice en-US] ... [voice]           → change de voix jusqu'à la balise suivante / reset
 *   [slow] ... [/slow]                  → mode lent natif de Google
 * Une ligne vide sépare deux paragraphes (pause de paragraphe).
 */

const MAX_CHARS = 200; // défaut : limite dure de Google (HTTP 400 au-delà) ; chaque voix peut définir maxChars

const TAG_RE = /\[(pause|voice|slow|\/slow)(?:[\s:=]+([^\]]*))?\]/gi;

/** Retire le formatage markdown, les URLs et les emojis (utile pour lire une sortie de LLM). */
function cleanText(text) {
    return text
        .replace(/```[\s\S]*?```/g, ' ')                 // blocs de code
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')         // images
        .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1') // liens
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '') // titres, citations, listes
        .replace(/(\*\*|__|\*|_|~~)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
        .replace(/^\s*([-*_]\s*){3,}$/gm, '')             // séparateurs horizontaux
        .replace(/\p{Extended_Pictographic}️?/gu, '')
        .replace(/[ \t]+/g, ' ');
}

function parseDuration(arg) {
    if (!arg) return 1000;
    const m = String(arg).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
    if (!m) return 1000;
    const ms = m[2]?.toLowerCase() === 'ms' ? +m[1] : (m[2] ? +m[1] * 1000 : (+m[1] > 20 ? +m[1] : +m[1] * 1000));
    return Math.min(Math.round(ms), 10000);
}

/**
 * Transforme le texte en suite de blocs :
 *   { type: 'text', text, voice, slow }  |  { type: 'pause', ms }  |  { type: 'paragraph' }
 */
function parseMarkup(text, { voice, slow = false, markup = true, resolveVoice }) {
    const blocks = [];
    let state = { voice, slow };

    const pushText = (raw) => {
        const paras = raw.split(/\n\s*\n/);
        paras.forEach((p, i) => {
            if (i > 0) blocks.push({ type: 'paragraph' });
            const t = p.replace(/\s+/g, ' ').trim();
            if (t) blocks.push({ type: 'text', text: t, voice: state.voice, slow: state.slow });
        });
    };

    if (!markup) { pushText(text); return blocks; }

    let last = 0;
    for (const m of text.matchAll(TAG_RE)) {
        pushText(text.slice(last, m.index));
        last = m.index + m[0].length;
        const [tag, arg] = [m[1].toLowerCase(), (m[2] || '').trim()];
        if (tag === 'pause') blocks.push({ type: 'pause', ms: parseDuration(arg) });
        else if (tag === 'slow') state = { ...state, slow: true };
        else if (tag === '/slow') state = { ...state, slow };
        else if (tag === 'voice') {
            if (!arg) state = { ...state, voice };
            else {
                const v = resolveVoice(arg);
                if (!v) throw Object.assign(new Error(`Voix inconnue dans la balise [voice ${arg}]`), { status: 400, code: 'invalid_voice' });
                state = { ...state, voice: v };
            }
        }
    }
    pushText(text.slice(last));
    return blocks;
}

const sentenceSegmenters = new Map();
function sentences(text, lang) {
    if (!sentenceSegmenters.has(lang)) {
        let seg;
        try { seg = new Intl.Segmenter(lang, { granularity: 'sentence' }); }
        catch { seg = new Intl.Segmenter('en', { granularity: 'sentence' }); }
        sentenceSegmenters.set(lang, seg);
    }
    return [...sentenceSegmenters.get(lang).segment(text)].map(s => s.segment.trim()).filter(Boolean);
}

const CLAUSE_MARKS = [',', ';', ':', '—', '–', '，', '、', '；', '：', ')'];

/**
 * Coupe une phrase trop longue en morceaux de taille équilibrée :
 * d'abord aux ponctuations faibles, puis aux espaces, puis en dur (CJK, mot géant).
 */
function splitLong(sentence, max) {
    const out = [];
    let rest = sentence;
    while (rest.length > max) {
        const target = Math.ceil(rest.length / Math.ceil(rest.length / max));
        const soft = Math.min(max, Math.round(target * 1.15));
        let cut, boundary = 'word';
        const clause = Math.max(...CLAUSE_MARKS.map(p => rest.lastIndexOf(p, soft - 1)));
        const space = rest.lastIndexOf(' ', soft);
        if (clause > target * 0.5) { cut = clause + 1; boundary = 'clause'; }
        else if (space > target * 0.5) cut = space + 1;
        else if (rest.lastIndexOf(' ', max) > max * 0.3) cut = rest.lastIndexOf(' ', max) + 1;
        else cut = target;
        out.push({ text: rest.slice(0, cut).trim(), boundary });
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push({ text: rest, boundary: 'sentence' });
    return out;
}

/**
 * Regroupe les phrases en morceaux ≤ max caractères (moins de requêtes, prosodie plus naturelle).
 * Chaque morceau indique le type de frontière qui le termine : sentence | clause | word.
 */
function chunkText(text, lang, max = MAX_CHARS) {
    const chunks = [];
    let buf = '';
    const flush = () => { if (buf) chunks.push({ text: buf, boundary: 'sentence' }); buf = ''; };

    for (const s of sentences(text, lang)) {
        if (s.length > max) { flush(); chunks.push(...splitLong(s, max)); continue; }
        if (buf && buf.length + 1 + s.length > max) flush();
        buf = buf ? `${buf} ${s}` : s;
    }
    flush();
    return chunks;
}

/**
 * Construit la liste ordonnée des requêtes à faire, avec le silence à insérer après chacune
 * (et `leading`, le silence avant la première).
 * pauses: { sentence, paragraph, clause, word } en ms.
 */
function buildPlan(blocks, pauses, max = MAX_CHARS) {
    const items = [];
    let pendingGap = 0, leading = 0;
    for (const b of blocks) {
        if (b.type === 'pause') { pendingGap += b.ms; continue; }
        if (b.type === 'paragraph') { pendingGap = Math.max(pendingGap, pauses.paragraph); continue; }
        if (items.length) items[items.length - 1].gapAfter += pendingGap;
        else leading = pendingGap;
        pendingGap = 0;
        for (const c of chunkText(b.text, b.voice.language, b.voice.maxChars || max)) {
            items.push({ text: c.text, voice: b.voice, slow: b.slow, gapAfter: pauses[c.boundary] ?? 0 });
        }
    }
    if (items.length) items[items.length - 1].gapAfter = pendingGap;
    return { items, leading };
}

module.exports = { MAX_CHARS, cleanText, parseMarkup, chunkText, buildPlan };
