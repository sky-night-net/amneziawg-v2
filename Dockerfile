# Stage 1: Build amnezia-wg tools (wg utility)
FROM debian:bookworm-slim AS build_awg_tools
RUN apt-get update && apt-get install -y --no-install-recommends git make gcc libc6-dev pkg-config libmnl-dev
RUN git clone https://github.com/amnezia-vpn/amnezia-wg.git /build_tools
WORKDIR /build_tools/src/tools
RUN make

# Stage 2: Build amneziawg-go (Userland engine v2.0)
FROM golang:1.22-bookworm AS build_awg_go
RUN git clone https://github.com/amnezia-vpn/amneziawg-go.git /build
WORKDIR /build
RUN go build -v -o amneziawg-go

# Final Stage: Runtime
FROM node:18-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    iptables \
    iproute2 \
    procps \
    libmnl0 \
    && rm -rf /var/lib/apt/lists/*

# Copy binaries
COPY --from=build_awg_go /build/amneziawg-go /usr/bin/amneziawg-go
COPY --from=build_awg_tools /build_tools/src/tools/wg /usr/bin/awg

# Copy tools
COPY --from=build_awg_tools /build_tools/src/tools/wg-quick/linux.bash /usr/bin/awg-quick
RUN chmod +x /usr/bin/awg-quick && \
    ln -s /usr/bin/amneziawg-go /usr/bin/wireguard-go && \
    ln -s /usr/bin/awg /usr/bin/wg && \
    ln -s /usr/bin/awg-quick /usr/bin/wg-quick

# Use iptables-legacy wrapper for Docker compatibility
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy || true && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy || true

# Copy Web UI & Install Dependencies
COPY src /app
WORKDIR /app
RUN npm ci --omit=dev

# Copy the needed wg-password scripts
RUN cp /app/wgpw.sh /bin/wgpw && chmod +x /bin/wgpw

# Config default values
ENV DEBUG=Server,WireGuard
ENV WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go

EXPOSE 51821/tcp
EXPOSE 51820/udp
EXPOSE 161/tcp

CMD ["dumb-init", "node", "server.js"]
