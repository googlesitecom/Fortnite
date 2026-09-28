#!/usr/bin/env bash
# Sincroniza el build jugable desde /web hacia /docs (carpeta publicada por GitHub Pages).
set -e
cd "$(dirname "$0")/.."
rm -rf docs
mkdir -p docs
cp -r web/index.html web/css web/js docs/
echo "docs/ actualizado desde web/"
