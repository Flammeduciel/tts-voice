/* TTS Voice Studio — playground de l'API v1 (vanilla JS ; icônes Lucide chargées depuis un CDN). */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(`tts.${key}`)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`tts.${key}`, JSON.stringify(value)); } catch {} },
};

// Voix par défaut de chaque moteur ; Edge est le moteur par défaut du playground
const ENGINE_DEFAULT_VOICE = { edge: 'fr-FR-HenriNeural', google: 'fr-FR' };
const DEFAULTS = {
    voice: ENGINE_DEFAULT_VOICE.edge, speed: 1, pitch: 0, volume: 0, normalize: false, slow: false,
    sentencePause: 350, paragraphPause: 800, cleanup: false, markup: true, format: 'mp3', sampleRate: 24000,
};
const SETTING_IDS = Object.keys(DEFAULTS);
const QUICK_VOICES = {
    edge: ['fr-FR-HenriNeural', 'fr-FR-DeniseNeural', 'fr-FR-RemyMultilingualNeural', 'fr-FR-VivienneMultilingualNeural',
        'fr-CA-JeanNeural', 'fr-CA-SylvieNeural', 'fr-BE-GerardNeural', 'fr-CH-ArianeNeural'],
    google: ['fr-FR', 'fr-CA', 'en-US', 'en-GB', 'es-ES', 'de-DE', 'it-IT', 'ja'],
};
const ENGINE_LABEL = { edge: 'Edge', google: 'Google' };
const GENDER = { male: { icon: 'mars', label: 'Homme' }, female: { icon: 'venus', label: 'Femme' } };

/** Crée un élément icône Lucide (converti en SVG par refreshIcons). */
function icon(name, cls = '') {
    const i = document.createElement('i');
    i.dataset.lucide = name;
    if (cls) i.className = cls;
    return i;
}
const refreshIcons = () => window.lucide?.createIcons();

const PREVIEW_TEXT = {
    fr: 'Bonjour ! Voici un aperçu de cette voix.', en: 'Hello! This is a preview of this voice.',
    es: '¡Hola! Esta es una muestra de esta voz.', pt: 'Olá! Esta é uma amostra desta voz.',
    de: 'Hallo! Das ist eine Hörprobe dieser Stimme.', it: 'Ciao! Questa è un\'anteprima di questa voce.',
    nl: 'Hallo! Dit is een voorbeeld van deze stem.', ja: 'こんにちは。これはこの声のサンプルです。',
    zh: '你好！这是这个声音的试听。', yue: '你好！呢個係呢把聲嘅試聽。', ko: '안녕하세요! 이 목소리의 미리 듣기입니다.',
    ru: 'Привет! Это пример этого голоса.', ar: 'مرحبا! هذه عينة من هذا الصوت.', hi: 'नमस्ते! यह इस आवाज़ का नमूना है।',
    tr: 'Merhaba! Bu sesin bir önizlemesidir.', pl: 'Cześć! To jest próbka tego głosu.',
};

