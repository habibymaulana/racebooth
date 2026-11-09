FROM node:24-alpine
RUN apk add --no-cache fontconfig font-dejavu
WORKDIR /app/backend
ENV NODE_ENV=production
COPY --chown=node:node backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node backend/ .
COPY --chown=node:node shared/ /app/shared/
COPY --chown=node:node database/migrations/ /app/database/migrations/
COPY --chown=node:node database/01-schema.sql /app/database/01-schema.sql
RUN mkdir -p /app/storage && chown node:node /app/storage && chmod 700 /app/storage
USER node
EXPOSE 3000
CMD ["npm", "start"]
