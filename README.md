<p align="center"><img src="public/logo.svg" width="96" height="96" alt="TTS Voice"></p>

# TTS Voice

Synthèse vocale **gratuite**, sans clé ni compte, avec deux moteurs de voix : `edge` (voix neuronales) et `google`. Le projet propose :

- une **API HTTP** documentée (OpenAPI) ;
- un **playground** web (Studio, Transcription, documentation interactive) ;
- un **CLI** ;
- une **bibliothèque Node**.

Fonctionnalités :

- **Textes illimités** : découpage intelligent par phrases (selon la limite de chaque moteur), requêtes en parallèle, retries, cache disque par segment.
- **Vraie vitesse** (0.25×–4×) et **hauteur** (±12 demi-tons), volume, normalisation EBU R128. Ces réglages sont appliqués localement par ffmpeg.
- **Pauses maîtrisées** entre phrases et paragraphes, et balises `[pause 800ms]`.
- **Multi-voix** dans un même texte : `[voice en-US] … [voice]`. Diction lente : `[slow] … [/slow]`.
- **~395 voix** :
  - google : 73 voix dans environ 60 langues, une voix (féminine) par langue ou région, par exemple `fr-FR` et `fr-CA`.
  - edge : 322 voix neuronales, hommes et femmes. En français : Henri, Rémy, Denise, Eloise, Vivienne (France), Jean, Antoine, Thierry, Sylvie (Québec), Gérard, Charline (Belgique), Fabrice, Ariane (Suisse).
- On choisit le moteur simplement par la voix : `"voice": "fr-FR"` utilise le moteur google, `"voice": "fr-FR-HenriNeural"` le moteur edge. Les deux se mélangent dans un même texte.
- **Formats** : mp3, ogg (Opus), aac, wav, flac.
- **Sous-titres** SRT/WebVTT synchronisés, plus le minutage de chaque segment.
- **Transcription** (parole → texte) dans le playground : le fichier est lu dans le navigateur, rien n'est calculé sur le serveur. Chaque phrase et chaque mot reçoit un début et une fin (voir [Transcription](#transcription)).
- **Jobs asynchrones** avec progression en direct (SSE) et annulation.
- **Nettoyage** markdown, liens et emojis, pratique pour lire une réponse de LLM.

## Démarrage

```bash
npm install
npm start            # http://localhost:3000  (playground)
```

ffmpeg est recommandé. Sans lui, seul le mp3 brut est disponible, sans vitesse, hauteur ni pauses.

### Moteur edge

```bash
npm run setup:edge   # installe les dépendances Python du moteur edge dans .python/ (Python 3 requis)
```

Relancez cette commande pour mettre le moteur à jour. Sans elle, le serveur démarre avec les seules voix du moteur google.

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 3000 | Port HTTP |
| `PUBLIC_URL` | — | URL publique du site (ex. `https://tts.mondomaine.fr`) pour les balises canonical et Open Graph. Vide = déduite de la requête |
| `TTS_API_KEYS` | — | Liste de clés séparées par des virgules (`Authorization: Bearer <clé>` ou `X-API-Key`). Une clé valide donne la limite `TTS_RATE_LIMIT` ; sans clé l'accès reste possible avec `TTS_ANON_RATE_LIMIT` ; une clé invalide est refusée (401) |
| `TTS_RATE_LIMIT` | 60 | Synthèses par minute et par IP (0 = illimité) |
| `TTS_ANON_RATE_LIMIT` | 10 | Synthèses par minute et par IP sans clé, quand `TTS_API_KEYS` est défini (0 = illimité) |
| `TTS_CONCURRENCY` | 4 | Requêtes simultanées du moteur google |
| `TTS_MAX_TEXT` | 100000 | Taille max d'un texte |
| `TTS_CACHE_DIR` / `TTS_CACHE_MAX_MB` | `.cache` / 1024 | Cache disque |
| `FFMPEG_PATH` | `ffmpeg` | Binaire ffmpeg |
| `EDGE_TTS` | 1 | `0` désactive le moteur edge |
| `EDGE_CONCURRENCY` | 4 | Synthèses simultanées du moteur edge |
| `EDGE_TTS_PYTHON` | `python3` | Interpréteur Python du moteur edge |

