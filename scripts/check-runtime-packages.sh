#!/bin/sh
# Verify OS package versions INSIDE the built production image (CI only — this
# script is NOT copied into the image; CI runs it against the image via
# `docker run`). Prints only package names + versions; never env or secrets.
#
# Fails (non-zero) if:
#   - architecture is not amd64
#   - libgnutls30 is missing or older than the fixed version
# An absent OPTIONAL package (e.g. libcap2) is reported, not treated as an error.
set -eu

MIN_GNUTLS="3.7.9-2+deb12u7"

echo "== CLUB-OPS image OS package check =="

arch="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
echo "architecture: ${arch}"
if [ "$arch" != "amd64" ]; then
  echo "ERROR: expected dpkg architecture amd64, got '${arch}'"
  exit 1
fi

# Report the versions of the scanner-flagged packages (name + version only).
for pkg in libgnutls30 libcap2 perl-base zlib1g; do
  ver="$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)"
  if [ -n "$ver" ]; then
    echo "${pkg} ${ver}"
  else
    echo "${pkg} (not installed)"
  fi
done

# Enforce the fixed libgnutls30 version (Critical CVE-2026-42010 / CVE-2026-33845).
cur="$(dpkg-query -W -f='${Version}' libgnutls30 2>/dev/null || true)"
if [ -z "$cur" ]; then
  echo "ERROR: libgnutls30 is not installed"
  exit 1
fi
if dpkg --compare-versions "$cur" ge "$MIN_GNUTLS"; then
  echo "OK: libgnutls30 ${cur} >= ${MIN_GNUTLS}"
else
  echo "ERROR: libgnutls30 ${cur} < required ${MIN_GNUTLS} (apt-get upgrade did not apply)"
  exit 1
fi

echo "== package check passed =="
