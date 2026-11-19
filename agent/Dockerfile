# Clip Factory agent: the AgentCore Runtime image (ARM64, plain HTTP on 8080, docs/CONTRACTS.md §8).
# Build from the repo root:  docker build --platform linux/arm64 -f agent/Dockerfile .
# Python 3.13 + the Claude Agent SDK (its wheel bundles the Claude Code CLI) + yt-dlp with Deno, the JavaScript
# runtime yt-dlp needs for YouTube (Deno's official binary, installed from its PyPI wheel and pinned in uv.lock).
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv
# Build the venv at the path it runs from: uv writes absolute shebangs (#!/app/.venv/bin/python) into bin/uvicorn and
# bin/yt-dlp, so a venv built elsewhere and copied to /app would point at a Python that does not exist.
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY agent/pyproject.toml agent/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY agent/src ./src
RUN uv sync --frozen --no-dev --no-editable

# The PO token server (docs/CONTRACTS.md §29.2): bgutil-ytdlp-pot-provider's server, the same version as the plugin
# pinned in pyproject.toml (bump both together). The tag tarball is pinned by its sha256; if GitHub ever regenerates
# it, switch to the archive of the tag's commit (26475e9d3665b972c4aeb83b4dbaafcf64b88438). npm ci builds node_modules
# (node-canvas's arm64 prebuild) the way upstream's own Dockerfile does; Deno then caches every module, so the runtime
# never reaches npm.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:24-bookworm-slim AS pot
ARG BGUTIL_VERSION=2.0.2
ARG BGUTIL_SHA256=1f2ae9ec39405b8e80397dfc2551f58deed09d8dff4b2b8fbc314df8e091c0a1
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.venv/bin/deno /usr/local/bin/deno
WORKDIR /opt/bgutil
RUN curl -fsSL -o /tmp/bgutil.tar.gz \
      "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz" \
 && echo "${BGUTIL_SHA256}  /tmp/bgutil.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/bgutil.tar.gz --strip-components=1 -C /opt/bgutil "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}/server" \
 && rm /tmp/bgutil.tar.gz
WORKDIR /opt/bgutil/server
ENV DENO_DIR=/opt/bgutil/deno-cache DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1
RUN npm ci --omit=dev --no-audit --no-fund \
 && deno cache --frozen src/main.ts src/generate_once.ts \
 && rm -rf /root/.npm

FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim-bookworm
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# ffmpeg: Debian's build has libass (subtitles) and drawtext. fonts-inter: captions and hooks. fonts-croscore: Tinos,
# the serif stand-in for Times New Roman. No AWS CLI and no shell tools for the model: the agent only cuts clips.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-croscore fontconfig ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && useradd --create-home --uid 1000 clipfactory
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY config /app/config
COPY skills /app/skills
COPY --from=pot /opt/bgutil /opt/bgutil
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    CF_CONFIG_DIR=/app/config \
    CF_SKILLS_DIR=/app/skills \
    CF_WORK_DIR=/tmp/cf-work \
    CLAUDE_CODE_USE_BEDROCK=1 \
    CLAUDE_CODE_DISABLE_1M_CONTEXT=1 \
    CF_POT_HOME=/opt/bgutil/server \
    DENO_DIR=/opt/bgutil/deno-cache \
    DENO_NO_UPDATE_CHECK=1 \
    DENO_NO_PROMPT=1
# The build fails here, not at the first job, if libass, Inter, Deno, yt-dlp, the PO token plugin or its server is
# missing: yt-dlp -v lists the bgutil providers, and the server must answer /ping.
RUN mkdir -p /tmp/cf-work && chown clipfactory:clipfactory /tmp/cf-work \
 && ffmpeg -hide_banner -filters | grep " ass " > /dev/null \
 && fc-list | grep -i "inter" > /dev/null \
 && deno --version > /dev/null \
 && yt-dlp --version > /dev/null \
 && python -c "import yt_dlp_plugins.extractor.getpot_bgutil_http, yt_dlp_plugins.extractor.getpot_bgutil_script" \
 && python -m clipfactory_agent.pot \
 && uvicorn --version > /dev/null
USER clipfactory
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/ping').status==200 else 1)"
CMD ["uvicorn", "clipfactory_agent.server:build_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--log-level", "warning"]