const SAMPLES = {
    intro: 'Bonjour et bienvenue ! Ce studio transforme n\'importe quel texte en voix, gratuitement.\n\n'
        + 'Vous pouvez régler la vitesse, la hauteur et le volume, ajouter des pauses [pause 800ms] où vous voulez, '
        + 'et même [slow]ralentir un passage important[/slow]. Bonne écoute !',
    // Un dialogue par moteur : chaque exemple n'utilise que des voix du moteur sélectionné
    dialogue: {
        edge: '[voice fr-FR-HenriNeural]Bonjour, je m\'appelle Henri, et je vous présente ce petit studio.[voice]\n\n'
            + '[voice fr-FR-DeniseNeural]Et moi c\'est Denise ! On peut faire dialoguer plusieurs voix dans un même texte.[voice]\n\n'
            + '[voice fr-CA-JeanNeural]Salut, moi c\'est Jean, je viens du Québec ! Comment ça va aujourd\'hui ?[voice]\n\n'
            + '[voice fr-FR-HenriNeural]Très bien, merci. On demande à nos amis anglophones ?[voice]\n\n'
            + '[voice en-US-AndrewNeural]Hi there! I\'m Andrew, from the United States.[voice]\n\n'
            + '[pause 500ms][voice fr-FR-DeniseNeural]Merci à tous ![voice]',
        google: 'Bonjour, je suis la voix française de Google.\n\n[voice fr-CA]Et moi, je viens du Québec ! Comment ça va aujourd\'hui ?[voice]\n\n'
            + 'Très bien, merci. On demande à nos amis ?\n\n[voice en-US]Hi there! I speak American English.[voice]\n\n'
            + '[voice en-GB]And I\'m from London, lovely to meet you.[voice]\n\n[voice es-ES]¡Y yo hablo español![voice]\n\n[pause 500ms]Merci à tous !',
    },
    story: 'Chapitre 1\n\nIl était une fois, dans un royaume lointain, un jeune programmeur nommé Alex. '
        + 'Chaque jour, il écrivait du code pour donner vie à ses idées. Un matin, il découvrit une ancienne bibliothèque oubliée au fond d\'un dépôt.\n\n'
        + 'Chapitre 2\n\nLa bibliothèque contenait des sorts puissants : la synthèse vocale, la reconnaissance d\'images, '
        + 'la compréhension du langage naturel. Alex décida de les étudier, un par un.',
    markdown: '## Résumé ✨\n\nVoici les **trois points clés** à retenir :\n\n1. Le serveur est *gratuit* et tourne en local.\n'
        + '2. Il découpe automatiquement les textes longs (voir [la doc](https://example.com/docs)).\n3. Les sous-titres sont générés 🎉\n\n'
        + '> Astuce : activez « Nettoyer markdown » pour une lecture propre.',
};

let voices = [];
let currentJob = null;
let current = null;    // métadonnées du rendu affiché
let activeSeg = -1;

// ==================== UTILITAIRES ====================

function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function showError(msg) {
    const e = $('#error');
    e.textContent = msg; e.hidden = !msg;
}

// Clé d'API facultative (limite plus haute) : en-tête pour fetch, paramètre ?key= pour <audio> et EventSource
const apiKey = () => store.get('apiKey', '');
const withKey = url => apiKey() ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey())}` : url;

async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (apiKey()) headers.Authorization = `Bearer ${apiKey()}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
        $('#keyCard').hidden = false;
        $('#apiKey').focus();
    }
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return data;
}

function initApiKey(health) {
    // Sans clé le playground fonctionne quand même, avec la limite « anonyme » du serveur
    $('#keyCard').hidden = !health.auth;
    const anon = health.anonymousRateLimitPerMinute;
    $('#keyInfo').textContent = `Facultatif. Sans clé : ${anon ? `${anon} synthèses/min` : 'pas de limite'} ; une clé d'API augmente la limite.`;
    $('#apiKey').value = apiKey();
    const save = () => {
        store.set('apiKey', $('#apiKey').value.trim());
        toast('Clé enregistrée');
        updatePlan();
    };
    $('#saveKey').onclick = save;
    $('#apiKey').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
}

const fmtTime = s => {
    s = Math.max(0, Math.round(s));
    return s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.round(b / 1024)} Ko`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ==================== RÉGLAGES ====================

function readSettings() {
    const s = {};
    for (const id of SETTING_IDS) {
        const el = $(`#${id}`);
        s[id] = el.type === 'checkbox' ? el.checked : (typeof DEFAULTS[id] === 'number' ? Number(el.value) : el.value);
    }
    return s;
}

function applySettings(s) {
    for (const id of SETTING_IDS) {
        const el = $(`#${id}`);
        if (s[id] === undefined || !el) continue;
        if (id === 'voice' && voiceOf(s[id])?.engine !== voiceFilters.engine) continue; // jamais une voix de l'autre moteur
        if (el.type === 'checkbox') el.checked = !!s[id]; else el.value = s[id];
    }
    refreshLabels();
}