## API

La spec complète est servie sur `GET /openapi.json`, et l'onglet **API** du playground génère les exemples à partir de vos réglages.

```bash
# Audio direct
curl -X POST localhost:3000/v1/speech -H 'Content-Type: application/json' \
  -d '{"text":"Bonjour ! [pause 500ms] Bienvenue.","voice":"fr-FR-HenriNeural","speed":1.1}' -o bonjour.mp3

# Voix françaises masculines du moteur edge
curl 'localhost:3000/v1/voices?language=fr&engine=edge&gender=male'

# Un fichier texte entier, options en query string
curl -X POST 'localhost:3000/v1/speech?voice=fr-FR&format=ogg' \
  -H 'Content-Type: text/plain' --data-binary @livre.txt -o livre.ogg

# JSON avec minutage + liens audio/sous-titres
curl -X POST 'localhost:3000/v1/speech?response=json' -H 'Content-Type: application/json' -d '{"text":"Bonjour"}'
```

```html
<audio controls src="http://localhost:3000/v1/speech?text=Bonjour&voice=fr-CA"></audio>
```

| Méthode | Route | Description |
|---|---|---|
| POST/GET | `/v1/speech` | Texte → audio (`response=audio\|json\|base64`) |
| POST | `/v1/plan` | Découpage prévu + durée estimée, sans synthèse |
| POST | `/v1/jobs` | Synthèse asynchrone → `202` + id |
| GET | `/v1/jobs/:id` · `/v1/jobs/:id/events` | État / progression SSE (`progress`, `done`, `error`, `cancelled`) |
| DELETE | `/v1/jobs/:id` | Annulation |
| GET | `/v1/audio/:id` · `/meta` · `/subtitles.srt\|vtt` | Rendu (Range supporté), métadonnées, sous-titres |
| GET | `/v1/voices?language=fr&engine=edge&gender=male&q=henri` · `/v1/health` | Voix (filtrables), état des moteurs |

**Paramètres** : `text`, `voice`, `speed`, `pitch`, `volume`, `normalize`, `slow`, `format`, `bitrate`, `sampleRate`, `sentencePause`, `paragraphPause`, `cleanup`, `markup`.

**En-têtes de réponse audio** : `X-Audio-Id`, `X-Audio-Duration`, `X-Requests`, `X-Cache`.

**Erreurs** : toujours de la forme `{"error":{"code":"invalid_parameter","message":"…","field":"speed"}}`.

Les anciennes routes (`POST /tts`, `/tts/base64`, `GET /tts/stream`, `/voices`, `/health`) restent compatibles, ainsi que `lang` comme alias de `voice`.

## Transcription

L'onglet **Transcription** du playground convertit la parole en texte, sans aucun calcul côté serveur : c'est le navigateur qui reconnaît (Chrome ou Edge, reconnaissance vocale native).

- **Source** : un fichier audio ou vidéo (MP3, WAV, OGG, M4A, MP4, WebM…) ou le micro.
- **Vitesse** : un fichier long est découpé aux silences et les tranches sont lues en même temps, à 1,5× (hauteur du son conservée) — jusqu'à 6× plus vite que la lecture simple. À la fin de chaque tranche, les mots sont remis dans l'ordre du fichier avant l'alignement. Si rien ne se reconnait, retour automatique à la lecture simple.
- **Horodatages** : l'audio est décodé localement pour repérer les silences ; les phrases sont découpées sur ces silences et chaque mot reçoit un début et une fin (estimés à quelques dixièmes de seconde). Cliquez sur une phrase ou un mot pour vous y déplacer dans le lecteur.
- **Exports** : SRT, VTT, TXT et JSON (phrases + mots horodatés), plus le texte envoyable au Studio.
- **Dictée** : le bouton « Dicter » du Studio permet de remplir le texte au micro.
- Le fichier est lu à vitesse normale : une minute d'audio prend une minute ; les fichiers longs vont jusqu'à 6× plus vite (découpage aux silences, tranches en parallèle). Selon le navigateur, l'audio peut être envoyé au service de reconnaissance en ligne du fournisseur.

