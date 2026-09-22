FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
# Cache-bust static asset URLs at build time (Cloudflare caches them by URL)
RUN V=$(date +%s) && sed -i "s/__V__/$V/g" public/index.html public/admin.html
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server.js"]
