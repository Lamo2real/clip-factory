# Lamo Stories' own AgentCore runtime image (docs/CONTRACTS.md §45.11.1, ADR-76). ARM64, plain HTTP on 8080.
# Build from the repository root:  docker build --platform linux/arm64 -f stories/agent/Dockerfile .
# Python 3.13, ffmpeg (Debian's, with libass), Inter (plus DejaVu for the bubble symbols ♫ and ♥, which Inter lacks),
# numpy, the Deno binary from its PyPI wheel, Clips Funded's own pinned yt-dlp (reference videos from a link, §45.40;
# never Clip Factory's cookies, proxy or tokens), the engine folder (web/src/stories/engine) and Lamo Stories' own
# config and skills. Nothing of Clip Factory's agent, skills or config is copied in. The build fails, not the first
# story, when ffmpeg has no libass, Inter is missing, yt-dlp does not run, the engine does not validate its sample under
# Deno, or the self-check (one frame drawn, one sound mastered, one caption burned in, config and skills loaded,
# yt-dlp's allowed extractors found without generic) does not pass.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY stories/agent/pyproject.toml stories/agent/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY stories/agent/src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim-bookworm
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-dejavu-core fontconfig ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && useradd --create-home --uid 1000 lamostories
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY stories/config /app/stories/config
COPY stories/skills /app/stories/skills
COPY web/src/stories/engine /app/stories-engine
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    CF_STORIES_CONFIG_DIR=/app/stories/config \
    CF_STORIES_SKILLS_DIR=/app/stories/skills \
    CF_STORIES_ENGINE_DIR=/app/stories-engine \
    CF_WORK_DIR=/tmp/ls-work \
    DENO_DIR=/tmp/ls-work/deno \
    DENO_NO_UPDATE_CHECK=1 \
    DENO_NO_PROMPT=1
RUN mkdir -p /tmp/ls-work && chown lamostories:lamostories /tmp/ls-work \
 && ffmpeg -hide_banner -filters | grep " ass " > /dev/null \
 && fc-list | grep -i "inter" > /dev/null \
 && deno --version > /dev/null \
 && yt-dlp --version > /dev/null \
 && uvicorn --version > /dev/null
USER lamostories
# The engine runs under Deno exactly as it will for a job (the same files the browser draws).
RUN mkdir -p /tmp/ls-work/deno \
 && deno run --allow-read /app/stories-engine/cli.ts validate /app/stories-engine/fixtures/sample-script.json | grep -q '"ok":true' \
 && python -m lamostories_agent.selfcheck | grep -q "stories self-check ok" \
 && rm -rf /tmp/ls-work/* && mkdir -p /tmp/ls-work/deno
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/ping').status==200 else 1)"
CMD ["uvicorn", "lamostories_agent.server:build_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--log-level", "warning"]
