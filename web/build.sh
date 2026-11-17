#!/usr/bin/env bash
# Compila los módulos WebAssembly de Tesela:
#   web/tesela.wasm      un hilo, completo (decodificar, codificar y métricas)
#   web/tesela-mt.wasm   con hilos, para codificar en páginas aisladas
#   web/tesela-dec.wasm  un hilo, solo decodifica (el de tesela-lite.js)
# Requiere: rustup target add wasm32-unknown-unknown wasm32-wasip1-threads
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown --lib --no-default-features --features encoder,metrics
cp target/wasm32-unknown-unknown/release/tesela.wasm web/tesela.wasm
cargo build --release --target wasm32-wasip1-threads --lib --no-default-features --features encoder,metrics
cp target/wasm32-wasip1-threads/release/tesela.wasm web/tesela-mt.wasm
# Sin «encoder» ni «metrics»: solo las funciones de decodificación, y sin la
# sección de nombres (strip). Se compila en otro directorio para no pisar el
# módulo completo (mismo nombre de salida).
cargo build --release --target wasm32-unknown-unknown --lib --no-default-features \
  --config profile.release.strip=true --target-dir target/dec
cp target/dec/wasm32-unknown-unknown/release/tesela.wasm web/tesela-dec.wasm
ls -la web/tesela.wasm web/tesela-mt.wasm web/tesela-dec.wasm
