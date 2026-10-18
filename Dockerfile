FROM node:24.13.0-slim
WORKDIR /app
ENV NODE_ENV=production PT_STATE_DIR=/data/state PT_SECRETS_DIR=/data/secrets
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
CMD ["node", "src/supervise.ts"]
