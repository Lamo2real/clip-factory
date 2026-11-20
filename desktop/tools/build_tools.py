#!/usr/bin/env python3
"""Builds the desktop app's signed tool manifest (docs/CONTRACTS.md §35.4, ADR-59).

The Mac and Windows app downloads yt-dlp, Deno and ffmpeg/ffprobe the first time it fetches a YouTube video itself
("Mac fetches it"). It never downloads them from upstream: CI copies the exact pinned files to our own CloudFront
(``downloads/tools/<tool>/<version>/<platform>/<name>``) and writes ``downloads/tools/tools.json`` plus
``tools.json.sig``, an ed25519 signature the app checks with the public key built into it.

Standard library only (plus the ``openssl`` command for signing), so the CI job installs nothing.

    build_tools.py fetch --lock tools.lock.json --out DIR --base-url https://<app host>/downloads/tools
        Downloads every pinned file, checks it against upstream's own published sum and against the lock, unpacks
        the zips, checks the unpacked file against the lock, lays the files out under DIR/files/... and writes
        DIR/tools.json. Any mismatch stops with exit code 1 and nothing is written.
    build_tools.py sign --manifest DIR/tools.json --key KEY.pem
        Writes DIR/tools.json.sig (base64 of the raw 64-byte ed25519 signature over the exact bytes of tools.json).
        The key never goes to stdout or a log.
    build_tools.py verify --manifest DIR/tools.json --pubkey BASE64
        Checks the signature with the public key (as the app does); used by CI right after signing.
    build_tools.py relock --lock tools.lock.json --cache DIR
        For a person bumping a version: fills in sizes and sums from files already downloaded into DIR.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

PLATFORMS = ("macos-aarch64", "macos-x86_64", "windows-x86_64")
TOOLS = ("yt-dlp", "deno", "ffmpeg", "ffprobe")
# Only these upstream hosts may be named in the lock (all on GitHub releases).
UPSTREAM = re.compile(r"^https://github\.com/(yt-dlp/yt-dlp|denoland/deno|eugeneware/ffmpeg-static)/releases/download/")
SAFE_PART = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
MANIFEST_SCHEMA = 1


class Mismatch(Exception):
    """A file does not match its pinned or published sum."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load_lock(path: Path) -> dict[str, Any]:
    lock = json.loads(path.read_text())
    check_lock(lock)
    return lock


def check_lock(lock: dict[str, Any]) -> None:
    """The lock's shape: every tool, every platform, https GitHub sources, plain file names, 64-hex sums."""
    if not isinstance(lock.get("serial"), int) or lock["serial"] < 1:
        raise ValueError("serial must be a positive whole number")
    tools = lock.get("tools")
    if not isinstance(tools, dict) or set(tools) != set(TOOLS):
        raise ValueError(f"tools must be exactly {TOOLS}")
    for name, tool in tools.items():
        if not SAFE_PART.match(str(tool.get("version", ""))):
            raise ValueError(f"{name}: bad version")
        files = tool.get("files")
        if not isinstance(files, dict) or set(files) != set(PLATFORMS):
            raise ValueError(f"{name}: files must cover {PLATFORMS}")
        for platform, f in files.items():
            if not UPSTREAM.match(str(f.get("url", ""))):
                raise ValueError(f"{name}/{platform}: url must be a pinned GitHub release download")
            if not SAFE_PART.match(str(f.get("name", ""))):
                raise ValueError(f"{name}/{platform}: bad file name")
            for key in ("sha256", "file_sha256"):
                if key in f and not HEX64.match(str(f[key])):
                    raise ValueError(f"{name}/{platform}: {key} must be 64 hex characters")
            if "extract" in f and not SAFE_PART.match(str(f["extract"])):
                raise ValueError(f"{name}/{platform}: bad extract name")


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "clip-factory-tools-ci"})
    with urllib.request.urlopen(req, timeout=120) as r, dest.open("wb") as f:  # noqa: S310 (https GitHub only)
        shutil.copyfileobj(r, f, 1 << 20)


def upstream_sums(url: str, cache: dict[str, dict[str, str]]) -> dict[str, str]:
    """Upstream's own published sums for the release ``url`` belongs to: yt-dlp's SHA2-256SUMS and Deno's
    per-asset .sha256sum files. ffmpeg-static publishes none; its assets are checked against the lock only."""
    if "/yt-dlp/yt-dlp/" in url:
        sums_url = url.rsplit("/", 1)[0] + "/SHA2-256SUMS"
        if sums_url not in cache:
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / "sums"
                download(sums_url, p)
                cache[sums_url] = {
                    parts[1].lstrip("*"): parts[0].lower()
                    for line in p.read_text().splitlines()
                    if len(parts := line.split()) == 2
                }
        return cache[sums_url]
    if "/denoland/deno/" in url:
        sums_url = url + ".sha256sum"
        if sums_url not in cache:
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / "sum"
                download(sums_url, p)
                found = re.search(r"\b([0-9a-fA-F]{64})\b", p.read_text())
                cache[sums_url] = {url.rsplit("/", 1)[1]: found.group(1).lower()} if found else {}
        return cache[sums_url]
    return {}


def checked(path: Path, want: str, what: str) -> None:
    got = sha256_file(path)
    if got != want:
        raise Mismatch(f"{what}: sha256 {got} is not the pinned {want}")


def fetch(lock: dict[str, Any], out: Path, base_url: str, cache_dir: Path | None = None) -> dict[str, Any]:
    """Downloads, checks and lays out every file; returns the manifest (also written to out/tools.json)."""
    if not re.match(r"^https://[A-Za-z0-9.-]+/downloads/tools$", base_url):
        raise ValueError("base url must be https://<host>/downloads/tools")
    sums: dict[str, dict[str, str]] = {}
    staged = out / "files"
    manifest_tools: dict[str, Any] = {}
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        for name in TOOLS:
            tool = lock["tools"][name]
            version = tool["version"]
            entries: dict[str, Any] = {}
            for platform in PLATFORMS:
                f = tool["files"][platform]
                asset = f["url"].rsplit("/", 1)[1]
                raw = (cache_dir / asset) if cache_dir and (cache_dir / asset).is_file() else tmp / f"{name}-{platform}"
                if not raw.is_file():
                    download(f["url"], raw)
                published = upstream_sums(f["url"], sums).get(asset)
                if published is not None and published != f["sha256"]:
                    raise Mismatch(f"{name}/{platform}: upstream publishes {published}, the lock pins {f['sha256']}")
                checked(raw, f["sha256"], f"{name}/{platform} download")
                rel = f"{name}/{version}/{platform}/{f['name']}"
                dest = staged / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if "extract" in f:
                    with zipfile.ZipFile(raw) as z:
                        member = next((m for m in z.infolist() if m.filename == f["extract"]), None)
                        if member is None:
                            raise Mismatch(f"{name}/{platform}: {f['extract']} is not in the zip")
                        with z.open(member) as src, dest.open("wb") as dst:
                            shutil.copyfileobj(src, dst, 1 << 20)
                    checked(dest, f["file_sha256"], f"{name}/{platform} unpacked")
                else:
                    shutil.copyfile(raw, dest)
                os.chmod(dest, 0o755)
                entries[platform] = {
                    "url": f"{base_url}/{rel}",
                    "sha256": sha256_file(dest),
                    "size": dest.stat().st_size,
                }
            manifest_tools[name] = {"version": version, "files": entries}
    manifest = {"schema": MANIFEST_SCHEMA, "serial": lock["serial"], "lock": lock_hash(lock), "tools": manifest_tools}
    (out / "tools.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    return manifest


def lock_hash(lock: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(lock, sort_keys=True).encode()).hexdigest()[:32]


def sign(manifest: Path, key: Path, openssl: str = "openssl") -> Path:
    sig_raw = manifest.with_suffix(".json.sig.raw")
    # -rawin: pure ed25519 over the message bytes. stdout/stderr are captured, so nothing about the key is printed.
    subprocess.run(  # noqa: S603
        [openssl, "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(manifest), "-out", str(sig_raw)],
        check=True,
        capture_output=True,
    )
    raw = sig_raw.read_bytes()
    sig_raw.unlink()
    if len(raw) != 64:
        raise Mismatch("the signature is not 64 bytes (is the key ed25519?)")
    out = manifest.with_name(manifest.name + ".sig")
    out.write_text(base64.b64encode(raw).decode() + "\n")
    return out


def verify(manifest: Path, pubkey_b64: str, openssl: str = "openssl") -> None:
    """Checks tools.json.sig with the raw 32-byte public key (base64), the same check the app makes."""
    raw_pub = base64.b64decode(pubkey_b64)
    if len(raw_pub) != 32:
        raise Mismatch("the public key is not 32 bytes")
    # SubjectPublicKeyInfo for ed25519: a fixed 12-byte prefix, then the key.
    der = bytes.fromhex("302a300506032b6570032100") + raw_pub
    sig = base64.b64decode(manifest.with_name(manifest.name + ".sig").read_text().strip())
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        (tmp / "pub.der").write_bytes(der)
        (tmp / "sig").write_bytes(sig)
        r = subprocess.run(  # noqa: S603
            [openssl, "pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER", "-inkey", str(tmp / "pub.der"),
             "-in", str(manifest), "-sigfile", str(tmp / "sig")],
            capture_output=True,
            text=True,
        )
    if r.returncode != 0:
        raise Mismatch("the manifest signature does not verify with the app's public key")


def relock(lock_path: Path, cache: Path) -> None:
    lock = json.loads(lock_path.read_text())
    for tool in lock["tools"].values():
        for f in tool["files"].values():
            raw = cache / f["url"].rsplit("/", 1)[1]
            f["sha256"] = sha256_file(raw)
            f["size"] = raw.stat().st_size
            if "extract" in f:
                with zipfile.ZipFile(raw) as z, tempfile.TemporaryDirectory() as tmp:
                    p = Path(z.extract(f["extract"], tmp))
                    f["file_sha256"] = sha256_file(p)
                    f["file_size"] = p.stat().st_size
    check_lock(lock)
    lock_path.write_text(json.dumps(lock, indent=2) + "\n")


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--lock", type=Path, required=True)
    f.add_argument("--out", type=Path, required=True)
    f.add_argument("--base-url", required=True)
    f.add_argument("--cache", type=Path)
    s = sub.add_parser("sign")
    s.add_argument("--manifest", type=Path, required=True)
    s.add_argument("--key", type=Path, required=True)
    v = sub.add_parser("verify")
    v.add_argument("--manifest", type=Path, required=True)
    v.add_argument("--pubkey", required=True)
    r = sub.add_parser("relock")
    r.add_argument("--lock", type=Path, required=True)
    r.add_argument("--cache", type=Path, required=True)
    h = sub.add_parser("lock-hash")
    h.add_argument("--lock", type=Path, required=True)
    args = p.parse_args(argv)
    try:
        if args.cmd == "fetch":
            args.out.mkdir(parents=True, exist_ok=True)
            m = fetch(load_lock(args.lock), args.out, args.base_url, args.cache)
            print(f"tools.json: serial {m['serial']}, " + ", ".join(f"{k} {t['version']}" for k, t in m["tools"].items()))
        elif args.cmd == "sign":
            print(f"wrote {sign(args.manifest, args.key).name}")
        elif args.cmd == "verify":
            verify(args.manifest, args.pubkey)
            print("signature ok")
        elif args.cmd == "relock":
            relock(args.lock, args.cache)
        elif args.cmd == "lock-hash":
            print(lock_hash(load_lock(args.lock)))
    except (Mismatch, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
