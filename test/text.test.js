// Tests hors ligne du découpage et des balises : node --test
const test = require('node:test');
const assert = require('node:assert');

const { chunkText, cleanText, MAX_CHARS } = require('../lib/text');
const synth = require('../lib/synth');
const { resolveVoice } = require('../lib/catalog');

test('aucun segment ne dépasse la limite de Google', () => {
    const long = 'Une phrase assez longue, avec des virgules, des points-virgules ; et ainsi de suite. '.repeat(80)
        + 'motsansespace'.repeat(40) + ' 这是一个很长的句子'.repeat(50);
    for (const c of chunkText(long, 'fr')) assert.ok(c.text.length <= MAX_CHARS, `${c.text.length} > ${MAX_CHARS}`);
});

test('les phrases courtes sont regroupées', () => {
    const chunks = chunkText('Un. Deux. Trois. Quatre.', 'fr');
    assert.strictEqual(chunks.length, 1);
});

test('une phrase longue est coupée en morceaux équilibrés', () => {
    const s = 'Nouveau paragraphe avec une phrase un peu plus longue pour voir comment le découpage se comporte quand on dépasse largement la limite de deux cents caractères imposée par Google sur chaque requête envoyée.';
    const sizes = chunkText(s, 'fr').map(c => c.text.length);
    assert.strictEqual(sizes.length, 2);
    assert.ok(Math.min(...sizes) > 60, `déséquilibré : ${sizes}`);
});

test('balises [pause], [voice], [slow] et paragraphes', () => {
    const opts = synth.normalizeOptions({ text: 'Bonjour. [pause 2s] [voice en-US]Hello.[voice]\n\n[slow]Lent.[/slow]' });
    const { items } = synth.plan(opts);
    assert.deepStrictEqual(items.map(i => [i.text, i.voice.id, i.slow]), [
        ['Bonjour.', 'fr-FR', false], ['Hello.', 'en-US', false], ['Lent.', 'fr-FR', true],
    ]);
    assert.strictEqual(items[0].gapAfter, 350 + 2000);
    assert.strictEqual(items[1].gapAfter, 350 + 800);
});

test('markup désactivé : les balises sont lues telles quelles', () => {
    const { items } = synth.plan(synth.normalizeOptions({ text: 'A [pause] B', markup: false }));
    assert.strictEqual(items[0].text, 'A [pause] B');
});

test('nettoyage markdown', () => {
    assert.strictEqual(cleanText('## Titre\n**gras** et [lien](https://x.y) 🎉').replace(/\s+/g, ' ').trim(), 'Titre gras et lien');
});

test('validation des paramètres', () => {
    assert.throws(() => synth.normalizeOptions({ text: '' }), { code: 'missing_text' });
    assert.throws(() => synth.normalizeOptions({ text: 'x', voice: 'klingon' }), { code: 'invalid_voice' });
    assert.throws(() => synth.normalizeOptions({ text: 'x', speed: 10 }), { code: 'invalid_parameter', field: 'speed' });
    assert.throws(() => synth.normalizeOptions({ text: 'x [voice zz]y' }) && synth.plan(synth.normalizeOptions({ text: 'x [voice zz]y' })), { code: 'invalid_voice' });
});

test('alias de voix', () => {
    assert.strictEqual(resolveVoice('fr').id, 'fr-FR');
    assert.strictEqual(resolveVoice('fr-BE').id, 'fr-FR');
    assert.strictEqual(resolveVoice('en').id, 'en-GB');
    assert.strictEqual(resolveVoice('EN-us').id, 'en-US');
    assert.strictEqual(resolveVoice('es-MX').id, 'es-US');
});

test('sous-titres SRT/VTT', () => {
    const segs = [{ index: 0, text: 'Salut', start: 0, end: 1.5 }, { index: 1, text: 'Ça va ?', start: 61.25, end: 3725.001 }];
    assert.match(synth.subtitles(segs, 'srt'), /00:01:01,250 --> 01:02:05,001/);
    assert.match(synth.subtitles(segs, 'vtt'), /^WEBVTT/);
});

test('chaque voix applique sa propre limite de caractères (Edge : 1000)', () => {
    const { buildPlan } = require('../lib/text');
    const edgeVoice = { id: 'fr-FR-HenriNeural', engine: 'edge', language: 'fr', maxChars: 1000 };
    const long = 'Une phrase de longueur moyenne pour remplir le texte. '.repeat(30);
    const pauses = { sentence: 350, paragraph: 800, clause: 150, word: 40 };
    const edge = buildPlan([{ type: 'text', text: long, voice: edgeVoice, slow: false }], pauses).items;
    const google = buildPlan([{ type: 'text', text: long, voice: resolveVoice('fr'), slow: false }], pauses).items;
    assert.ok(edge.every(i => i.text.length <= 1000) && google.every(i => i.text.length <= 200));
    assert.ok(edge.length < google.length / 3, `${edge.length} vs ${google.length}`);
});
