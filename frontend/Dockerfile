# MiniFoundry frontend — Vite/React SPA served by nginx.
# nginx proxies /api/* to the Rust API gateway, keeping the SPA same-origin
# (HttpOnly session cookies work unchanged from the Next.js app).

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .
RUN bun run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
