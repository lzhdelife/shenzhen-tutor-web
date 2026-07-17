FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV TUTOR_DATA_DIR=/data
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node TutorPlatform ./TutorPlatform

RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "TutorPlatform/server.js"]
