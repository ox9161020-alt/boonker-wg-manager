FROM node:20-alpine

RUN apk add --no-cache wireguard-tools

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY server.js ./
COPY src/ ./src/

# Must run as root: reads /etc/wireguard/wg0.conf (root:root 600) and
# runs wg/ip commands that require CAP_NET_ADMIN — already granted in
# docker-compose (cap_add: NET_ADMIN, network_mode: host).
EXPOSE 3000

CMD ["node", "server.js"]
