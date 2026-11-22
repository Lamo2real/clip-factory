"""Builds api/dist/lambda.zip: the one package all seven Lambdas share (docs/CONTRACTS.md §9, §14.10).

The zip holds ``clipfactory_api``, the locked boto3/botocore (vendored because the Lambda runtime's copy can be
too old to know "bedrock-agentcore", durable executions or "s3vectors"), the locked
``aws-durable-execution-sdk-python`` (AWS recommends bundling it rather than relying on the runtime's copy) and the
built-in skills from the repository's ``skills/`` folder as package
data (``clipfactory_api/builtin_skills/<name>/SKILL.md``) and ``config/platforms.json`` (the stats limits, §16.4) as
``clipfactory_api/config/platforms.json``, ``config/monetization.json`` (§25.2) next to it, Lamo Stories' own
configuration (the whole ``stories/config/`` folder: its checked driving-safety guidance, models, agents, workspace
defaults and resolver cases, §45.11.5, §45.25) as ``clipfactory_api/stories_config/`` and its built-in skills
(``stories/skills/<name>/SKILL.md``, §45.26) as ``clipfactory_api/stories_skills/``, each validated first, and the help
corpus the web build commits
(``web/src/features/help/help-corpus.json``, §19.6) as ``clipfactory_api/help/corpus.json``. Ask's knowledge pack and library
(``clipfactory_api/ask/knowledge.json`` and ``ask/library/*.md``, §28.2) are package files already. The Anthropic SDK
(``anthropic[bedrock]``, for Claude in Amazon Bedrock, §28.1) is vendored too; its two compiled dependencies
(``pydantic_core`` and ``jiter``) are installed as manylinux aarch64 wheels, the Lambdas' own platform, and are the only
compiled files allowed in the zip. The build is deterministic: same inputs, byte-identical zip (sorted entries, fixed timestamps and modes).

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
STORIES_CONFIG = ROOT / "stories" / "config"
STORIES_CONFIG_IN_ZIP = "clipfactory_api/stories_config"
STORIES_SKILLS = ROOT / "stories" / "skills"
STORIES_SKILLS_IN_ZIP = "clipfactory_api/stories_skills"
HELP_CORPUS = ROOT / "web" / "src" / "features" / "help" / "help-corpus.json"
HELP_CORPUS_IN_ZIP = "clipfactory_api/help/corpus.json"
OUT = API / "dist" / "lambda.zip"
# Every Lambda handler module (docs/CONTRACTS.md §9): the build fails if one is missing from the zip.
HANDLERS = (
    "clipfactory_api/http.py",  # cf-prod-api
    "clipfactory_api/flows/job_flow.py",  # cf-prod-job-flow (durable)
    "clipfactory_api/flows/clip_flow.py",  # cf-prod-clip-flow (durable)
    "clipfactory_api/flows/story_flow.py",  # cf-prod-story-flow (durable, §45.14)
    "clipfactory_api/workspaces/http.py",  # cf-prod-stories-api (Lamo Stories' own Lambda, §45.5)
    "clipfactory_api/realtime/authorizer.py",  # cf-prod-ws-authorizer
    "clipfactory_api/realtime/ws.py",  # cf-prod-ws
    "clipfactory_api/realtime/broadcast.py",  # cf-prod-broadcast
    "clipfactory_api/hooks.py",  # cf-prod-hooks
    "clipfactory_api/stats/handler.py",  # cf-prod-stats (§16.5)
    "clipfactory_api/weekly.py",  # cf-prod-learn (§16.6)
    "clipfactory_api/money/handler.py",  # cf-prod-money (§25.6)
    "clipfactory_api/autopost/handler.py",  # cf-prod-autopost (§46.11)
    "clipfactory_api/ask/worker.py",  # cf-prod-ask (§28.5)
    "clipfactory_api/push/notify.py",  # cf-prod-notify (§32.5)
)
REQUIRED_PACKAGES = ("boto3==", "botocore==", "aws-durable-execution-sdk-python==", "anthropic==", "cryptography==")
VENDORED = (
    "boto3/__init__.py",
    "botocore/__init__.py",
    "aws_durable_execution_sdk_python/__init__.py",
    "anthropic/__init__.py",
    "anthropic/lib/bedrock/__init__.py",
    "cryptography/hazmat/primitives/asymmetric/ec.py",
)
ASK_KNOWLEDGE_IN_ZIP = "clipfactory_api/ask/knowledge.json"
# The only packages that may carry compiled files, and only for Linux on arm64 (the Lambdas' platform).
# cryptography (with cffi) signs and encrypts Web Push messages (docs/CONTRACTS.md §32.4); its Rust module is one
# abi3 file whose name carries no platform, so its ELF header must say Linux on arm64 instead.
COMPILED_ALLOWED = ("pydantic_core/", "jiter/", "cryptography/", "_cffi_backend.")
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


def _check_stories_models(data: dict[str, object]) -> int:
    """``models.json``: every model has a key, a label, a model id and only known efforts; the defaults are listed."""
    efforts = {"low", "medium", "high", "xhigh", "max"}
    models = data.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("models must be a non-empty list")
    keys = []
    for n, m in enumerate(models):
        if not isinstance(m, dict) or not all(isinstance(m.get(k), str) and m[k] for k in ("key", "label", "modelId")):
            raise ValueError(f"models[{n}] needs a key, a label and a modelId")
        offered = m.get("efforts")
        if not isinstance(offered, list) or not set(offered) <= efforts:
            raise ValueError(f"models[{n}].efforts holds an unknown effort")
        keys.append(m["key"])
    if len(keys) != len(set(keys)):
        raise ValueError("two models share a key")
    if data.get("defaultModel") not in keys or data.get("defaultEffort") not in efforts:
        raise ValueError("defaultModel must be a listed model and defaultEffort a known effort")
    return len(keys)


def _check_stories_agents(data: dict[str, object]) -> int:
    """``agents.json``: the five built-in agents, each with its tasks and instructions."""
    wanted = {"creative_director", "video_analysis", "storyboard", "character", "quality_assurance"}
    agents = data.get("agents")
    if not isinstance(agents, list):
        raise ValueError("agents must be a list")
    found = set()
    for n, a in enumerate(agents):
        if not isinstance(a, dict) or not isinstance(a.get("instructions"), str) or not a.get("tasks"):
            raise ValueError(f"agents[{n}] needs instructions and tasks")
        found.add(a.get("agentId"))
    if found != wanted:
        raise ValueError(f"the agents must be exactly {sorted(wanted)}")
    return len(found)


def _copy_stories_config(dest: Path) -> list[str]:
    """``stories/config/*.json`` → ``clipfactory_api/stories_config/``, validated first: the guidance's every topic,
    step and dont names its checked sources (§45.11.5), the models and agents are usable (§45.25, §45.26), and every
    file is a JSON object, so a bad edit fails the build, never a request. Clip Factory's ``config/`` is not read."""
    import json

    sys.path.insert(0, str(API / "src"))
    from clipfactory_api.workspaces import config, guidance

    names = []
    for name in config.FILES:
        path = STORIES_CONFIG / name
        if not path.is_file():
            raise SystemExit(f"missing {path.relative_to(ROOT)} (docs/CONTRACTS.md §45.24)")
    for path in sorted(STORIES_CONFIG.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("it must hold one JSON object")
            if path.name == "guidance.json":
                parsed = guidance.parse(data)
                print(f"  stories guidance: {len(parsed.topics)} topics, {len(parsed.sources)} sources")
            elif path.name == "models.json":
                print(f"  stories models: {_check_stories_models(data)}")
            elif path.name == "agents.json":
                print(f"  stories agents: {_check_stories_agents(data)}")
        except (guidance.GuidanceError, ValueError) as e:
            raise SystemExit(f"{path.relative_to(ROOT)} is not usable: {e}") from e
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest / path.name)
        names.append(f"{STORIES_CONFIG_IN_ZIP}/{path.name}")
    return names


def _stories_skill_name(text: str) -> str:
    """The ``name`` of a Lamo Stories ``SKILL.md``: front matter between ``---`` lines with a name and a description."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---" or "---" not in [line.strip() for line in lines[1:]]:
        raise ValueError("it must start with front matter between two --- lines")
    end = [line.strip() for line in lines[1:]].index("---") + 1
    fields = {}
    for line in lines[1:end]:
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip().strip('"')
    if not fields.get("name") or not fields.get("description"):
        raise ValueError("its front matter needs a name and a description")
    return fields["name"]


def _copy_stories_skills(dest: Path) -> list[str]:
    """``stories/skills/<name>/**`` → ``clipfactory_api/stories_skills/<name>/``: Lamo Stories' built-in skills (never
    Clip Factory's ``skills/``), each with a readable ``SKILL.md`` whose front matter names it after its folder."""
    names = []
    for skill_md in sorted(STORIES_SKILLS.glob("*/SKILL.md")):
        folder = skill_md.parent
        try:
            name = _stories_skill_name(skill_md.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, ValueError) as e:
            raise SystemExit(f"{skill_md.relative_to(ROOT)} is not a usable skill: {e}") from e
        if name != folder.name:
            raise SystemExit(f"{skill_md.relative_to(ROOT)} is named {name}, not {folder.name}")
        for path in sorted(p for p in folder.rglob("*") if p.is_file()):
            target = dest / folder.name / path.relative_to(folder)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            names.append(f"{STORIES_SKILLS_IN_ZIP}/{folder.name}/{path.relative_to(folder).as_posix()}")
        print(f"  stories skill: {name}")
    if not names:
        raise SystemExit(f"no Lamo Stories skills in {STORIES_SKILLS.relative_to(ROOT)} (docs/CONTRACTS.md §45.26)")
    return names


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