/** Uniquement les paramètres qui diffèrent des valeurs par défaut (requêtes et extraits de code lisibles). */
function changedSettings() {
    const s = readSettings();
    return Object.fromEntries(Object.entries(s).filter(([k, v]) => v !== DEFAULTS[k] || k === 'voice'));
}

function refreshLabels() {
    const s = readSettings();
    $('#speedVal').textContent = `${s.speed.toFixed(2)}×`;
    $('#pitchVal').textContent = `${s.pitch > 0 ? '+' : ''}${s.pitch} demi-ton${Math.abs(s.pitch) > 1 ? 's' : ''}`;
    $('#volumeVal').textContent = `${s.volume > 0 ? '+' : ''}${s.volume} dB`;
    $('#sentencePauseVal').textContent = `${s.sentencePause} ms`;
    $('#paragraphPauseVal').textContent = `${s.paragraphPause} ms`;
    $$('#quickVoices button').forEach(b => b.classList.toggle('on', b.dataset.voice === s.voice));
    renderVoiceInfo();
}

function onSettingsChange() {
    refreshLabels();
    rememberVoice();
    store.set('settings', readSettings());
    updatePlan();
    renderCode();
}

// ==================== VOIX ====================

const voiceText = v => [v.label, GENDER[v.gender]?.label].filter(Boolean).join(' · ');
const languageName = (() => {
    const names = new Intl.DisplayNames(['fr'], { type: 'language' });
    return code => { try { const n = names.of(code); return n.charAt(0).toUpperCase() + n.slice(1); } catch { return code; } };
})();

/** Remplit un <select> avec les voix groupées par langue (français en premier). */
function fillVoiceSelect(select, list, keepFirst) {
    const first = keepFirst ? select.options[0] : null;
    select.innerHTML = '';
    if (first) select.append(first);
    const byLang = new Map();
    for (const v of list) {
        if (!byLang.has(v.language)) byLang.set(v.language, []);
        byLang.get(v.language).push(v);
    }
    const groups = [...byLang.entries()]
        .map(([lang, items]) => ({ lang, name: languageName(lang), items }))
        .sort((a, b) => (b.lang === 'fr') - (a.lang === 'fr') || a.name.localeCompare(b.name, 'fr'));
    for (const g of groups) {
        const og = document.createElement('optgroup');
        og.label = g.name;
        for (const v of g.items.sort((a, b) => a.label.localeCompare(b.label, 'fr'))) og.append(new Option(voiceText(v), v.id));
        select.append(og);
    }
}

// Moteur sélectionné (exclusif) et filtre de genre ; la dernière voix choisie est mémorisée par moteur
const voiceFilters = { engine: 'edge', gender: '' };
const voiceOf = id => voices.find(v => v.id === id);
const engineVoices = () => voices.filter(v => v.engine === voiceFilters.engine);

function setEngine(engine, { keepVoice = false } = {}) {
    voiceFilters.engine = engine;
    store.set('engine', engine);
    $$('#engineFilter button').forEach(b => {
        const on = b.dataset.v === engine;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on);
    });
    // Le genre n'est connu que pour les voix Edge
    $('#genderFilter').hidden = engine !== 'edge';
    if (engine !== 'edge') voiceFilters.gender = '';

    const select = $('#voice');
    if (!keepVoice || voiceOf(select.value)?.engine !== engine) {
        const remembered = store.get('voiceByEngine', {})[engine];
        select.dataset.pending = [remembered, ENGINE_DEFAULT_VOICE[engine], engineVoices()[0]?.id]
            .find(id => voiceOf(id)?.engine === engine) || '';
    }
    renderVoiceSelect();
    fillVoiceSelect($('#insertVoice'), engineVoices(), true);
    renderQuickVoices();
}

function renderVoiceSelect() {
    const select = $('#voice');
    const currentId = select.dataset.pending || select.value;
    delete select.dataset.pending;
    const list = engineVoices().filter(v => !voiceFilters.gender || v.gender === voiceFilters.gender);
    const cur = voiceOf(currentId);
    if (cur && cur.engine === voiceFilters.engine && !list.includes(cur)) list.unshift(cur); // le filtre de genre ne retire pas la voix choisie
    fillVoiceSelect(select, list, false);
    select.value = cur?.engine === voiceFilters.engine ? currentId : (list[0]?.id || '');
    refreshLabels();
}

