set positional-arguments
export PLAYWRIGHT_BROWSERS_PATH := justfile_directory() / ".local/playwright"

default:
    @just --list

build:
    npm --prefix web ci --no-audit --no-fund
    npm --prefix web run build
    cargo build --locked

serve books:
    cargo run --locked -- --books "$1"

browser: build
    npm --prefix web exec -- playwright install chromium webkit
    npm --prefix web test

audit: build
    npm --prefix web exec -- playwright install chromium
    npm --prefix web run audit

verification-image:
    docker build --file verification/Containerfile --tag pageium-verification:local .

proofs: verification-image
    dotfiles bounded run --image "$(docker image inspect --format '{{{{.Id}}' pageium-verification:local)" --project . -- bash -euo pipefail -c 'cargo kani setup --use-local-bundle /opt/kani-bundle.tar.gz && mkdir -p /tmp/pageium-proof/src /tmp/pageium-proof/verification && cp src/range.rs /tmp/pageium-proof/src/ && cp verification/range_contracts.rs /tmp/pageium-proof/verification/ && cd /tmp/pageium-proof && kani verification/range_contracts.rs | awk "/Checking harness|cover properties satisfied|successfully verified harnesses/ {print} /2 of 2 cover properties satisfied/ {covered++} /3 successfully verified harnesses, 0 failures, 3 total/ {verified=1} END {exit !(covered==3&&verified)}"'

mutants: verification-image
    dotfiles bounded run --image "$(docker image inspect --format '{{{{.Id}}' pageium-verification:local)" --project . -- cargo mutants --jobs 1 --timeout 20 --build-timeout 120 --no-shuffle --output /tmp

check:
    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked
    npm --prefix web run check
    biome ci web/src web/tests web/audits web/vite.config.ts web/playwright.config.ts web/package.json web/tsconfig.json
    npm --prefix web audit --audit-level=high
    gitleaks dir --redact --no-banner

advisories:
    cargo deny check advisories