ELF_AARCH64 = 183  # e_machine of an ELF file built for arm64


def _elf_aarch64(data: bytes) -> bool:
    """A 64-bit little-endian ELF file for arm64 (what an abi3 ``.so`` for Lambda on arm64 must be)."""
    return (
        data[:4] == b"\x7fELF"
        and data[4] == 2
        and data[5] == 1
        and int.from_bytes(data[18:20], "little") == ELF_AARCH64
    )


def _compiled_ok(name: str, data: bytes = b"") -> bool:
    """A compiled file is allowed only in ``COMPILED_ALLOWED`` and only when built for Linux on arm64."""
    if not (name.startswith(COMPILED_ALLOWED) and name.endswith(".so")):
        return False
    if name.endswith(".abi3.so"):
        return _elf_aarch64(data)
    return "aarch64-linux" in name


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
            if path.suffix in COMPILED and not _compiled_ok(name, path.read_bytes()):
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
        stories_files = _copy_stories_config(stage / STORIES_CONFIG_IN_ZIP)
        stories_files += _copy_stories_skills(stage / STORIES_SKILLS_IN_ZIP)
        _copy_help_corpus(stage / HELP_CORPUS_IN_ZIP)
        names = _zip(stage, OUT)
    missing = [
        h
        for h in (
            *HANDLERS,
            *VENDORED,
            PLATFORMS_CONFIG_IN_ZIP,
            MONEY_CONFIG_IN_ZIP,
            *stories_files,
            HELP_CORPUS_IN_ZIP,
            ASK_KNOWLEDGE_IN_ZIP,
        )
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