Aucune variable d'environnement ni dépendance n'est requise : la fonction disparaît simplement si le navigateur ne propose pas la reconnaissance vocale.

## CLI

```bash
node tts.js "Bonjour tout le monde" -v fr-FR-HenriNeural -o salut.mp3
node tts.js --list-voices fr --engine edge --gender male
node tts.js -f histoire.txt -s 1.15 --normalize -o histoire.ogg --srt
cat article.md | node tts.js --cleanup -o article.mp3
node tts.js --list-voices fr
node tts.js -f histoire.txt --plan        # aperçu du découpage
```

## Bibliothèque

```js
const tts = require('./');           // ou require('google-tts-ultra')
const { audio, duration, segments } = await tts.speak('Bonjour !', { voice: 'fr-FR-DeniseNeural', format: 'ogg' });
const voices = await tts.listVoices();
```

## Caractéristiques des moteurs

| | google | edge |
|---|---|---|
| Voix | 73, une par langue ou région | 322, hommes et femmes |
| Taille d'une requête | 200 caractères | ~1000 caractères |
| Vitesse | appliquée localement (ffmpeg) | native de 0.5× à 2×, complétée par ffmpeg au-delà |
| `[slow]` | diction lente native | 0.8× |
| Audio source | MP3 mono 24 kHz | MP3 mono 24 kHz |

Les codes région sans voix propre (fr-BE, fr-CH, en-CA, de-AT…) sont acceptés comme alias de la voix google la plus proche.

## Déploiement avec Dokploy (Docker)

Le dépôt contient un `Dockerfile` prêt à l'emploi : Node 22, ffmpeg et le moteur edge inclus, utilisateur non-root, healthcheck sur `/v1/health`, arrêt propre.

1. **Pousser le dépôt** sur GitHub, GitLab, Gitea ou tout dépôt Git accessible par Dokploy.
2. Dans Dokploy : **Project → Create Service → Application**.
3. Onglet **General** :
   - **Provider** : votre dépôt, branche `main`.
   - **Build Type** : `Dockerfile`, avec **Docker File** = `Dockerfile` et **Docker Context Path** = `.`.
4. Onglet **Environment** : reprendre les variables utiles de `.env.example`. Définissez au minimum `PUBLIC_URL` (votre domaine, pour l'aperçu des liens partagés) et `TTS_API_KEYS` si le serveur est public.
5. Onglet **Advanced → Volumes** : ajouter un **Volume Mount** (par exemple `tts-cache`) monté sur `/data/cache`. Le cache audio survit ainsi aux redéploiements.
6. Onglet **Domains** : votre domaine, **Container Port** = `3000`, HTTPS avec Let's Encrypt.
7. **Deploy**. Pour déployer à chaque push, activez **Auto Deploy** (webhook).

Le playground est servi sur la racine du domaine et fonctionne sans clé (limite `TTS_ANON_RATE_LIMIT`). Si `TTS_API_KEYS` est défini, il affiche un champ « Accès » facultatif pour saisir une clé, conservée dans le navigateur, qui relève la limite. Les clients de l'API envoient `Authorization: Bearer <clé>`.

Pour mettre à jour le moteur edge : **Rebuild** sans cache dans Dokploy (l'image réinstalle la dernière version).

## Tests

```bash
npm test   # tests hors ligne (découpage, balises, validation, sous-titres)
```
