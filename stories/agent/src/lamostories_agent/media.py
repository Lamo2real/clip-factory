"""ffmpeg for Lamo Stories' last steps (docs/CONTRACTS.md §45.11.3): join the scenes, add the sound, burn the
captions (libass, as clips do), make the cover, and read back what was made with ffprobe. Every command has a time
limit and dies with its process group on cancel (``proc.run``)."""

from __future__ import annotations

import json
from pathlib import Path

from . import proc

CRF = 20  # the default quality, "high" (§45.6 video.quality)
CRF_BY_QUALITY = {"standard": 23, "high": 20, "best": 17}
FPS = 30
PRESET = "fast"


def crf_for(quality: object) -> int:
    """``video.quality`` as libx264's CRF: standard 23, high 20, best 17 (§45.6, §45.29)."""
    return CRF_BY_QUALITY.get(str(quality), CRF)


_filters: dict[str, bool] = {}


async def has_filter(name: str) -> bool:
    """Whether this ffmpeg has the filter ``name`` (``ass`` needs libass; the image's build checks it is there)."""
    if name not in _filters:
        try:
            r = await proc.run(["ffmpeg", "-hide_banner", "-filters"], time_limit=60)
        except (proc.CommandError, OSError):
            _filters[name] = False
        else:
            text = r.stdout.decode("utf-8", "replace")
            _filters[name] = any(line.split()[1:2] == [name] for line in text.splitlines() if line.strip())
    return _filters[name]


def concat_list(clips: list[Path]) -> str:
    def quoted(p: Path) -> str:
        return "'" + str(p.resolve()).replace("'", "'\\''") + "'"

    return "".join(f"file {quoted(c)}\n" for c in clips)


async def assemble(
    clips: list[Path],
    audio: Path | None,
    captions: Path | None,
    out: Path,
    seconds: float,
    workdir: Path,
    *,
    crf: int = CRF,
) -> None:
    """The scene clips joined in order, the sound under them (silence when there is none, so the file always has
    AAC), the captions burned in when there are any, cut to ``seconds``, ``+faststart``."""
    workdir.mkdir(parents=True, exist_ok=True)
    listing = workdir / "scenes.txt"
    listing.write_text(concat_list(clips), "utf-8")
    args = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing.name]
    if audio is not None:
        args += ["-i", str(audio.resolve())]
    else:
        args += ["-f", "lavfi", "-t", f"{seconds:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
    args += ["-map", "0:v:0", "-map", "1:a:0"]
    if captions is not None:
        local = workdir / "captions.ass"
        if captions.resolve() != local.resolve():
            local.write_bytes(captions.read_bytes())
        args += ["-vf", "ass=captions.ass", "-c:v", "libx264", "-preset", PRESET, "-crf", str(crf)]
        args += ["-pix_fmt", "yuv420p", "-r", str(FPS), "-g", str(FPS * 2)]
    else:
        args += ["-c:v", "copy"]
    args += ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]
    args += ["-t", f"{seconds:.3f}", "-movflags", "+faststart", str(out.resolve())]
    await proc.run(args, time_limit=30 * 60, cwd=workdir)


async def cover(video: Path, at: float, out: Path) -> None:
    """One frame of the finished video (captions and all) as the cover JPEG."""
    await proc.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-ss",
            f"{max(0.0, at):.3f}",
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-q:v",
            "3",
            str(out),
        ],
        time_limit=120,
    )


async def probe(path: Path) -> proc.MediaInfo:
    return await proc.probe(str(path))


async def frame_jpegs(video: Path, times: list[float], out_dir: Path) -> list[Path]:
    """One JPEG of the finished video at each time (the final review's frames, §45.11.3)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for i, t in enumerate(times):
        path = out_dir / f"frame-{i:02d}.jpg"
        await cover(video, t, path)
        if path.is_file():
            paths.append(path)
    return paths


async def count_frames(path: Path) -> int:
    """The video stream's real frame count (ffprobe decodes it)."""
    r = await proc.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "json",
            str(path),
        ],
        time_limit=600,
    )
    streams = (json.loads(r.stdout or b"{}").get("streams") or [{}])[0]
    return int(streams.get("nb_read_frames") or 0)