function renderVoiceInfo() {
    const v = voiceOf($('#voice').value);
    const info = $('#voiceInfo');
    info.innerHTML = '';
    if (!v) return;
    const badge = (cls, txt, ic) => {
        const b = document.createElement('span');
        b.className = `badge ${cls}`;
        if (ic) b.append(icon(ic));
        b.append(txt);
        return b;
    };
    info.append(badge(v.engine, ENGINE_LABEL[v.engine] || v.engine, v.engine === 'edge' ? 'sparkles' : 'languages'));
    if (GENDER[v.gender]) info.append(badge('neutral', GENDER[v.gender].label, GENDER[v.gender].icon));
    if (v.multilingual) info.append(badge('neutral', 'Multilingue', 'globe'));
    const id = document.createElement('code'); id.textContent = v.id; info.append(id);
    refreshIcons();
}

function renderQuickVoices() {
    const box = $('#quickVoices');
    box.innerHTML = '';
    for (const id of QUICK_VOICES[voiceFilters.engine] || []) {
        const v = voiceOf(id);
        if (!v) continue;
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.voice = id; b.title = voiceText(v);
        if (GENDER[v.gender]) b.append(icon(GENDER[v.gender].icon));
        b.append(v.engine === 'edge' ? v.name : id);
        if (v.engine === 'edge' && v.locale !== 'fr-FR') { const r = document.createElement('small'); r.textContent = v.locale.split('-')[1]; b.append(r); }
        b.onclick = () => {
            if (voiceFilters.gender && v.gender !== voiceFilters.gender) setGender('');
            $('#voice').value = id;
            onSettingsChange();
        };
        box.append(b);
    }
    refreshLabels();
    refreshIcons();
}

function setGender(gender) {
    voiceFilters.gender = gender;
    $$('#genderFilter button').forEach(x => x.classList.toggle('on', x.dataset.v === gender));
    renderVoiceSelect();
}

async function loadVoices() {
    const data = await api('/v1/voices');
    voices = data.voices;
    const edgeOk = !!data.engines?.edge?.available;
    $('#engineFilter').hidden = !edgeOk;

    $$('#engineFilter button').forEach(b => b.onclick = () => setEngine(b.dataset.v));
    $$('#genderFilter button').forEach(b => b.onclick = () => setGender(b.dataset.v));

    // Moteur initial : celui de la voix enregistrée, sinon Edge (par défaut), sinon Google
    const saved = voiceOf(store.get('settings', {}).voice);
    const engine = !edgeOk ? 'google' : (saved?.engine || store.get('engine', 'edge'));
    $('#voice').dataset.pending = saved?.engine === engine ? saved.id : '';
    setEngine(engine, { keepVoice: !!$('#voice').dataset.pending });
    return data;
}

function rememberVoice() {
    const v = voiceOf($('#voice').value);
    if (!v) return;
    const map = store.get('voiceByEngine', {});
    map[v.engine] = v.id;
    store.set('voiceByEngine', map);
}

function setPreviewIcon(name, spin = false) {
    const btn = $('#previewBtn');
    btn.innerHTML = '';
    btn.append(icon(name, spin ? 'spin' : ''));
    refreshIcons();
}

function previewVoice() {
    const s = readSettings();
    const voice = voiceOf(s.voice);
    const sample = PREVIEW_TEXT[voice?.language] || $('#text').value.trim().slice(0, 140) || voice?.label || 'Test';
    const params = new URLSearchParams({ text: sample, voice: s.voice, speed: s.speed, pitch: s.pitch });
    const a = new Audio(withKey(`/v1/speech?${params}`));
    setPreviewIcon('loader-circle', true);
    a.play().catch(e => { setPreviewIcon('play'); showError(`Aperçu impossible : ${e.message}`); });
    a.onplaying = () => setPreviewIcon('square');
    a.onended = a.onerror = () => { setPreviewIcon('play'); $('#previewBtn').onclick = previewVoice; };
    $('#previewBtn').onclick = () => { a.pause(); setPreviewIcon('play'); $('#previewBtn').onclick = previewVoice; };
}

