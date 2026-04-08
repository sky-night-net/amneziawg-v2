# Stage 1: Build amneziawg-go (Userland engine v2.0)
FROM golang:alpine AS build_awg_go
RUN apk add --no-cache git make
RUN git clone https://github.com/amnezia-vpn/amneziawg-go.git /build
WORKDIR /build
RUN go mod download && \
    go build -v -o amneziawg-go

# Stage 2: Build amnezia-wg tools (wg utility)
FROM alpine:latest AS build_awg_tools
RUN apk add --no-cache git make build-base libmnl-dev linux-headers
RUN git clone https://github.com/amnezia-vpn/amnezia-wg.git /build_tools
WORKDIR /build_tools/src/tools
RUN make

# Stage 3: Build Web UI
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

# Copy AWG Binaries
COPY --from=build_awg_go /build/amneziawg-go /usr/bin/amneziawg-go
COPY --from=build_awg_tools /build_tools/src/tools/wg /usr/bin/awg

# WireGuard-compatibility symlinks
RUN ln -s /usr/bin/amneziawg-go /usr/bin/wireguard-go && \
    ln -s /usr/bin/awg /usr/bin/wg

# Copy Web UI & Node Modules
COPY --from=build_node_modules /app /app
COPY --from=build_node_modules /node_modules /node_modules

# Add custom amnezia-wg-quick wrapper if needed, or use standard wg-quick
# The amnezia-wg repo usually contains a patched wg-quick.
COPY --from=build_awg_tools /build_tools/src/tools/wg-quick/linux.bash /usr/bin/awg-quick
RUN chmod +x /usr/bin/awg-quick && \
    ln -s /usr/bin/awg-quick /usr/bin/wg-quick

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
