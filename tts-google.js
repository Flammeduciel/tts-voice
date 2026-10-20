#!/usr/bin/env node
/**
 * TTS Google Translate (Approche 2) - Utilise l'API non-officielle de Google Translate
 * 
 * Avantages: Voix très naturelles, gratuit, beaucoup de langues/voix
 * Inconvénients: Nécessite internet, API non-officielle (peut changer), limite de caractères
 */

const googleTTS = require('google-tts-api');
const fs = require('fs');
const https = require('https');
const path = require('path');

// Configuration par défaut
const DEFAULT_TEXT = "Bonjour et bienvenue. Aujourd'hui, nous allons tester une voix française naturelle générée par synthèse vocale.";
const DEFAULT_OUTPUT = './output-google.mp3';
const DEFAULT_LANG = 'fr';     // Code langue ISO 639-1
const DEFAULT_SLOW = false;    // Vitesse lente

/**
 * Télécharge un fichier depuis une URL
 */
function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(outputPath);
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                resolve(outputPath);
            });
        }).on('error', (err) => {
            fs.unlink(outputPath, () => {}); // Supprimer fichier partiel
            reject(err);
        });
        
        file.on('error', (err) => {
            fs.unlink(outputPath, () => {});
            reject(err);
        });
    });
}

/**
 * Génère l'URL TTS Google et télécharge le fichier
 */
async function generateWithGoogle(text, outputFile, lang = DEFAULT_LANG, slow = DEFAULT_SLOW) {
    try {
        // Obtenir l'URL de l'API Google TTS
        const url = googleTTS.getAudioUrl(text, {
            lang: lang,
            slow: slow,
            host: 'https://translate.google.com'
        });
        
        console.log(`🔗 URL générée: ${url.substring(0, 80)}...`);
        
        // Télécharger le fichier audio
        await downloadFile(url, outputFile);
        
        // Vérifier la taille du fichier
        const stats = fs.statSync(outputFile);
        console.log(`✅ Fichier généré: ${outputFile} (${(stats.size / 1024).toFixed(1)} KB)`);
        
        return outputFile;
    } catch (error) {
        throw new Error(`Erreur Google TTS: ${error.message}`);
    }
}

/**
 * Découpe un texte long en chunks (Google TTS limite ~200 caractères par requête)
 */
function splitText(text, maxLength = 200) {
    if (text.length <= maxLength) return [text];
    
    const chunks = [];
    let remaining = text;
    
    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }
        
        // Chercher un point de coupure naturel (phrase, virgule, espace)
        let cutIndex = maxLength;
        const punctuation = ['.', '!', '?', ',', ';', ':', ' '];
        
        for (const p of punctuation) {
            const lastIndex = remaining.lastIndexOf(p, maxLength);
            if (lastIndex > maxLength * 0.5) { // Au moins 50% du max
                cutIndex = lastIndex + 1;
                break;
            }
        }
        
        chunks.push(remaining.substring(0, cutIndex).trim());
        remaining = remaining.substring(cutIndex).trim();
    }
    
    return chunks;
}

/**
 * Fusionne plusieurs fichiers MP3 (simple concaténation - fonctionne pour MP3)
 * Note: Pour une vraie fusion, utiliser ffmpeg
 */
async function mergeAudioFiles(files, outputFile) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputFile);
        let completed = 0;
        
        function processNext(index) {
            if (index >= files.length) {
                output.end();
                return;
            }
            
            const input = fs.createReadStream(files[index]);
            input.pipe(output, { end: false });
            
            input.on('end', () => {
                processNext(index + 1);
            });
            
            input.on('error', reject);
        }
        
        output.on('finish', () => resolve(outputFile));
        output.on('error', reject);
        
        processNext(0);
    });
}

/**
 * Génère l'audio pour un texte long (découpé en chunks)
 */
async function generateLongText(text, outputFile, lang = DEFAULT_LANG, slow = DEFAULT_SLOW) {
    const chunks = splitText(text);
    
    if (chunks.length === 1) {
        return generateWithGoogle(text, outputFile, lang, slow);
    }
    
    console.log(`📄 Texte long détecté: ${chunks.length} segments à générer`);
    
    const tempFiles = [];
    
    for (let i = 0; i < chunks.length; i++) {
        const tempFile = `${outputFile}.part${i}.mp3`;
        console.log(`   Segment ${i + 1}/${chunks.length}...`);
        await generateWithGoogle(chunks[i], tempFile, lang, slow);
        tempFiles.push(tempFile);
    }
    
    console.log(`🔗 Fusion des segments...`);
    await mergeAudioFiles(tempFiles, outputFile);
    
    // Nettoyer les fichiers temporaires
    for (const f of tempFiles) {
        fs.unlinkSync(f);
    }
    
    console.log(`✅ Fichier final: ${outputFile}`);
    return outputFile;
}

/**
 * Fonction principale
 */
async function main() {
    const args = process.argv.slice(2);
    const text = args[0] || DEFAULT_TEXT;
    const outputFile = args[1] || DEFAULT_OUTPUT;
    const lang = args[2] || DEFAULT_LANG;
    const slow = args[3] === 'true' || args[3] === 'slow';
    
    console.log('🎤 TTS Google Translate (Approche 2)');
    console.log('━'.repeat(50));
    console.log(`📝 Texte: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
    console.log(`📁 Sortie: ${outputFile}`);
    console.log(`🌐 Langue: ${lang} (${slow ? 'lente' : 'normale'})`);
    console.log('━'.repeat(50));
    
    try {
        await generateLongText(text, outputFile, lang, slow);
        console.log('\n🎉 Terminé !');
    } catch (error) {
        console.error('❌ Erreur:', error.message);
        process.exit(1);
    }
}

// Exécution si script principal
if (require.main === module) {
    main();
}

module.exports = { generateWithGoogle, generateLongText, splitText };