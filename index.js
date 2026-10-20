/**
 * Utilisation comme bibliothèque Node :
 *
 *   const tts = require('google-tts-ultra');
 *   const { audio, duration, segments } = await tts.speak('Bonjour !', { voice: 'fr-FR-HenriNeural', speed: 1.1, format: 'ogg' });
 *   fs.writeFileSync('bonjour.ogg', audio);
 */

const fs = require('fs');
const { VOICES, loadEdgeVoices } = require('./lib/catalog');
const synth = require('./lib/synth');
const cache = require('./lib/cache');

/** Synthétise un texte. Options identiques à l'API HTTP (voice, speed, pitch, volume, format, …). */
async function speak(text, options = {}, { onProgress, signal } = {}) {
    await loadEdgeVoices();
    const opts = synth.normalizeOptions({ ...options, text });
    const result = await synth.render(opts, { onProgress, signal });
    return { ...result, audio: fs.readFileSync(cache.renders.audioPath(result.id, result.extension)) };
}

/** Liste des voix (Google + Edge si disponible). */
async function listVoices() {
    await loadEdgeVoices();
    return VOICES.map(({ id, engine, language, label, gender }) => ({ id, engine, language, label, gender }));
}

/** Découpage prévu (aucune requête réseau ; voix Google ou voix Edge déjà chargées). */
function plan(text, options = {}) {
    return synth.plan(synth.normalizeOptions({ ...options, text })).items
        .map(i => ({ text: i.text, voice: i.voice.id, slow: i.slow, pauseAfter: i.gapAfter }));
}

module.exports = {
    speak,
    plan,
    subtitles: synth.subtitles,
    listVoices,
    ApiError: synth.ApiError,
};
