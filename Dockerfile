# TTS Voice — image de production (Dokploy, build type « Dockerfile »)
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    TTS_CACHE_DIR=/data/cache \
    TRUST_PROXY=1

# ffmpeg : traitement audio · python3 + pip : moteur edge · tini : init (signaux, process enfants)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Moteur edge : non épinglé exprès, chaque rebuild récupère la dernière version
# (dans Dokploy, « Rebuild » sans cache pour forcer la mise à jour).
RUN pip3 install --no-cache-dir --break-system-packages --target /app/.python edge-tts

COPY . .

RUN mkdir -p /data/cache && chown -R node:node /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
