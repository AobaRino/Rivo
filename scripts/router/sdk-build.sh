#!/bin/sh
# Run inside the official ImmortalWrt 25.12 x86/64 SDK after copying the prepared
# package into package/mihomo-manager. No source or toolchains are downloaded here.
set -eu
[ -f rules.mk ] && [ -d staging_dir ] || { echo 'Run from the SDK root' >&2; exit 1; }
[ -s package/mihomo-manager/prebuilt/mihomo-manager ] || exit 1
cat >> .config <<'EOF'
# CONFIG_ALL is not set
# CONFIG_ALL_KMODS is not set
# CONFIG_ALL_NONSHARED is not set
CONFIG_SIGNED_PACKAGES=y
CONFIG_PACKAGE_mihomo-manager=m
CONFIG_PACKAGE_luci-app-mihomo-manager=m
EOF
make defconfig
make package/mihomo-manager/clean
# This package only installs the prebuilt Go binary and static assets. Runtime
# dependencies are resolved by apk on the target, not rebuilt into this bundle.
make package/mihomo-manager/compile NO_DEPS=1 V=s -j2

# Package compilation produces unsigned APKs; sign explicitly, then install the
# same public key in the isolated test firmware. Installation requires trust.
key="${MIHOMO_SIGNING_KEY:-$PWD/key-mihomo-manager.pem}"
if [ ! -f "$key" ]; then
	(umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$key")
fi
mkdir -p bin/mihomo-manager
rm -f bin/mihomo-manager/*.apk
openssl pkey -in "$key" -pubout -out bin/mihomo-manager/mihomo-manager.pem
for package in bin/packages/x86_64/base/mihomo-manager-*.apk bin/packages/x86_64/base/luci-app-mihomo-manager-*.apk; do
	cp "$package" bin/mihomo-manager/
	# Unsigned input is accepted only here, while signing our own build output.
	staging_dir/host/bin/apk adbsign --allow-untrusted --sign-key "$key" "bin/mihomo-manager/$(basename "$package")"
	staging_dir/host/bin/apk verify --keys-dir "$PWD/bin/mihomo-manager" "bin/mihomo-manager/$(basename "$package")"
done
(cd bin/mihomo-manager && sha256sum ./*.apk mihomo-manager.pem > SHA256SUMS)
