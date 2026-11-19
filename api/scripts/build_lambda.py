"""Builds api/dist/lambda.zip: the one package all seven Lambdas share (docs/CONTRACTS.md §9, §14.10).

The zip holds ``clipfactory_api``, the locked boto3/botocore (vendored because the Lambda runtime's copy can be
too old to know "bedrock-agentcore", durable executions or "s3vectors"), the locked
``aws-durable-execution-sdk-python`` (AWS recommends bundling it rather than relying on the runtime's copy) and the
built-in skills from the repository's ``skills/`` folder as package
data (``clipfactory_api/builtin_skills/<name>/SKILL.md``) and ``config/platforms.json`` (the stats limits, §16.4) as
``clipfactory_api/config/platforms.json``, ``config/monetization.json`` (§25.2) next to it, and the help corpus the web build commits
(``web/src/features/help/help-corpus.json``, §19.6) as ``clipfactory_api/help/corpus.json``. Every dependency is pure Python, so the same zip runs on
arm64. The build is deterministic: same inputs, byte-identical zip (sorted entries, fixed timestamps and modes).

Run from anywhere:  uv run --project api python api/scripts/build_lambda.py   (needs uv)
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

API = Path(__file__).resolve().parents[1]
ROOT = API.parent
PACKAGE = API / "src" / "clipfactory_api"
SKILLS = ROOT / "skills"
PLATFORMS_CONFIG = ROOT / "config" / "platforms.json"
PLATFORMS_CONFIG_IN_ZIP = "clipfactory_api/config/platforms.json"
MONEY_CONFIG = ROOT / "config" / "monetization.json"
MONEY_CONFIG_IN_ZIP = "clipfactory_api/config/monetization.json"
HELP_CORPUS = ROOT / "web" / "src" / "features" / "help" / "help-corpus.json"
HELP_CORPUS_IN_ZIP = "clipfactory_api/help/corpus.json"
OUT = API / "dist" / "lambda.zip"
# Every Lambda handler module (docs/CONTRACTS.md §9): the build fails if one is missing from the zip.
HANDLERS = (
    "clipfactory_api/http.py",  # cf-prod-api
    "clipfactory_api/flows/job_flow.py",  # cf-prod-job-flow (durable)
    "clipfactory_api/flows/clip_flow.py",  # cf-prod-clip-flow (durable)
    "clipfactory_api/realtime/authorizer.py",  # cf-prod-ws-authorizer
    "clipfactory_api/realtime/ws.py",  # cf-prod-ws
    "clipfactory_api/realtime/broadcast.py",  # cf-prod-broadcast
    "clipfactory_api/hooks.py",  # cf-prod-hooks
    "clipfactory_api/stats/handler.py",  # cf-prod-stats (§16.5)
    "clipfactory_api/weekly.py",  # cf-prod-learn (§16.6)
    "clipfactory_api/money/handler.py",  # cf-prod-money (§25.6)
)
REQUIRED_PACKAGES = ("boto3==", "botocore==", "aws-durable-execution-sdk-python==")
VENDORED = ("boto3/__init__.py", "botocore/__init__.py", "aws_durable_execution_sdk_python/__init__.py")
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
COMPILED = {".so", ".pyd", ".dylib", ".dll"}


def _requirements() -> list[str]:
    exported = subprocess.run(
        ["uv", "export", "--frozen", "--no-dev", "--no-emit-project", "--no-hashes", "--no-header", "--no-annotate"],
        cwd=API,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [line.strip() for line in exported.splitlines() if line.strip() and not line.startswith("#")]


def _install(reqs: list[str], target: Path, scratch: Path) -> None:
    req_file = scratch / "requirements.txt"
    req_file.write_text("\n".join(reqs) + "\n")
    subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--quiet",
            "--requirement",
            str(req_file),
            "--target",
            str(target),
            "--python-platform",
            "aarch64-manylinux_2_28",  # Lambda python3.13 on arm64 (Amazon Linux 2023)
            "--python-version",
            "3.13",
            "--only-binary",
            ":all:",
            "--no-deps",
            "--no-compile",
        ],
        cwd=API,
        check=True,
    )


def _copy_skills(dest: Path) -> int:
    sys.path.insert(0, str(API / "src"))
    from clipfactory_api.skills import decode_text, read_frontmatter

    count = 0
    for skill_md in sorted(SKILLS.glob("*/SKILL.md")):
        meta = read_frontmatter(decode_text(skill_md.read_bytes()))  # a broken built-in fails the build
        target = dest / skill_md.parent.name / "SKILL.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(skill_md, target)
        print(f"  built-in skill: {meta.name}")
        count += 1
    return count


def _copy_platforms_config(dest: Path) -> None:
    """``config/platforms.json`` → ``clipfactory_api/config/platforms.json``, validated first (a bad edit fails the
    build, never a poll)."""
    if not PLATFORMS_CONFIG.is_file():
        raise SystemExit(f"missing {PLATFORMS_CONFIG.relative_to(ROOT)} (docs/CONTRACTS.md §16.4)")
    sys.path.insert(0, str(API / "src"))
    from clipfactory_api.stats import config

    cfg = config.load(PLATFORMS_CONFIG)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(PLATFORMS_CONFIG, dest)
    print(f"  platforms config: {len(cfg.platforms)} platforms, tick every {cfg.tick_minutes} minutes")


def _copy_money_config(dest: Path) -> None:
    """``config/monetization.json`` → ``clipfactory_api/config/monetization.json``, validated first: every goal must
    name its official source (docs/CONTRACTS.md §25.2), so an unsourced number fails the build."""
    if not MONEY_CONFIG.is_file():
        raise SystemExit(f"missing {MONEY_CONFIG.relative_to(ROOT)} (docs/CONTRACTS.md §25.2)")
    sys.path.insert(0, str(API / "src"))
    from clipfactory_api.money import rules

    cfg = rules.load(MONEY_CONFIG)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(MONEY_CONFIG, dest)
    print(f"  money config: {len(cfg.platforms)} platforms, checked {cfg.as_of.isoformat()}")


def _copy_help_corpus(dest: Path) -> None:
    """``web/src/features/help/help-corpus.json`` → ``clipfactory_api/help/corpus.json``, validated first (the
    bundled fallback of Ask Clip Factory, §19.6). A bad or missing corpus fails the build, never a question."""
    if not HELP_CORPUS.is_file():
        raise SystemExit(f"missing {HELP_CORPUS.relative_to(ROOT)} (docs/CONTRACTS.md §19.2; run the web build first)")
    sys.path.insert(0, str(API / "src"))
    from clipfactory_api.help import corpus

    try:
        parsed = corpus.parse(HELP_CORPUS.read_bytes())
    except corpus.CorpusError as e:
        raise SystemExit(f"{HELP_CORPUS.relative_to(ROOT)} is not a usable help corpus: {e}") from e
    if not parsed.docs:
        raise SystemExit(f"{HELP_CORPUS.relative_to(ROOT)} has no docs")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HELP_CORPUS, dest)
    print(f"  help corpus: {len(parsed.docs)} docs, version {parsed.version}")


def _zip(source: Path, out: Path) -> list[str]:
    files = sorted(
        p
        for p in source.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and p.suffix not in {".pyc", ".pyo"}
    )
    names = []
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            name = path.relative_to(source).as_posix()
            if path.suffix in COMPILED:
                raise SystemExit(f"compiled file in the package (must stay pure Python): {name}")
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # unix, so the mode above is honoured
            archive.writestr(info, path.read_bytes(), compresslevel=9)
            names.append(name)
    tmp.replace(out)
    return names


def main() -> int:
    reqs = _requirements()
    lowered = [r.lower() for r in reqs]
    absent = [p.rstrip("=") for p in REQUIRED_PACKAGES if not any(r.startswith(p) for r in lowered)]
    if absent:
        raise SystemExit(f"{', '.join(absent)} missing from the lock; run `uv lock` in api/")
    with tempfile.TemporaryDirectory(prefix="cf-lambda-") as tmp:
        scratch = Path(tmp)
        stage = scratch / "stage"
        stage.mkdir()
        _install(reqs, stage, scratch)
        shutil.copytree(PACKAGE, stage / "clipfactory_api", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        skills = _copy_skills(stage / "clipfactory_api" / "builtin_skills")
        _copy_platforms_config(stage / PLATFORMS_CONFIG_IN_ZIP)
        _copy_money_config(stage / MONEY_CONFIG_IN_ZIP)
        _copy_help_corpus(stage / HELP_CORPUS_IN_ZIP)
        names = _zip(stage, OUT)
    missing = [
        h
        for h in (*HANDLERS, *VENDORED, PLATFORMS_CONFIG_IN_ZIP, MONEY_CONFIG_IN_ZIP, HELP_CORPUS_IN_ZIP)
        if h not in names
    ]
    if missing:
        raise SystemExit(f"missing from the zip: {missing}")
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    print(
        f"built {OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1e6:.1f} MB, {len(names)} files, "
        f"{len(reqs)} dependencies, {skills} built-in skills, sha256 {digest[:16]}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