// ==================== ÉDITEUR ====================

const textarea = () => $('#text');

function insertAround(before, after = '') {
    const ta = textarea();
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const selected = value.slice(a, b);
    ta.setRangeText(before + selected + after, a, b, 'end');
    if (!selected && after) ta.setSelectionRange(a + before.length, a + before.length);
    ta.focus();
    onTextChange();
}

function onTextChange() {
    const t = textarea().value;
    const words = (t.match(/\S+/g) || []).length;
    $('#stats').textContent = `${t.length.toLocaleString('fr')} caractère${t.length > 1 ? 's' : ''} · ${words.toLocaleString('fr')} mot${words > 1 ? 's' : ''}`;
    store.set('text', t);
    updatePlan();
    renderCode();
}

const updatePlan = debounce(async () => {
    const text = textarea().value;
    if (!text.trim()) { $('#planInfo').textContent = ''; return; }
    try {
        const p = await api('/v1/plan', { method: 'POST', body: { text, ...changedSettings() } });
        $('#planInfo').textContent = `${p.requests} requête${p.requests > 1 ? 's' : ''} · durée estimée ≈ ${fmtTime(p.estimatedDuration)}`;
    } catch (e) {
        $('#planInfo').textContent = `Erreur : ${e.message}`;
    }
}, 350);

function loadFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return showError('Fichier trop volumineux (2 Mo max)');
    file.text().then(t => { textarea().value = t; onTextChange(); toast(`« ${file.name} » chargé`); });
}

// ==================== GÉNÉRATION ====================

function setBusy(busy) {
    $('#generateBtn').disabled = busy;
    $('#generateBtn span').textContent = busy ? 'Génération…' : 'Générer';
    $('#cancelBtn').hidden = !busy;
    $('#progress').hidden = !busy;
}

function setProgress(done, total) {
    const pct = total ? Math.round(done / total * 100) : 0;
    $('#progressBar').style.width = `${pct}%`;
    $('#progressText').textContent = `${done} / ${total} segments`;
}

async function generate() {
    const text = textarea().value;
    if (!text.trim()) { textarea().focus(); return showError('Le texte est vide.'); }
    if (currentJob) return;
    showError('');
    setBusy(true); setProgress(0, 0);
    try {
        const job = await api('/v1/jobs', { method: 'POST', body: { text, ...changedSettings() } });
        currentJob = job.id;
        setProgress(job.progress.done, job.progress.total);
        const result = await new Promise((resolve, reject) => {
            const es = new EventSource(withKey(job.links.events));
            es.addEventListener('progress', e => { const j = JSON.parse(e.data); setProgress(j.progress.done, j.progress.total); });
            es.addEventListener('done', e => { es.close(); resolve(JSON.parse(e.data).result); });
            es.addEventListener('error', e => {
                es.close();
                if (e.data) reject(new Error(JSON.parse(e.data).error?.message || 'Échec de la génération'));
                else reject(new Error('Connexion au serveur perdue'));
            });
            es.addEventListener('cancelled', () => { es.close(); reject(new Error('Génération annulée')); });
        });
        const meta = await api(`/v1/audio/${result.audioId}/meta`);
        showResult(meta, true);
        addHistory(meta, text);
    } catch (e) {
        showError(e.message);
    } finally {
        currentJob = null;
        setBusy(false);
    }
}

async function cancel() {
    if (!currentJob) return;
    await api(`/v1/jobs/${currentJob}`, { method: 'DELETE' }).catch(() => {});
}

// ==================== LECTEUR + TRANSCRIPTION ====================

