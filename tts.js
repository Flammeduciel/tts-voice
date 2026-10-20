#!/usr/bin/env node
/**
 * CLI TTS — même moteur que le serveur (lib/), gratuit et local.
 *
 *   node tts.js "Bonjour" -o bonjour.mp3
 *   node tts.js -f roman.txt -v fr-CA -s 1.2 -o roman.ogg --srt
 *   cat article.md | node tts.js --cleanup -o article.mp3
 */

// Charge .env (s'il existe) avant tout : les modules lisent leur configuration au chargement.
// Les variables déjà définies (terminal, Dokploy…) restent prioritaires.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch {}

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { VOICES, loadEdgeVoices, engines } = require('./lib/catalog');
const synth = require('./lib/synth');
const cache = require('./lib/cache');
const audio = require('./lib/audio');

const HELP = `
TTS Voice — synthèse vocale gratuite

Usage :
  node tts.js "texte" [options]
  node tts.js -f fichier.txt [options]
  cat fichier.txt | node tts.js [options]

Voix :
  -v, --voice <id>          Voix (défaut fr-FR). Ex. fr-FR (moteur google), fr-FR-HenriNeural (moteur edge)
      --list-voices [lang]  Affiche les voix disponibles (ex. --list-voices fr)
                            filtres : --engine google|edge  --gender male|female

Rendu (local, via ffmpeg) :
  -s, --speed <x>           Vitesse 0.25 – 4 (défaut 1), sans changer la hauteur
  -p, --pitch <dt>          Hauteur en demi-tons -12 – +12 (défaut 0)
      --volume <dB>         Gain -20 – +20 dB
      --normalize           Normalisation de loudness (EBU R128)
      --slow                Diction lente
      --sentence-pause <ms> Pause entre phrases (défaut 350)
      --paragraph-pause <ms> Pause entre paragraphes (défaut 800)

Texte :
      --cleanup             Retire markdown, liens, emojis
      --no-markup           Ne pas interpréter [pause] [voice xx] [slow]
      --plan                Affiche le découpage sans rien générer

Sortie :
  -o, --output <fichier>    Fichier de sortie ; le format est déduit de l'extension
                            (.mp3 .ogg .aac .wav .flac). Défaut : output/tts-<date>.mp3
      --format <fmt>        Force le format
      --bitrate <kbps>      Débit (mp3/ogg/aac)
      --sample-rate <Hz>    Fréquence de sortie (défaut 24000)
      --srt / --vtt         Écrit aussi les sous-titres à côté de l'audio

Balises dans le texte :
  [pause 800ms]  [voice en-US] … [voice]  [slow] … [/slow]   (ligne vide = paragraphe)

Exemples :
  node tts.js "Bonjour tout le monde" -v fr-FR-HenriNeural -o salut.mp3
  node tts.js -f histoire.txt -s 1.15 --normalize -o histoire.ogg --srt
  node tts.js "Hello [pause 1s] [voice fr-FR]Bonjour[voice]" -v en-US
`;

