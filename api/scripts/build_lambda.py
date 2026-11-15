"""Builds api/dist/lambda.zip: the one package all four Lambdas share (docs/CONTRACTS.md §9).

The zip holds ``clipfactory_api``, the locked boto3/botocore (vendored because the Lambda runtime's copy can be
too old to know "bedrock-agentcore") and the built-in skills from the repository's ``skills/`` folder as package
data (``clipfactory_api/builtin_skills/<name>/SKILL.md``). Every dependency is pure Python, so the same zip runs on
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
OUT = API / "dist" / "lambda.zip"
HANDLERS = (
    "clipfactory_api/http.py",
    "clipfactory_api/publisher.py",
    "clipfactory_api/perf_check.py",
    "clipfactory_api/watchdog.py",
)
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
    if not any(r.lower().startswith(("boto3==", "botocore==")) for r in reqs):
        raise SystemExit("boto3/botocore are missing from the lock; run `uv lock` in api/")
    with tempfile.TemporaryDirectory(prefix="cf-lambda-") as tmp:
        scratch = Path(tmp)
        stage = scratch / "stage"
        stage.mkdir()
        _install(reqs, stage, scratch)
        shutil.copytree(PACKAGE, stage / "clipfactory_api", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        skills = _copy_skills(stage / "clipfactory_api" / "builtin_skills")
        names = _zip(stage, OUT)
    missing = [h for h in HANDLERS if h not in names]
    if missing:
        raise SystemExit(f"handlers missing from the zip: {missing}")
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    print(
        f"built {OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1e6:.1f} MB, {len(names)} files, "
        f"{len(reqs)} dependencies, {skills} built-in skills, sha256 {digest[:16]}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