function showResult(meta, autoplay) {
    current = meta;
    activeSeg = -1;
    const audio = $('#audio');
    audio.src = meta.audioUrl;
    audio.playbackRate = Number($('#playbackRate .on')?.dataset.rate || 1);
    $('#playerCard').hidden = false;
    const o = meta.options || {};
    $('#resultInfo').textContent = [
        fmtTime(meta.duration), meta.format.toUpperCase(), fmtSize(meta.size), `voix ${o.voice}`,
        o.speed !== 1 ? `${o.speed}×` : null, o.pitch ? `${o.pitch > 0 ? '+' : ''}${o.pitch} dt` : null,
        `${meta.requests} requête${meta.requests > 1 ? 's' : ''}`, meta.cached ? 'depuis le cache' : null,
    ].filter(Boolean).join(' · ');

    $('#dlAudio').href = `${meta.audioUrl}?download=1`;
    $('#dlSrt').href = meta.subtitles.srt;
    $('#dlVtt').href = meta.subtitles.vtt;
    $('#dlSrt').download = `speech-${meta.id}.srt`;
    $('#dlVtt').download = `speech-${meta.id}.vtt`;

    const tr = $('#transcript');
    tr.innerHTML = '';
    let lastVoice = o.voice;
    for (const s of meta.segments) {
        const span = document.createElement('span');
        span.dataset.i = s.index;
        if (s.voice !== lastVoice) {
            const tag = document.createElement('b');
            tag.className = 'voice-tag';
            const v = voices.find(x => x.id === s.voice);
            tag.textContent = v?.engine === 'edge' ? v.name : s.voice;
            tag.title = v ? voiceText(v) : s.voice;
            span.append(tag);
            lastVoice = s.voice;
        }
        span.append(document.createTextNode(s.text));
        span.title = `${fmtTime(s.start)} → ${fmtTime(s.end)}`;
        span.onclick = () => { audio.currentTime = s.start + 0.01; audio.play(); };
        tr.append(span, ' ');
    }
    if (autoplay) audio.play().catch(() => {});
    $('#playerCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function syncTranscript() {
    if (!current) return;
    const t = $('#audio').currentTime;
    const segs = current.segments;
    let i = segs.findIndex(s => t >= s.start && t < s.end);
    if (i === -1) i = segs.findLastIndex(s => t >= s.end); // dans une pause : garder le précédent
    if (i === activeSeg) return;
    activeSeg = i;
    $$('#transcript span').forEach((el, idx) => {
        el.classList.toggle('current', idx === i && t < segs[idx].end);
        el.classList.toggle('past', idx < i || (idx === i && t >= segs[idx].end));
    });
    const el = $(`#transcript span[data-i="${i}"]`);
    if (el && $('#followToggle').checked) {
        const box = $('#transcript');
        const top = el.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) box.scrollTo({ top: top - 40, behavior: 'smooth' });
    }
}

function tick() {
    syncTranscript();
    if (!$('#audio').paused) requestAnimationFrame(tick);
}

// ==================== HISTORIQUE ====================

function addHistory(meta, text) {
    const list = store.get('history', []).filter(h => h.id !== meta.id);
    list.unshift({ id: meta.id, excerpt: text.trim().slice(0, 80), voice: meta.options?.voice, duration: meta.duration, format: meta.format, at: Date.now() });
    store.set('history', list.slice(0, 15));
    renderHistory();
}

function renderHistory() {
    const list = store.get('history', []);
    const ul = $('#history');
    ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="muted">Rien pour l\'instant.</li>'; return; }
    for (const h of list) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        const t = document.createElement('span'); t.className = 't'; t.textContent = h.excerpt;
        const small = document.createElement('small');
        small.textContent = `${h.voice} · ${fmtTime(h.duration)} · ${h.format} · ${new Date(h.at).toLocaleString('fr', { dateStyle: 'short', timeStyle: 'short' })}`;
        b.append(t, small);
        b.onclick = async () => {
            try { showResult(await api(`/v1/audio/${h.id}/meta`), true); }
            catch { toast('Audio expiré du cache'); store.set('history', list.filter(x => x.id !== h.id)); renderHistory(); }
        };
        li.append(b); ul.append(li);
    }
}

// ==================== ONGLET API ====================

let codeLang = 'curl';

