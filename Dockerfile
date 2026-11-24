# Один слой, ноль зависимостей: образ собирается за секунды.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 LOG_FORMAT=json

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY migrations ./migrations
COPY scripts ./scripts
COPY public ./public

VOLUME ["/data"]
EXPOSE 3000

# Проверяем живость: готовность (/api/ready) опрашивает балансировщик,
# а докеру важно лишь то, что процесс отвечает.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Сигнал SIGTERM обрабатывается приложением: соединения дописываются, база закрывается
STOPSIGNAL SIGTERM

CMD ["node", "server/index.js"]
