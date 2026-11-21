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
COPY web/package.json web/package.json
COPY web/src/prepare-book-text.mts web/src/prepare-book-text.mts
RUN cargo build --release --locked --jobs 2

FROM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core fonts-noto-cjk libatomic1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /build/target/release/pageium /usr/local/bin/pageium
COPY --from=web /build/dist /opt/pageium/web
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /build/src/prepare-book-text.mts /build/src/find-book-matches.mts /opt/pageium/src/
COPY --from=web /build/node_modules/@napi-rs /opt/pageium/node_modules/@napi-rs
COPY --from=web /build/node_modules/pdfjs-dist/package.json /opt/pageium/node_modules/pdfjs-dist/
COPY --from=web /build/node_modules/pdfjs-dist/legacy/build/pdf.mjs /build/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs /opt/pageium/node_modules/pdfjs-dist/legacy/build/
COPY --from=web /build/node_modules/pdfjs-dist/legacy/web/pdf_viewer.mjs /opt/pageium/node_modules/pdfjs-dist/legacy/web/
RUN cd /opt/pageium/node_modules/pdfjs-dist \
    && ln -s /opt/pageium/web/pdfjs/cmaps /opt/pageium/web/pdfjs/standard_fonts /opt/pageium/web/pdfjs/wasm .
RUN mkdir -p /books /state && chown 65532:65532 /state
USER 65532:65532
ENV PAGEIUM_BOOKS=/books PAGEIUM_STATE=/state PAGEIUM_WEB=/opt/pageium/web PAGEIUM_LISTEN=0.0.0.0:8787
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/pageium"]
