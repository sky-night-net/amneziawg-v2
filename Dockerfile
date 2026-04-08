# Stage 1: Build amneziawg-tools (awg, awg-quick)
FROM debian:bookworm-slim AS build_awg_tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git make gcc libc6-dev pkg-config libmnl-dev ca-certificates
RUN git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-tools.git /build_tools
WORKDIR /build_tools/src
RUN make

# Stage 2: Build amneziawg-go (userspace WireGuard engine)
FROM golang:1.24-bookworm AS build_awg_go
RUN git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-go.git /build
WORKDIR /build
RUN go build -v -o amneziawg-go

# Final Stage: Runtime
FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    iptables \
    iproute2 \
    procps \
    bash \
    curl \
    ca-certificates \
    libmnl0 \
    tcpdump \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled binaries
COPY --from=build_awg_go /build/amneziawg-go /usr/bin/amneziawg-go
COPY --from=build_awg_tools /build_tools/src/wg /usr/bin/awg
COPY --from=build_awg_tools /build_tools/src/wg-quick/linux.bash /usr/bin/awg-quick
RUN chmod +x /usr/bin/awg /usr/bin/awg-quick /usr/bin/amneziawg-go

# Compatibility symlinks
RUN ln -s /usr/bin/amneziawg-go /usr/bin/wireguard-go && \
    ln -s /usr/bin/awg /usr/bin/wg && \
    ln -s /usr/bin/awg-quick /usr/bin/wg-quick

# Use iptables-legacy for Docker compatibility
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy || true && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy || true

# Set WG_PATH to AmneziaWG standard
ENV WG_PATH=/etc/amnezia/amneziawg
RUN mkdir -p /etc/amnezia/amneziawg

# Copy Web UI & install dependencies
COPY src /app
WORKDIR /app
RUN npm ci --omit=dev

# Password helper script
RUN cp /app/wgpw.sh /bin/wgpw && chmod +x /bin/wgpw

# Environment
ENV DEBUG=Server,WireGuard
ENV WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go

EXPOSE 51821/tcp
EXPOSE 51820/udp
EXPOSE 161/tcp

CMD ["dumb-init", "node", "server.js"]
