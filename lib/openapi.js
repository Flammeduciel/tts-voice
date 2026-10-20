/** Spécification OpenAPI 3.1 de l'API v1 (servie sur /openapi.json). */

const { FORMATS } = require('./audio');
const { DEFAULTS, MAX_TEXT } = require('./synth');
const pkg = require('../package.json');

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = schema => ({ 'application/json': { schema } });
const error = description => ({ description, content: json(ref('Error')) });

const speechParams = {
    text: { type: 'string', maxLength: MAX_TEXT, description: 'Texte à lire. Balises possibles : [pause 800ms], [voice en-US] … [voice], [slow] … [/slow]. Une ligne vide = nouveau paragraphe.' },
    voice: { type: 'string', default: DEFAULTS.voice, examples: ['fr-FR', 'fr-FR-HenriNeural', 'fr-CA-JeanNeural'], description: 'Identifiant de voix (GET /v1/voices). Moteur google : fr-FR, en-US… (alias fr, en, es…). Moteur edge : fr-FR-HenriNeural, fr-FR-DeniseNeural…' },
    speed: { type: 'number', minimum: 0.25, maximum: 4, default: 1, description: 'Vitesse réelle sans changer la hauteur (native sur le moteur edge entre 0.5 et 2, sinon appliquée localement).' },
    pitch: { type: 'number', minimum: -12, maximum: 12, default: 0, description: 'Hauteur en demi-tons.' },
    volume: { type: 'number', minimum: -20, maximum: 20, default: 0, description: 'Gain en dB (limiteur anti-saturation).' },
    normalize: { type: 'boolean', default: false, description: 'Normalisation de loudness EBU R128 (-16 LUFS).' },
    slow: { type: 'boolean', default: false, description: 'Diction lente (mode lent natif sur le moteur google, 0.8× sur le moteur edge).' },
    format: { type: 'string', enum: Object.keys(FORMATS), default: 'mp3' },
    bitrate: { type: 'integer', minimum: 16, maximum: 320, description: 'kb/s (mp3, ogg, aac).' },
    sampleRate: { type: 'integer', minimum: 8000, maximum: 48000, default: 24000 },
    sentencePause: { type: 'integer', minimum: 0, maximum: 5000, default: DEFAULTS.sentencePause, description: 'Silence (ms) entre deux requêtes terminées par une fin de phrase.' },
    paragraphPause: { type: 'integer', minimum: 0, maximum: 10000, default: DEFAULTS.paragraphPause, description: 'Silence (ms) entre paragraphes.' },
    cleanup: { type: 'boolean', default: false, description: 'Retire markdown, URLs et emojis (pratique pour lire une réponse de LLM).' },
    markup: { type: 'boolean', default: true, description: 'Interpréter les balises [pause]/[voice]/[slow].' },
};

const queryParams = Object.entries(speechParams).map(([name, schema]) => ({ name, in: 'query', required: name === 'text', schema }));