function fail(msg) {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

async function readStdin() {
    if (process.stdin.isTTY) return '';
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}

function progressBar(done, total) {
    const width = 28;
    const filled = total ? Math.round(done / total * width) : 0;
    process.stderr.write(`\r   [${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total}`);
}

async function main() {
    let args;
    try {
        args = parseArgs({
            allowPositionals: true,
            options: {
                help: { type: 'boolean', short: 'h' },
                file: { type: 'string', short: 'f' },
                output: { type: 'string', short: 'o' },
                voice: { type: 'string', short: 'v' },
                lang: { type: 'string', short: 'l' }, // ancien nom
                speed: { type: 'string', short: 's' },
                pitch: { type: 'string', short: 'p' },
                volume: { type: 'string' },
                normalize: { type: 'boolean' },
                slow: { type: 'boolean' },
                'sentence-pause': { type: 'string' },
                'paragraph-pause': { type: 'string' },
                cleanup: { type: 'boolean' },
                'no-markup': { type: 'boolean' },
                plan: { type: 'boolean' },
                format: { type: 'string' },
                bitrate: { type: 'string' },
                'sample-rate': { type: 'string' },
                srt: { type: 'boolean' },
                vtt: { type: 'boolean' },
                'list-voices': { type: 'boolean' },
                engine: { type: 'string' },
                gender: { type: 'string' },
            },
        });
    } catch (e) {
        fail(`${e.message}\n   (voir --help)`);
    }
    const { values: o, positionals } = args;

    if (o.help) return console.log(HELP);
    await loadEdgeVoices();
    if (o['list-voices']) {
        const lang = positionals[0]?.toLowerCase();
        const sign = { male: '♂', female: '♀' };
        const list = VOICES.filter(v => (!lang || v.language === lang) && (!o.engine || v.engine === o.engine) && (!o.gender || v.gender === o.gender));
        for (const v of list) console.log(`  ${v.id.padEnd(34)} ${v.engine.padEnd(6)} ${sign[v.gender] || ' '}  ${v.label}`);
        if (!engines().edge.available) console.log(`\n  (voix Edge indisponibles : ${engines().edge.error})`);
        return;
    }

    let text = o.file ? fs.readFileSync(o.file, 'utf8') : positionals.join(' ');
    if (!text) text = await readStdin();
    if (!text.trim()) { console.log(HELP); process.exit(1); }

    const output = o.output || path.join('output', `tts-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${o.format || 'mp3'}`);
    const extFormat = path.extname(output).slice(1).toLowerCase();
    const format = o.format || (audio.FORMATS[extFormat] ? extFormat : 'mp3');

    let opts;
    try {
        opts = synth.normalizeOptions({
            text, format,
            voice: o.voice || o.lang,
            speed: o.speed, pitch: o.pitch, volume: o.volume, bitrate: o.bitrate, sampleRate: o['sample-rate'],
            sentencePause: o['sentence-pause'], paragraphPause: o['paragraph-pause'],
            normalize: o.normalize, slow: o.slow, cleanup: o.cleanup, markup: !o['no-markup'],
        });
    } catch (e) {
        fail(e.message);
    }

    const { items } = synth.plan(opts);
    if (o.plan) {
        items.forEach((it, i) => console.log(`${String(i + 1).padStart(4)}. [${it.voice.id}${it.slow ? ', lent' : ''}] ${it.text}  ⏸${it.gapAfter}ms`));
        return console.log(`\n${items.length} requêtes`);
    }

    console.error(`🎤 ${text.length} caractères → ${output}`);
    console.error(`   voix ${opts.voice} · vitesse ${opts.speed}× · hauteur ${opts.pitch} · ${format} · ${items.length} requêtes`);
    const t0 = Date.now();
    const controller = new AbortController();
    process.once('SIGINT', () => { controller.abort(new Error('Interrompu (les segments déjà téléchargés restent en cache)')); });

    try {
        const r = await synth.render(opts, { onProgress: ({ done, total }) => progressBar(done, total), signal: controller.signal });
        process.stderr.write('\n');
        fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
        fs.copyFileSync(cache.renders.audioPath(r.id, r.extension), output);
        const base = output.replace(/\.[^.\/]+$/, '');
        if (o.srt) fs.writeFileSync(`${base}.srt`, synth.subtitles(r.segments, 'srt'));
        if (o.vtt) fs.writeFileSync(`${base}.vtt`, synth.subtitles(r.segments, 'vtt'));
        const mins = Math.floor(r.duration / 60), secs = Math.round(r.duration % 60);
        console.error(`✅ ${output} · ${mins}:${String(secs).padStart(2, '0')} · ${(r.size / 1024).toFixed(0)} Ko · ${((Date.now() - t0) / 1000).toFixed(1)} s${r.cached ? ' (cache)' : ''}`);
    } catch (e) {
        process.stderr.write('\n');
        fail(e.message);
    }
}

main();