function renderCode() {
    const origin = location.origin;
    const text = textarea().value.trim() || 'Bonjour !';
    const short = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    const body = { text: short, ...changedSettings() };
    const ext = body.format || 'mp3';
    const json = JSON.stringify(body, null, 2);
    const q = new URLSearchParams({ ...body, text: short.slice(0, 120) });
    const snippets = {
        curl: `# Audio direct
curl -X POST ${origin}/v1/speech \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}' \\
  -o speech.${ext}

# Un fichier texte entier (options en query string)
curl -X POST '${origin}/v1/speech?voice=${body.voice}' \\
  -H 'Content-Type: text/plain' --data-binary @mon-texte.txt -o livre.${ext}

# JSON avec minutage des segments (sous-titres)
curl -X POST '${origin}/v1/speech?response=json' -H 'Content-Type: application/json' -d '{"text":"Bonjour"}'`,
        js: `const res = await fetch('${origin}/v1/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(${json.replace(/\n/g, '\n  ')}),
});
if (!res.ok) throw new Error((await res.json()).error.message);
const blob = await res.blob();
new Audio(URL.createObjectURL(blob)).play();

// Textes longs : job + progression en direct
const job = await (await fetch('${origin}/v1/jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: longText, voice: '${body.voice}' }),
})).json();
const es = new EventSource('${origin}' + job.links.events);
es.addEventListener('progress', e => console.log(JSON.parse(e.data).progress));
es.addEventListener('done', e => {
  es.close();
  const { result } = JSON.parse(e.data);
  new Audio('${origin}' + result.audioUrl).play();
});`,
        python: `import requests

payload = ${json.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False')}
r = requests.post("${origin}/v1/speech", json=payload, timeout=600)
r.raise_for_status()
with open("speech.${ext}", "wb") as f:
    f.write(r.content)
print("Durée :", r.headers["X-Audio-Duration"], "s")

# Minutage des segments + lien audio
meta = requests.post("${origin}/v1/speech", json={**payload, "response": "json"}).json()
for s in meta["segments"]:
    print(f'{s["start"]:7.2f}s  {s["text"]}')`,
        html: `<!-- Lecture directe dans une page web -->
<audio controls src="${origin}/v1/speech?${q}"></audio>

<!-- Sous-titres synchronisés -->
<video controls>
  <source src="${origin}/v1/audio/${current?.id || 'AUDIO_ID'}">
  <track default kind="captions" src="${origin}/v1/audio/${current?.id || 'AUDIO_ID'}/subtitles.vtt">
</video>`,
    };
    $('#code').textContent = snippets[codeLang];
}

async function renderParams() {
    try {
        const spec = await api('/openapi.json');
        const props = spec.components.schemas.SpeechRequest.properties;
        const tbody = $('#paramsTable');
        tbody.innerHTML = '';
        for (const [name, p] of Object.entries(props)) {
            const tr = document.createElement('tr');
            const type = p.enum && p.enum.length <= 6 ? p.enum.join(' | ') : (p.type + (p.minimum !== undefined ? ` [${p.minimum}–${p.maximum}]` : ''));
            [[name, true], [type], [p.default !== undefined ? String(p.default) : '—'], [p.description || '']].forEach(([txt, isCode]) => {
                const td = document.createElement('td');
                if (isCode) { const c = document.createElement('code'); c.textContent = txt; td.append(c); } else td.textContent = txt;
                tr.append(td);
            });
            tbody.append(tr);
        }
    } catch {}
}

// ==================== INITIALISATION ====================

