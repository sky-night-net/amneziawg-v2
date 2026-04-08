# Stage 1: Build Web UI
FROM node:18-alpine AS build_node_modules
COPY src /app
WORKDIR /app
RUN npm ci --omit=dev && \
    mv node_modules /node_modules

# Final Stage: Runtime
FROM alpine:latest
RUN apk add --no-cache \
    dumb-init \
    iptables \
    nodejs \
    bash \
    iproute2 \
    procps

# Copy official AmneziaWG binaries for the target architecture
COPY --from=amneziavpn/amnezia-wg:latest /usr/bin/amneziawg-go /usr/bin/amneziawg-go
COPY --from=amneziavpn/amnezia-wg:latest /usr/bin/awg /usr/bin/awg
COPY --from=amneziavpn/amnezia-wg:latest /usr/bin/awg-quick /usr/bin/awg-quick

# WireGuard-compatibility symlinks (so wg-easy calls work seamlessly)
RUN ln -s /usr/bin/amneziawg-go /usr/bin/wireguard-go && \
    ln -s /usr/bin/awg /usr/bin/wg && \
    ln -s /usr/bin/awg-quick /usr/bin/wg-quick

# Copy Web UI & Node Modules
COPY --from=build_node_modules /app /app
COPY --from=build_node_modules /node_modules /node_modules

# Copy the needed wg-password scripts
COPY --from=build_node_modules /app/wgpw.sh /bin/wgpw
RUN chmod +x /bin/wgpw

# Use iptables-legacy (often needed in Docker)
RUN apk add --no-cache iptables-archive && \
    ln -sf /sbin/iptables-legacy /sbin/iptables && \
    ln -sf /sbin/ip6tables-legacy /sbin/ip6tables

# Set Environment
ENV DEBUG=Server,WireGuard
ENV WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go

# Run Web UI
WORKDIR /app
EXPOSE 51821/tcp
EXPOSE 51820/udp
EXPOSE 161/tcp

CMD ["/usr/bin/dumb-init", "node", "server.js"]
