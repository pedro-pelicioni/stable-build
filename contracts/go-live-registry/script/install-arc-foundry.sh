#!/usr/bin/env bash
# Download one Arc Foundry release, check its .sha256, and install
# arc-forge, arc-cast and arc-anvil into DEST (default: $HOME/.local/bin).
# Tag: STABLE_BUILD_FOUNDRY_TAG, default v0.8.0-2.
# https://docs.arc.io/arc/tutorials/install-arc-foundry
# https://github.com/circlefin/arc-foundry
set -euo pipefail

tag="${STABLE_BUILD_FOUNDRY_TAG:-v0.8.0-2}"
dest="${1:-${HOME}/.local/bin}"
repo="circlefin/arc-foundry"

case "$tag" in
  v[0-9]*) ;;
  *)
    echo "STABLE_BUILD_FOUNDRY_TAG must look like v0.8.0-2" >&2
    exit 1
    ;;
esac

os=$(uname -s)
arch=$(uname -m)
case "${os}:${arch}" in
  Linux:x86_64) target="x86_64-unknown-linux-gnu" ;;
  Linux:aarch64 | Linux:arm64) target="aarch64-unknown-linux-gnu" ;;
  Darwin:arm64 | Darwin:aarch64) target="aarch64-apple-darwin" ;;
  *)
    echo "no published Arc Foundry build for ${os} ${arch}" >&2
    echo "build from https://github.com/${repo}#building-from-source" >&2
    exit 1
    ;;
esac

name="arc-foundry-${tag}-${target}.tar.gz"
base="https://github.com/${repo}/releases/download/${tag}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL "${base}/${name}" -o "${work}/${name}"
curl -fsSL "${base}/${name}.sha256" -o "${work}/${name}.sha256"

want=$(awk 'NR == 1 { print $1 }' "${work}/${name}.sha256" | tr '[:upper:]' '[:lower:]')
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "${work}/${name}" | awk 'NR == 1 { print $1 }')
else
  got=$(shasum -a 256 "${work}/${name}" | awk 'NR == 1 { print $1 }')
fi
got=$(printf '%s' "$got" | tr '[:upper:]' '[:lower:]')
if [ "${#want}" -ne 64 ] || [ "$got" != "$want" ]; then
  echo "checksum mismatch for ${name}" >&2
  exit 1
fi

mkdir -p "${work}/x"
tar -xzf "${work}/${name}" -C "${work}/x"

src=""
if [ -f "${work}/x/forge" ] && [ -f "${work}/x/cast" ] && [ -f "${work}/x/anvil" ]; then
  src="${work}/x"
else
  for dir in "${work}/x"/*; do
    if [ -d "$dir" ] && [ -f "${dir}/forge" ] && [ -f "${dir}/cast" ] && [ -f "${dir}/anvil" ]; then
      src=$dir
      break
    fi
  done
fi
if [ -z "$src" ]; then
  echo "archive did not contain forge, cast and anvil" >&2
  exit 1
fi

mkdir -p "$dest"
for tool in forge cast anvil; do
  cp "${src}/${tool}" "${dest}/arc-${tool}"
  chmod 0755 "${dest}/arc-${tool}"
done

"${dest}/arc-forge" --version
printf '%s\n' "$dest"
