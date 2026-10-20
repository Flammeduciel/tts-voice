/**
 * Catalogue des voix, tous moteurs confondus.
 *  - engine "google" : endpoint gratuit translate_tts (une voix par langue, liste ci-dessous)
 *  - engine "edge"   : voix neuronales de Microsoft Edge (chargées dynamiquement, voir lib/edge.js)
 *
 * Voix Google :
 * Vérifié empiriquement (oct. 2026) en comparant l'audio décodé :
 *  - un code région n'apporte une voix différente que pour les entrées marquées ci-dessous ;
 *    les autres (fr-BE, fr-CH, en-CA, de-AT...) renvoient exactement la voix par défaut.
 *  - les langues absentes de cette liste renvoient HTTP 400.
 */

// [id, code envoyé à Google (tl), langue, libellé]
const GOOGLE_VOICES = [
    ['fr-FR', 'fr', 'fr', 'Français (France)'],
    ['fr-CA', 'fr-CA', 'fr', 'Français (Québec)'],
    ['en-US', 'en-US', 'en', 'English (US)'],
    ['en-GB', 'en', 'en', 'English (UK)'],
    ['en-AU', 'en-AU', 'en', 'English (Australia)'],
    ['en-IN', 'en-IN', 'en', 'English (India)'],
    ['en-NG', 'en-NG', 'en', 'English (Nigeria)'],
    ['es-ES', 'es', 'es', 'Español (España)'],
    ['es-US', 'es-US', 'es', 'Español (Latinoamérica)'],
    ['pt-BR', 'pt', 'pt', 'Português (Brasil)'],
    ['pt-PT', 'pt-PT', 'pt', 'Português (Portugal)'],
    ['zh-CN', 'zh-CN', 'zh', '中文 (普通话, 中国大陆)'],
    ['zh-TW', 'zh-TW', 'zh', '中文 (台灣)'],
    ['yue', 'yue', 'yue', '粵語 (Cantonese)'],
    ['af', 'af', 'af', 'Afrikaans'],
    ['am', 'am', 'am', 'አማርኛ (Amharic)'],
    ['ar', 'ar', 'ar', 'العربية (Arabic)'],
    ['bg', 'bg', 'bg', 'Български (Bulgarian)'],
    ['bn', 'bn', 'bn', 'বাংলা (Bengali)'],
    ['bs', 'bs', 'bs', 'Bosanski (Bosnian)'],
    ['ca', 'ca', 'ca', 'Català'],
    ['cs', 'cs', 'cs', 'Čeština'],
    ['cy', 'cy', 'cy', 'Cymraeg (Welsh)'],
    ['da', 'da', 'da', 'Dansk'],
    ['de-DE', 'de', 'de', 'Deutsch'],
    ['el', 'el', 'el', 'Ελληνικά (Greek)'],
    ['et', 'et', 'et', 'Eesti (Estonian)'],
    ['eu', 'eu', 'eu', 'Euskara (Basque)'],
    ['fi', 'fi', 'fi', 'Suomi'],
    ['fil', 'fil', 'fil', 'Filipino'],
    ['gl', 'gl', 'gl', 'Galego'],
    ['gu', 'gu', 'gu', 'ગુજરાતી (Gujarati)'],
    ['ha', 'ha', 'ha', 'Hausa'],
    ['he', 'iw', 'he', 'עברית (Hebrew)'],
    ['hi', 'hi', 'hi', 'हिन्दी (Hindi)'],
    ['hr', 'hr', 'hr', 'Hrvatski'],
    ['hu', 'hu', 'hu', 'Magyar'],
    ['id', 'id', 'id', 'Bahasa Indonesia'],
    ['is', 'is', 'is', 'Íslenska'],
    ['it-IT', 'it', 'it', 'Italiano'],
    ['ja', 'ja', 'ja', '日本語 (Japanese)'],
    ['jv', 'jw', 'jv', 'Basa Jawa'],
    ['km', 'km', 'km', 'ខ្មែរ (Khmer)'],
    ['kn', 'kn', 'kn', 'ಕನ್ನಡ (Kannada)'],
    ['ko', 'ko', 'ko', '한국어 (Korean)'],
    ['la', 'la', 'la', 'Latina'],
    ['lt', 'lt', 'lt', 'Lietuvių'],
    ['lv', 'lv', 'lv', 'Latviešu'],
    ['ml', 'ml', 'ml', 'മലയാളം (Malayalam)'],
    ['mr', 'mr', 'mr', 'मराठी (Marathi)'],
    ['ms', 'ms', 'ms', 'Bahasa Melayu'],
    ['my', 'my', 'my', 'မြန်မာ (Burmese)'],
    ['ne', 'ne', 'ne', 'नेपाली (Nepali)'],
    ['nl', 'nl', 'nl', 'Nederlands'],
    ['no', 'no', 'no', 'Norsk'],
    ['pa', 'pa', 'pa', 'ਪੰਜਾਬੀ (Punjabi)'],
    ['pl', 'pl', 'pl', 'Polski'],
    ['ro', 'ro', 'ro', 'Română'],
    ['ru', 'ru', 'ru', 'Русский'],
    ['si', 'si', 'si', 'සිංහල (Sinhala)'],
    ['sk', 'sk', 'sk', 'Slovenčina'],
    ['sq', 'sq', 'sq', 'Shqip (Albanian)'],
    ['sr', 'sr', 'sr', 'Српски (Serbian)'],
    ['su', 'su', 'su', 'Basa Sunda'],
    ['sv', 'sv', 'sv', 'Svenska'],
    ['sw', 'sw', 'sw', 'Kiswahili'],
    ['ta', 'ta', 'ta', 'தமிழ் (Tamil)'],
    ['te', 'te', 'te', 'తెలుగు (Telugu)'],
    ['th', 'th', 'th', 'ไทย (Thai)'],
    ['tr', 'tr', 'tr', 'Türkçe'],
    ['uk', 'uk', 'uk', 'Українська'],
    ['ur', 'ur', 'ur', 'اردو (Urdu)'],
    ['vi', 'vi', 'vi', 'Tiếng Việt'],
].map(([id, tl, language, label]) => ({ id, tl, language, label, engine: 'google', gender: null, maxChars: 200 }));

