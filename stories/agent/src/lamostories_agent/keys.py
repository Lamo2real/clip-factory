"""Keys, S3 names, steps and plain sentences of Lamo Stories (docs/CONTRACTS.md §45.3, §45.4, §45.6, §45.9).

The same key formats as the API's ``workspaces/types.py`` (written again here: this runtime imports nothing of Clip
Factory, §45.24); nothing here ever builds a Clip Factory key (``USER#{userId}`` alone) or a Clip Factory S3 prefix."""

from __future__ import annotations

import hashlib
import re
from typing import Final

CLIPS: Final = "clips"
WORKSPACE_ID: Final = re.compile(r"^(stories|[0-9A-HJKMNP-TV-Z]{26})$")  # a Lamo Stories workspace, never clips
SAFE_ID: Final = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SCENE_ID: Final = re.compile(r"^[A-Za-z0-9_-]{1,24}$")

TYPE_PJOB: Final = "ws_pjob"
TYPE_ASSET: Final = "ws_asset"
TYPE_ACTIVITY: Final = "ws_activity"
TYPE_PROVIDER: Final = "ws_provider"
TYPE_USAGE: Final = "ws_usage"
TYPE_MODELSTATUS: Final = "ws_modelstatus"
TYPE_SERIES: Final = "ws_series"
ACTIVITY_DAYS: Final = 90
USAGE_DAYS: Final = 400

# The eight steps of a story job, in order, with the labels the app shows (§45.6); a portrait job has its own one.
STEP_ORDER: Final = ("storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview")
STEP_LABELS: Final = {
    "storyboard": "Write the story",
    "safety": "Check the facts",
    "scenes": "Draw the scenes",
    "animation": "Animate",
    "sound": "Add sounds and music",
    "captions": "Add captions",
    "assemble": "Put it together",
    "preview": "Ready to watch",
}
PORTRAIT_STEP: Final = "portrait"
PORTRAIT_LABEL: Final = "Draw the picture"
# Try it (§45.35 D2): a ``provider_check`` job has one step of its own.
CHECK_JOB_TYPE: Final = "provider_check"
CHECK_STEP: Final = "check"
CHECK_LABEL: Final = "Try it"

# What the owner reads when a step fails: the step in plain words and the button to tap, never a tool's output.
FAILED: Final = {
    "storyboard": "Writing the story did not finish. Tap Try again.",
    "safety": "Checking the facts did not finish. Tap Try again.",
    "scenes": "Drawing the scenes did not finish. Tap Try again.",
    "animation": "Animating did not finish. Tap Try again.",
    "sound": "Adding the sounds and music did not finish. Tap Try again.",
    "captions": "Adding the captions did not finish. Tap Try again.",
    "assemble": "Putting the video together did not finish. Tap Try again.",
    "preview": "Getting the video ready did not finish. Tap Try again.",
    "portrait": "Drawing the picture did not finish. Tap Try again.",
}
NO_TOPIC: Final = (
    "Clips Funded only makes driving-safety videos from checked advice, and this one isn't in the list yet."
)
NO_SCRIPT: Final = "This story has no storyboard yet. Tap Remake the whole video."
WRITER_FAILED: Final = "The story writer's answer did not work. Tap Try again."
IMAGES_OFF: Final = "AI pictures are off. Turn them on in Clips Funded › Settings."

# Write it myself (§45.46): a video made from the owner's own script. Its steps say so (the API and the web use the
# same labels: "Your script", and "Add your words" when a scene has words), and a staging that cannot keep the
# script stops with one of these sentences, naming the scene ({words}: at most 40 characters, then "…").
OWN_STEP_LABELS: Final = {"storyboard": "Your script", "captions": "Add your words"}
OWN_LOST: Final = "Scene {n} got lost while we set it up. Tap Try again."
OWN_WORDS: Final = "Scene {n}'s caption didn't stay as you wrote it. Tap Try again."
OWN_NOT_SHOWN: Final = "Scene {n} didn't fit: we couldn't show “{words}”. Change scene {n}, then tap Try again."
OWN_WHO: Final = "Scene {n} didn't fit: {name} isn't in your cast. Add {name} to the cast, or change scene {n}."
OWN_EXTRA: Final = "Scene {n} got something you didn't write. Tap Try again."
OWN_PLACE: Final = "Scene {n} didn't stay in the {place}. Tap Try again."


def ws_pk(user_id: str, workspace_id: str) -> str:
    """The workspace's own partition. Never ``USER#{userId}``: that is Clip Factory's."""
    if workspace_id == CLIPS or not WORKSPACE_ID.match(workspace_id):
        raise ValueError("not a Clips Funded workspace id")
    if not SAFE_ID.match(user_id):
        raise ValueError("bad user id")
    return f"USER#{user_id}#WS#{workspace_id}"


def registry_pk(user_id: str) -> str:
    return f"USER#{user_id}#WSREG"


def workspace_sk(workspace_id: str) -> str:
    return f"WS#{workspace_id}"


def story_sk(story_id: str) -> str:
    return f"STORY#{story_id}"


def job_sk(job_id: str) -> str:
    return f"PJOB#{job_id}"


def char_sk(character_id: str) -> str:
    return f"CHAR#{character_id}"


def idea_sk(idea_id: str) -> str:
    return f"IDEA#{idea_id}"


def asset_sk(asset_id: str) -> str:
    return f"ASSET#{asset_id}"


def series_sk(series_id: str) -> str:
    """A series (§45.44): a folder of story videos and its story so far."""
    return f"SERIES#{series_id}"


def activity_sk(at: str, item_id: str) -> str:
    return f"ACT#{at}#{item_id}"


def provider_sk(kind: str, provider_id: str) -> str:
    return f"PROVIDER#{kind}#{provider_id}"


