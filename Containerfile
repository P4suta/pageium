FROM docker.io/library/node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM docker.io/library/rust:1.100.0-trixie@sha256:223cc32ddca8f3ee90c436dbc94b6b5f052ea7f9653c5201e9612f08ad7d21b8 AS server
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN cargo build --release --locked --jobs 2

FROM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
COPY --from=server /build/target/release/pageium /usr/local/bin/pageium
COPY --from=web /build/dist /opt/pageium/web
RUN mkdir -p /books /state && chown 65532:65532 /state
USER 65532:65532
ENV PAGEIUM_BOOKS=/books PAGEIUM_STATE=/state PAGEIUM_WEB=/opt/pageium/web PAGEIUM_LISTEN=0.0.0.0:8787
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/pageium"]
