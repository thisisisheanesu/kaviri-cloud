# The render image: one pinned browser, one pinned encoder, one recorder binary, and a
# font set chosen on purpose.
#
# This image is the sandbox a customer's script runs in, so it is built as one. It has no
# shell utilities it does not need, it runs as a non root user, and it expects to be
# started with a read only root filesystem and no capabilities. See docker/README.md for
# the run time half of that, which is the part that actually enforces it.
#
# Everything version bearing is an ARG, and docker/pins.env is where the resolved values
# live. An unpinned build still works, because a Dockerfile that refuses to build is a
# Dockerfile nobody runs, but it records what it resolved in /etc/kaviri-image.json and
# fails outright when REQUIRE_PINS is set, which is what CI sets.

# The base is pinned by digest rather than by tag, because debian:bookworm-slim is a moving
# target and "the image we tested" is a digest, not a name. Resolve it with
# docker/resolve-pins.sh and put it in docker/pins.env.
ARG BASE_IMAGE=debian:bookworm-slim
ARG RUST_IMAGE=rust:1-bookworm

# ---------------------------------------------------------------------------
# The recorder
# ---------------------------------------------------------------------------

FROM ${RUST_IMAGE} AS recorder

# A tag or a commit of the kaviri repository. A branch name would make the image's contents
# depend on when it was built, which is the thing this whole file is trying to avoid.
ARG KAVIRI_REPO=https://github.com/vamboai/kaviri.git
ARG KAVIRI_REF=main

WORKDIR /src
RUN git clone --depth 1 --branch "${KAVIRI_REF}" "${KAVIRI_REPO}" kaviri \
 && cd kaviri \
 && git rev-parse HEAD > /kaviri.sha

# --locked, so the build uses the lockfile the recorder's own CI tested rather than
# resolving fresh dependencies on the day the image happens to be built.
RUN cd kaviri && cargo build --release --locked && strip target/release/kaviri

# ---------------------------------------------------------------------------
# The runtime
# ---------------------------------------------------------------------------

FROM ${BASE_IMAGE}

ARG CHROMIUM_VERSION=
ARG FFMPEG_VERSION=
ARG REQUIRE_PINS=
ARG KAVIRI_REF=main

# DEBIAN_FRONTEND is scoped to this RUN rather than set as an ENV, so it does not leak into
# the environment a customer's Chromium inherits.
RUN set -eux; \
    if [ -n "${REQUIRE_PINS}" ] && { [ -z "${CHROMIUM_VERSION}" ] || [ -z "${FFMPEG_VERSION}" ]; }; then \
      echo "REQUIRE_PINS is set but CHROMIUM_VERSION or FFMPEG_VERSION is empty." >&2; \
      echo "Run docker/resolve-pins.sh and pass --build-arg for each." >&2; \
      exit 1; \
    fi; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install --no-install-recommends -y \
      "chromium${CHROMIUM_VERSION:+=${CHROMIUM_VERSION}}" \
      chromium-common \
      "ffmpeg${FFMPEG_VERSION:+=${FFMPEG_VERSION}}" \
      ca-certificates \
      fontconfig \
      util-linux \
      tzdata \
      \
      `# Fonts. See docker/README.md for why each of these is here and what it costs.` \
      fonts-dejavu-core \
      fonts-liberation2 \
      fonts-noto-core \
      fonts-noto-mono \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      ; \
    \
    `# Recorded so that a video that looks wrong can be traced to the exact browser and` \
    `# encoder that produced it, without rebuilding anything.` \
    printf '{"chromium":"%s","ffmpeg":"%s","kaviri_ref":"%s","built":"%s"}\n' \
      "$(dpkg-query -W -f='${Version}' chromium)" \
      "$(dpkg-query -W -f='${Version}' ffmpeg)" \
      "${KAVIRI_REF}" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > /etc/kaviri-image.json; \
    cat /etc/kaviri-image.json; \
    \
    apt-get purge -y --auto-remove; \
    rm -rf /var/lib/apt/lists/*

# Built once here rather than per container. With a read only root filesystem, a Chromium
# that had to build this cache would rebuild it on every take and write it to the tmpfs.
RUN fc-cache --force --system-only && fc-list | wc -l

COPY --from=recorder /src/kaviri/target/release/kaviri /usr/local/bin/kaviri
COPY --from=recorder /kaviri.sha /etc/kaviri-recorder-sha
COPY entrypoint.sh /usr/local/bin/kaviri-entrypoint

# A fixed uid, so the bind mounts the worker creates can be chowned without asking the
# image what it decided to call itself. 10001 is outside the range Debian hands out.
RUN set -eux; \
    chmod 0755 /usr/local/bin/kaviri-entrypoint; \
    groupadd --gid 10001 kaviri; \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin kaviri; \
    mkdir -p /work /spool; \
    chown 10001:10001 /work /spool

# The recorder autodetects a browser, and autodetection on a box is how you end up filming
# with something other than the browser you pinned.
ENV KAVIRI_CHROMIUM=/usr/bin/chromium \
    KAVIRI_FFMPEG=/usr/bin/ffmpeg \
    TMPDIR=/spool \
    HOME=/tmp

USER 10001:10001
WORKDIR /work

# The worker overrides the user, the mounts and the network. It does not override this: the
# entrypoint execs, so the SIGTERM that truncates a take reaches the recorder.
ENTRYPOINT ["/usr/local/bin/kaviri-entrypoint"]
CMD ["--help"]