module.exports = {
    openapi: '3.1.0',
    info: {
        title: 'TTS Voice API',
        version: pkg.version,
        description: 'Synthèse vocale gratuite avec deux moteurs de voix (edge : voix neuronales hommes/femmes ; google). '
            + 'Textes illimités (découpage automatique), vitesse/hauteur/volume réels, pauses maîtrisées, '
            + 'multi-voix, sous-titres SRT/VTT, jobs asynchrones avec progression. '
            + 'Clé d\'API facultative : "Authorization: Bearer <clé>" ou "X-API-Key". Sans clé, la limite de requêtes est plus basse.',
    },
    servers: [{ url: '/' }],
    components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
        schemas: {
            SpeechRequest: {
                type: 'object', required: ['text'],
                properties: { ...speechParams, response: { type: 'string', enum: ['audio', 'json', 'base64'], default: 'audio' }, filename: { type: 'string' }, download: { type: 'boolean' } },
                example: { text: 'Bonjour ! [pause 500ms] Bienvenue.', voice: 'fr-FR', speed: 1.1 },
            },
            Segment: {
                type: 'object',
                properties: { index: { type: 'integer' }, text: { type: 'string' }, voice: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } },
            },
            SpeechResult: {
                type: 'object',
                properties: {
                    id: { type: 'string' }, format: { type: 'string' }, mimeType: { type: 'string' }, size: { type: 'integer' },
                    duration: { type: 'number', description: 'secondes' }, requests: { type: 'integer' }, cached: { type: 'boolean' },
                    audioUrl: { type: 'string' }, subtitles: { type: 'object', properties: { srt: { type: 'string' }, vtt: { type: 'string' } } },
                    segments: { type: 'array', items: ref('Segment') }, audioBase64: { type: 'string', description: 'uniquement avec response=base64' },
                },
            },
            Job: {
                type: 'object',
                properties: {
                    id: { type: 'string' }, status: { type: 'string', enum: ['queued', 'running', 'done', 'error', 'cancelled'] },
                    progress: { type: 'object', properties: { done: { type: 'integer' }, total: { type: 'integer' } } },
                    result: { type: ['object', 'null'] }, error: { type: ['object', 'null'] },
                },
            },
            Voice: {
                type: 'object',
                properties: {
                    id: { type: 'string' }, engine: { type: 'string', enum: ['google', 'edge'] }, language: { type: 'string' }, locale: { type: 'string' },
                    label: { type: 'string' }, name: { type: 'string' }, gender: { type: ['string', 'null'], enum: ['male', 'female', null] },
                    multilingual: { type: 'boolean' }, personalities: { type: 'array', items: { type: 'string' } },
                },
            },
            Error: {
                type: 'object',
                properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, field: { type: 'string' } } } },
            },
        },
    },
    security: [{}, { bearer: [] }, { apiKey: [] }],
    paths: {
        '/v1/health': { get: { summary: 'État du serveur et capacités', responses: { 200: { description: 'OK' } } } },
        '/v1/voices': {
            get: {
                summary: 'Voix disponibles',
                parameters: [
                    { name: 'language', in: 'query', schema: { type: 'string' }, example: 'fr' },
                    { name: 'engine', in: 'query', schema: { type: 'string', enum: ['google', 'edge'] } },
                    { name: 'gender', in: 'query', schema: { type: 'string', enum: ['male', 'female'] } },
                    { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Recherche dans l\'id et le libellé' },
                ],
                responses: { 200: { description: 'Liste', content: json({ type: 'object', properties: { voices: { type: 'array', items: ref('Voice') } } }) } },
            },
        },
        '/v1/speech': {
            post: {
                summary: 'Synthétiser un texte',
                description: 'Renvoie l\'audio directement (défaut) ou un JSON (response=json|base64). '
                    + 'Accepte aussi un corps text/plain : le texte, avec les options en query string.',
                requestBody: { required: true, content: { ...json(ref('SpeechRequest')), 'text/plain': { schema: { type: 'string' } } } },
                responses: {
                    200: {
                        description: 'Audio, ou JSON selon "response". En-têtes : X-Audio-Id, X-Audio-Duration, X-Requests, X-Cache.',
                        content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } }, ...json(ref('SpeechResult')) },
                    },
                    400: error('Paramètre invalide'), 401: error('Clé d\'API invalide'), 413: error('Texte trop long'),
                    429: error('Limite de débit'), 502: error('Erreur du moteur de synthèse'),
                },
            },
            get: {
                summary: 'Synthétiser (GET, pour <audio src="…">)',
                parameters: queryParams,
                responses: { 200: { description: 'Audio', content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } } }, 400: error('Paramètre invalide') },
            },
        },
        '/v1/plan': {
            post: {
                summary: 'Aperçu du découpage (aucune synthèse)',
                requestBody: { required: true, content: json(ref('SpeechRequest')) },
                responses: { 200: { description: 'Segments prévus, nombre de requêtes, durée estimée' } },
            },
        },
        '/v1/jobs': {
            post: {
                summary: 'Créer une synthèse asynchrone (textes longs)',
                requestBody: { required: true, content: json(ref('SpeechRequest')) },
                responses: { 202: { description: 'Job créé', content: json(ref('Job')) } },
            },
        },
        '/v1/jobs/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            get: { summary: 'État d\'un job', responses: { 200: { description: 'Job', content: json(ref('Job')) }, 404: error('Introuvable') } },
            delete: { summary: 'Annuler un job', responses: { 200: { description: 'Job', content: json(ref('Job')) } } },
        },
        '/v1/jobs/{id}/events': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            get: { summary: 'Progression en direct (Server-Sent Events : progress, done, error, cancelled)', responses: { 200: { description: 'text/event-stream' } } },
        },
        '/v1/audio/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'download', in: 'query', schema: { type: 'boolean' } }],
            get: { summary: 'Télécharger un audio rendu (Range supporté)', responses: { 200: { description: 'Audio' }, 404: error('Introuvable') } },
        },
        '/v1/audio/{id}/meta': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            get: { summary: 'Métadonnées et minutage des segments', responses: { 200: { description: 'OK', content: json(ref('SpeechResult')) } } },
        },
        '/v1/audio/{id}/subtitles.{kind}': {
            parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['srt', 'vtt'] } },
            ],
            get: { summary: 'Sous-titres synchronisés', responses: { 200: { description: 'SRT ou WebVTT' } } },
        },
    },
};
