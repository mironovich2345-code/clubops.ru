# CLUB-OPS — Container image security

The production image is `node:20-bookworm-slim` (Node 20 LTS, Debian 12
"Bookworm"), single-arch **linux/amd64**. Node 20 + Bookworm are pinned
deliberately (no Alpine/Distroless/Trixie migration) to minimise compatibility
risk with the Prisma engine and the PDF/AI pipeline.

## How security updates are applied

The **shipped** `runner` stage runs, on every production build:

```dockerfile
ARG APT_REFRESH=none
RUN echo "APT refresh: ${APT_REFRESH}" >/dev/null \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
```

- `APT_REFRESH` is a **non-secret** per-build value (the commit SHA, set by CI as
  `--build-arg APT_REFRESH=${{ github.sha }}`). Its only job is to invalidate this
  layer every build so `apt-get update && upgrade` never serves stale package
  lists from the Docker/BuildKit cache.
- CI also builds with `--pull` so the Debian/Node base is refreshed each time.
- The build layers (`base`/`deps`/`builder`) are not shipped; only `runner` is
  security-upgraded, which keeps the app + npm cache layers cacheable.
- `wget`/`curl` are **not installed** (the healthcheck uses Node's `http`
  module), reducing the image's package surface. Only `openssl` (libssl3, for the
  Prisma query engine) and `ca-certificates` (TLS) are added.

## CI enforcement

After building the exact image (loaded locally), CI runs
`scripts/check-runtime-packages.sh` inside it (`docker run`, script bind-mounted,
**not** baked into the image). The build **fails before publishing** if:

- `dpkg --print-architecture` ≠ `amd64`, or
- `libgnutls30` < `3.7.9-2+deb12u7` (i.e. the security upgrade did not apply).

Only after this check passes is the image pushed (`:${sha}` and `:main`).

## Findings resolved by the upgrade

| Package | Was | Fixed in | CVEs |
|---|---|---|---|
| `libgnutls30` | 3.7.9-2+deb12u6 | 3.7.9-2+deb12u7 | CVE-2026-42010, CVE-2026-33845 (Critical) + related High |
| `libcap2` | 1:2.66-4+deb12u2+b2 | 1:2.66-4+deb12u3 | High |
| others (`dpkg`, …) | — | latest Bookworm | via `apt-get upgrade` |

These are pulled by `apt-get upgrade -y` and enforced (for libgnutls30) by the CI
check. libcap2 (if present) upgrades with everything else.

## Documented scanner findings (verified applicability)

These are **not** claimed to be unconditionally safe — they are scanner findings
whose applicability to this image has been assessed. Re-evaluate on any change to
the base image, architecture, runtime packages, or archive-handling code.

### A. CVE-2026-8376 — `perl-base` 5.36.0-7+deb12u3
- Debian scopes the exploit scenario to **32-bit Perl**.
- This production image is **linux/amd64 (64-bit)**.
- **Assessment:** not applicable to the amd64 image. **Re-evaluate if the image
  architecture ever changes** (e.g. arm/32-bit). No fixed Bookworm version is
  required for amd64 at this time.

### B. CVE-2026-42496 — `perl-base` 5.36.0-7+deb12u3
- Relates to Perl **`Archive::Tar`** unpacking of **untrusted archives**.
- CLUB-OPS does **not** use Perl or `Archive::Tar`, and does not unpack
  untrusted archives with Perl. (Document uploads are images/PDF handled by the
  Node app; xlsx import is handled by the JS `xlsx` library, not Perl.)
- Debian does **not yet provide** a fixed Bookworm version.
- **Assessment:** present in the OS package but not reachable by the app. **Re-check
  when Debian ships a fix** (it will land via `apt-get upgrade`) and if the app
  ever adds archive extraction.

### C. CVE-2023-45853 — `zlib1g` 1:1.2.13.dfsg-1
- Relates to the **MiniZip** code in the zlib source tree.
- Debian marks this as **not-affected for Bookworm**: the vulnerable MiniZip code
  is **not built** into the `zlib1g` binary package (it is a `src:zlib` finding).
- **Assessment:** the scanner may keep reporting it against `zlib1g`, but the
  vulnerable code is not present in the shipped binary. **Re-check if zlib's
  packaging changes.**

## Policy

- A **new, fixable Critical** CVE **blocks production deployment** — bump
  `APT_REFRESH` / rebuild so `apt-get upgrade` applies the fix; the CI check must
  pass before publish.
- **Unfixable** findings require an applicability analysis documented here.
- These exceptions are **reviewed whenever** any of the following changes: base
  image, CPU architecture, installed runtime packages, or how the app handles
  archives/untrusted input.