function initTheme() {
    const apply = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
    apply(store.get('theme', null));
    $('#themeBtn').onclick = () => {
        const cur = document.documentElement.dataset.theme;
        const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
        const next = (cur || (sysDark ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark';
        apply(next); store.set('theme', next);
    };
}

function initTabs() {
    $$('.tab').forEach(t => t.onclick = () => {
        $$('.tab').forEach(x => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
        $$('.tab-panel').forEach(p => { p.hidden = p.id !== `tab-${t.dataset.tab}`; });
        if (t.dataset.tab === 'api') renderCode();
    });
    $$('#langTabs button').forEach(b => b.onclick = () => {
        $$('#langTabs button').forEach(x => x.classList.toggle('on', x === b));
        codeLang = b.dataset.lang; renderCode();
    });
    $('#copyCode').onclick = () => navigator.clipboard.writeText($('#code').textContent).then(() => toast('Copié'));
}

function initEditor() {
    const ta = textarea();
    ta.value = store.get('text', null) ?? SAMPLES.intro;
    ta.addEventListener('input', onTextChange);

    $$('[data-insert]').forEach(b => b.onclick = () => {
        if (b.dataset.insert === 'pause') insertAround('[pause 1s] ');
        if (b.dataset.insert === 'slow') insertAround('[slow]', '[/slow]');
    });
    $('#insertVoice').onchange = e => {
        if (!e.target.value) return;
        insertAround(`[voice ${e.target.value}]`, '[voice]');
        e.target.value = '';
    };
    $('#samples').onchange = e => {
        if (!e.target.value) return;
        const sample = SAMPLES[e.target.value];
        ta.value = typeof sample === 'string' ? sample : sample[voiceFilters.engine] || sample.google;
        if (e.target.value === 'markdown') $('#cleanup').checked = true;
        e.target.value = '';
        onSettingsChange(); onTextChange();
    };
    $('#clearBtn').onclick = () => { ta.value = ''; onTextChange(); ta.focus(); };
    $('#fileInput').onchange = e => loadFile(e.target.files[0]);

    const dz = $('#dropZone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); loadFile(e.dataTransfer.files[0]); });
}

function initControls() {
    applySettings({ ...DEFAULTS, ...store.get('settings', {}) });
    for (const id of SETTING_IDS) $(`#${id}`).addEventListener(['checkbox'].includes($(`#${id}`).type) || $(`#${id}`).tagName === 'SELECT' ? 'change' : 'input', onSettingsChange);
    $$('[data-set]').forEach(b => b.onclick = () => {
        const [id, v] = b.dataset.set.split(':');
        $(`#${id}`).value = v; onSettingsChange();
    });
    $('#resetBtn').onclick = () => {
        store.set('voiceByEngine', {});
        applySettings({ ...DEFAULTS, voice: undefined });
        setEngine($('#engineFilter').hidden ? 'google' : 'edge');
        onSettingsChange();
        toast('Réglages réinitialisés');
    };
    $('#previewBtn').onclick = previewVoice;
    $('#generateBtn').onclick = generate;
    $('#cancelBtn').onclick = cancel;
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    });

    const audio = $('#audio');
    audio.addEventListener('play', () => requestAnimationFrame(tick));
    audio.addEventListener('seeked', syncTranscript);
    $$('#playbackRate button').forEach(b => b.onclick = () => {
        $$('#playbackRate button').forEach(x => x.classList.toggle('on', x === b));
        audio.playbackRate = Number(b.dataset.rate);
    });
    $('#copyLink').onclick = () => {
        if (!current) return;
        navigator.clipboard.writeText(location.origin + current.audioUrl).then(() => toast('Lien copié'));
    };
}

async function init() {
    refreshIcons();
    initTheme();
    initTabs();
    initEditor();
    try {
        const [health] = await Promise.all([api('/v1/health'), loadVoices()]);
        initApiKey(health);
        const e = health.engines || {};
        $('#serverInfo').textContent = `v${health.version} · ${voices.length} voix (Google ${e.google?.voices ?? '?'} · Edge ${e.edge?.available ? e.edge.voices : 'indisponible'}) · ${health.capabilities.formats.length} formats`
            + (health.ffmpeg ? '' : ' · ffmpeg absent : vitesse/hauteur/formats indisponibles');
        if (!health.ffmpeg) ['speed', 'pitch', 'volume', 'normalize', 'format', 'sampleRate'].forEach(id => { $(`#${id}`).disabled = true; });
    } catch (e) {
        $('#serverInfo').textContent = 'Serveur injoignable';
        showError(`Impossible de joindre l'API : ${e.message}`);
    }
    initControls();
    renderHistory();
    renderParams();
    onTextChange();
}

init();
