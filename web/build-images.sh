#!/usr/bin/env bash
# Genera las imágenes .tsl de la web (la web usa sus propias imágenes en
# Tesela). Los PNG originales se quedan al lado como respaldo (data-fallback y
# <noscript>), y solo se descargan si Tesela no funciona.
#   - Recortes de la galería: sin pérdida (se comparan píxel a píxel).
#   - Curvas de la documentación: con pérdida, la calidad más baja que da
#     SSIMULACRA2 ≥ 90 (`tesela compare`); sin pérdida ocupaban el doble.
# Requiere el binario: cargo build --release
set -euo pipefail
cd "$(dirname "$0")/.."
T=./target/release/tesela
for f in web/gallery/*.png; do
  "$T" encode "$f" "${f%.png}.tsl" --lossless
done
"$T" encode web/docs/img/curvas-capturas.png web/docs/img/curvas-capturas.tsl -q 88
"$T" encode web/docs/img/curvas-fotos-grandes.png web/docs/img/curvas-fotos-grandes.tsl -q 89
"$T" encode web/docs/img/curvas-ilustraciones.png web/docs/img/curvas-ilustraciones.tsl -q 89
"$T" encode web/docs/img/curvas-kodak.png web/docs/img/curvas-kodak.tsl -q 91