const VOICES = [...GOOGLE_VOICES];
const BY_ID = new Map(VOICES.map(v => [v.id.toLowerCase(), v]));

// Alias acceptés en entrée (anciens codes de l'API v1, codes Google bruts, variantes régionales sans voix propre)
const ALIASES = {
    fr: 'fr-FR', 'fr-be': 'fr-FR', 'fr-ch': 'fr-FR', 'fr-lu': 'fr-FR', 'fr-sn': 'fr-FR', 'fr-ci': 'fr-FR', 'fr-cm': 'fr-FR',
    en: 'en-GB', 'en-ca': 'en-US', 'en-ie': 'en-GB', 'en-za': 'en-GB',
    es: 'es-ES', 'es-mx': 'es-US', 'es-ar': 'es-US', 'es-419': 'es-US',
    pt: 'pt-BR', zh: 'zh-CN', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW', 'zh-hk': 'yue',
    de: 'de-DE', 'de-at': 'de-DE', 'de-ch': 'de-DE', it: 'it-IT', iw: 'he', jw: 'jv', tl: 'fil', nb: 'no',
};

function resolveVoice(id) {
    if (!id) return BY_ID.get('fr-fr');
    const key = String(id).trim().toLowerCase();
    return BY_ID.get(key) || BY_ID.get((ALIASES[key] || '').toLowerCase()) || null;
}

// ==================== EDGE ====================

const regionNames = new Intl.DisplayNames(['fr'], { type: 'region' });
const languageNames = new Intl.DisplayNames(['fr'], { type: 'language' });
const safe = (fn, v) => { try { return fn(v) || v; } catch { return v; } };

function fromEdge(raw) {
    const [language, region] = raw.Locale.split('-');
    // "Microsoft Henri Online (Natural) - French (France)" -> "Henri"
    const name = (raw.FriendlyName?.match(/^Microsoft (.+?) Online/)?.[1] || raw.ShortName.split('-').pop().replace(/Neural$/, ''))
        .replace(/ ?Multilingual$/, '');
    const where = region ? `${safe(n => languageNames.of(n), language)} (${safe(r => regionNames.of(r), region)})` : safe(n => languageNames.of(n), raw.Locale);
    return {
        id: raw.ShortName,
        language,
        locale: raw.Locale,
        label: `${name} — ${where}`,
        name,
        engine: 'edge',
        gender: raw.Gender === 'Male' ? 'male' : raw.Gender === 'Female' ? 'female' : null,
        multilingual: /Multilingual/.test(raw.ShortName),
        personalities: raw.VoiceTag?.VoicePersonalities || [],
        maxChars: 1000,
    };
}

let edgeState = { loaded: false, available: false, error: null, count: 0 };
let loading = null;

/** Charge les voix Edge dans le catalogue (sans effet si edge-tts n'est pas installé ou injoignable). */
function loadEdgeVoices() {
    if (loading) return loading;
    loading = (async () => {
        const edge = require('./edge');
        if (!edge.isInstalled()) {
            edgeState = { loaded: true, available: false, error: 'moteur edge non installé (npm run setup:edge)', count: 0 };
            return edgeState;
        }
        try {
            const voices = (await edge.listVoices()).map(fromEdge)
                .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
            for (const v of voices) {
                if (BY_ID.has(v.id.toLowerCase())) continue;
                VOICES.push(v);
                BY_ID.set(v.id.toLowerCase(), v);
            }
            edgeState = { loaded: true, available: true, error: null, count: voices.length };
        } catch (err) {
            edgeState = { loaded: true, available: false, error: err.message, count: 0 };
        }
        return edgeState;
    })();
    return loading;
}

const engines = () => ({
    google: { available: true, voices: GOOGLE_VOICES.length },
    edge: { available: edgeState.available, voices: edgeState.count, ...(edgeState.error && { error: edgeState.error }) },
});

module.exports = { VOICES, resolveVoice, loadEdgeVoices, engines };