def agent_sk(agent_id: str) -> str:
    return f"AGENT#{agent_id}"


def skill_sk(skill_id: str) -> str:
    return f"SKILL#{skill_id}"


MEM_PREFIX: Final = "MEM#"
AICONFIG_SK: Final = "AICONFIG"


def modelstatus_sk(model_key: str) -> str:
    return f"MODELSTATUS#{model_key}"


def usage_sk(day: str, item_id: str) -> str:
    return f"USAGE#{day}#{item_id}"


def refvid_sk(ref_id: str) -> str:
    return f"REFVID#{ref_id}"


def task_sk(task_id: str) -> str:
    return f"TASK#{task_id}"


def conv_sk(conv_id: str) -> str:
    return f"CONV#{conv_id}"


def msg_sk(conv_id: str, msg_id: str) -> str:
    return f"MSG#{conv_id}#{msg_id}"


def ws_prefix(user_id: str, workspace_id: str) -> str:
    ws_pk(user_id, workspace_id)  # the same checks
    return f"ws/{user_id}/{workspace_id}/"


def story_prefix(user_id: str, workspace_id: str, story_id: str) -> str:
    if not SAFE_ID.match(story_id):
        raise ValueError("bad story id")
    return f"{ws_prefix(user_id, workspace_id)}stories/{story_id}/"


def script_key(user_id: str, workspace_id: str, story_id: str, n: int) -> str:
    return f"{story_prefix(user_id, workspace_id, story_id)}script/v{n}.json"


def _scene(scene_id: str) -> str:
    if not SCENE_ID.match(scene_id):
        raise ValueError("bad scene id")
    return scene_id


def scene_clip_key(user_id: str, workspace_id: str, story_id: str, scene_id: str, n: int) -> str:
    return f"{story_prefix(user_id, workspace_id, story_id)}scenes/{_scene(scene_id)}/v{n}.mp4"


def scene_still_key(user_id: str, workspace_id: str, story_id: str, scene_id: str, n: int) -> str:
    return f"{story_prefix(user_id, workspace_id, story_id)}scenes/{_scene(scene_id)}/still-v{n}.jpg"


def audio_key(user_id: str, workspace_id: str, story_id: str, n: int) -> str:
    return f"{story_prefix(user_id, workspace_id, story_id)}audio/v{n}.m4a"


def captions_key(user_id: str, workspace_id: str, story_id: str, n: int) -> str:
    return f"{story_prefix(user_id, workspace_id, story_id)}captions/v{n}.ass"


def final_key(user_id: str, workspace_id: str, story_id: str, n: int) -> str:
    return f"{story_prefix(user_id, workspace_id, story_id)}final/v{n}.mp4"


EXTRA_FORMATS: Final = ("webm", "mov")  # StoriesConfig.production.extraFormats (§45.34); MP4 is always made


def final_extra_key(user_id: str, workspace_id: str, story_id: str, n: int, fmt: str) -> str:
    """``final/v{n}.webm`` (VP9, Opus) or ``final/v{n}.mov`` (ProRes 422 Proxy, PCM), next to the MP4 (§45.34)."""
    if fmt not in EXTRA_FORMATS:
        raise ValueError("bad video format")
    return f"{story_prefix(user_id, workspace_id, story_id)}final/v{n}.{fmt}"


def chat_prefix(user_id: str, workspace_id: str) -> str:
    """Every conversation's pictures (``chat/{convId}/``, written by the API, §45.27)."""
    return f"{ws_prefix(user_id, workspace_id)}chat/"


def cover_key(user_id: str, workspace_id: str, story_id: str, n: int) -> str:
    return f"{story_prefix(user_id, workspace_id, story_id)}final/cover-v{n}.jpg"


def skill_prefix(user_id: str, workspace_id: str, skill_id: str) -> str:
    """A Lamo Stories skill's files (§45.4); Clip Factory's ``skills/`` prefix is never read."""
    if not SAFE_ID.match(skill_id):
        raise ValueError("bad skill id")
    return f"{ws_prefix(user_id, workspace_id)}skills/{skill_id}/"


def reference_prefix(user_id: str, workspace_id: str, ref_id: str) -> str:
    if not SAFE_ID.match(ref_id):
        raise ValueError("bad reference id")
    return f"{ws_prefix(user_id, workspace_id)}references/{ref_id}/"


def check_prefix(user_id: str, workspace_id: str, provider_id: str, job_id: str) -> str:
    """Where Try it's test shot goes in the US bucket (the same ``ws/`` layout, §45.35 D2); deleted after the check."""
    if not SAFE_ID.match(provider_id) or not SAFE_ID.match(job_id):
        raise ValueError("bad id")
    return f"{ws_prefix(user_id, workspace_id)}checks/{provider_id}/{job_id}/"


def reel_prefix(user_id: str, workspace_id: str, story_id: str, scene_id: str, n: int) -> str:
    """Where Nova Reel writes a scene's shot in the US bucket (the same ``ws/`` layout, §45.31)."""
    return f"{story_prefix(user_id, workspace_id, story_id)}reel/{_scene(scene_id)}/v{n}/"


def portrait_key(user_id: str, workspace_id: str, character_id: str, asset_id: str) -> str:
    if not SAFE_ID.match(character_id) or not SAFE_ID.match(asset_id):
        raise ValueError("bad id")
    return f"{ws_prefix(user_id, workspace_id)}characters/{character_id}/portrait/{asset_id}.png"


def seed_for(*parts: str) -> int:
    """A stable 31-bit seed from ids (a job's script seed, a remade scene's new take, a character's portrait)."""
    digest = hashlib.sha256("\x1f".join(parts).encode()).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF
