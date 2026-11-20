"""Tests for build_tools.py (docs/CONTRACTS.md §35.4). No network: the real lock is checked for shape, and signing is
tested with a throwaway key. Run: python3 desktop/tools/test_build_tools.py"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_tools as bt  # noqa: E402


def openssl_key(path: Path) -> str:
    """A throwaway ed25519 key in ``path``; returns its raw public key, base64."""
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(path)], check=True, capture_output=True)
    der = subprocess.run(
        ["openssl", "pkey", "-in", str(path), "-pubout", "-outform", "DER"], check=True, capture_output=True
    ).stdout
    import base64

    return base64.b64encode(der[-32:]).decode()


class LockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.lock = json.loads((HERE / "tools.lock.json").read_text())

    def test_the_committed_lock_is_complete(self) -> None:
        bt.check_lock(self.lock)
        for tool in self.lock["tools"].values():
            for f in tool["files"].values():
                self.assertRegex(f["sha256"], r"^[0-9a-f]{64}$")
                self.assertGreater(f["size"], 0)
                if "extract" in f:
                    self.assertRegex(f["file_sha256"], r"^[0-9a-f]{64}$")

    def test_the_yt_dlp_pin_matches_the_cloud_agent(self) -> None:
        pyproject = (HERE.parent.parent / "agent" / "pyproject.toml").read_text()
        self.assertIn(f'yt-dlp[default,deno]=={self.lock["tools"]["yt-dlp"]["version"]}"', pyproject)

    def test_only_pinned_github_releases_and_plain_names(self) -> None:
        for bad_url in (
            "https://evil.test/yt-dlp",
            "http://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp_macos",
            "https://github.com/someone/else/releases/download/x/a",
        ):
            lock = copy.deepcopy(self.lock)
            lock["tools"]["yt-dlp"]["files"]["macos-aarch64"]["url"] = bad_url
            with self.assertRaises(ValueError):
                bt.check_lock(lock)
        lock = copy.deepcopy(self.lock)
        lock["tools"]["deno"]["files"]["macos-aarch64"]["name"] = "../deno"
        with self.assertRaises(ValueError):
            bt.check_lock(lock)
        lock = copy.deepcopy(self.lock)
        del lock["tools"]["ffprobe"]
        with self.assertRaises(ValueError):
            bt.check_lock(lock)

    def test_the_lock_hash_changes_with_any_pin(self) -> None:
        lock = copy.deepcopy(self.lock)
        lock["tools"]["yt-dlp"]["version"] = "2099.1.1"
        self.assertNotEqual(bt.lock_hash(lock), bt.lock_hash(self.lock))


class SignTests(unittest.TestCase):
    def test_sign_then_verify_and_refuse_a_change_or_another_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_name:
            tmp = Path(tmp_name)
            manifest = tmp / "tools.json"
            manifest.write_text('{"schema": 1, "serial": 1, "tools": {}}\n')
            pub = openssl_key(tmp / "key.pem")
            other = openssl_key(tmp / "other.pem")
            bt.sign(manifest, tmp / "key.pem")
            bt.verify(manifest, pub)
            with self.assertRaises(bt.Mismatch):
                bt.verify(manifest, other)
            manifest.write_text('{"schema": 1, "serial": 2, "tools": {}}\n')
            with self.assertRaises(bt.Mismatch):
                bt.verify(manifest, pub)

    def test_a_file_that_does_not_match_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_name:
            f = Path(tmp_name) / "x"
            f.write_bytes(b"hello")
            bt.checked(f, bt.sha256_file(f), "x")
            with self.assertRaises(bt.Mismatch):
                bt.checked(f, "0" * 64, "x")


if __name__ == "__main__":
    unittest.main()
