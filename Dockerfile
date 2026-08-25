FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json SPEC.md ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev && chown -R 1001:1001 /app
COPY --from=build /app/dist ./dist
USER 1001
VOLUME /data
EXPOSE 8790
CMD ["node","dist/src/index.js"]
