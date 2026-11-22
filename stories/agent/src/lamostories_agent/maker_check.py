"""Check models for the makers' models (docs/CONTRACTS.md §45.37 G2, G7): an access check that costs nothing, per
picture, video or sound model, written to ``MAKERSTATUS#{key}`` (type ``ws_makerstatus``: ``model``, ``kind``,
``status`` ``ok`` | ``denied`` | ``not_found`` | ``error``, ``line``, ``checkedAt``, ``by`` ``"check"``).

* **Amazon Bedrock** (Stability AI, Luma AI Ray2, a Bedrock model the owner added): ``GetFoundationModelAvailability``
  in the model's own Region (its authorization, entitlement, agreement and Region availability), and
  ``GetFoundationModel`` where that is not answered. Nothing is generated, so nothing is billed.
* **ElevenLabs** (the owner's key): ``GET /v1/models``, which proves the key is accepted.
* **Amazon Polly**: ``DescribeVoices`` for neural voices in eu-west-1: the voice is there for this account.
* **An OpenAI-compatible images API** (the owner's key): ``GET {baseUrl}/models``: the key is accepted and the model
  is listed.
* A model Amazon ended (Nova Canvas, Nova Reel) is never called: it reads ``not_found`` with "Ended by Amazon on 30
  Sep 2026."

Each line is the provider's own answer in a plain sentence; nothing is shown as working because it is listed."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import config, keys
from . import hosts as keyed
from .util import log

REGION_WORDS = {
    "us-west-2": "US West (Oregon)",
    "us-east-1": "US East (N. Virginia)",
    "eu-west-1": "Europe (Ireland)",
    "eu-north-1": "Europe (Stockholm)",
}
ENDED = "Ended by Amazon on {day}."


def region_words(region: str | None) -> str:
    return REGION_WORDS.get(str(region or ""), str(region or "this Region"))


def _error(e: BaseException) -> tuple[str, str]:
    response = getattr(e, "response", None)
    error = ((response or {}).get("Error") or {}) if isinstance(response, dict) else {}
    return str(error.get("Code") or ""), str(error.get("Message") or e)[:300]


def _sentence(text: str) -> str:
    text = " ".join(str(text or "").split()).strip()
    if not text:
        return ""
    return text if text.endswith((".", "!", "?")) else text + "."


@dataclass
class MakerChecker:
    """The clients a maker check uses: Bedrock's control plane per Region, Amazon Polly per Region, the workspaces'
    provider keys (read per check) and HTTPS for the keyed hosts (tests give fakes)."""

    bedrock: Callable[[str], Any] | None = None
    polly: Callable[[str], Any] | None = None
    keys: keyed.KeySource | None = None
    http: keyed.Http | None = None

    def check(self, workspace_id: str, entry: dict[str, Any]) -> tuple[str, str]:
        """``(status, line)`` for one maker model."""
        if config.ended(entry):
            return "not_found", ENDED.format(day=config.ended_words(str(entry["ended"])))
        host = config.host_of(entry)
        try:
            if host == "elevenlabs":
                return self._elevenlabs(workspace_id)
            if host == "polly":
                return self._polly(entry)
            if host == "openai_compatible":
                return self._openai(workspace_id, entry)
            return self._bedrock(entry)
        except keyed.HostError as e:
            if e.found:
                return e.found[0], _sentence(e.found[1][:1].upper() + e.found[1][1:])
            return "error", _sentence(f"{keyed.host_words(host)} did not answer the check. Try again later")

    # --- Amazon Bedrock ----------------------------------------------------------------------------------------

    def _bedrock(self, entry: dict[str, Any]) -> tuple[str, str]:
        label = str(entry.get("label") or entry.get("key"))
        region = str(entry.get("region") or config.MAKER_REGION)
        where = region_words(region)
        model_id = str(entry.get("modelId") or "")
        if self.bedrock is None:
            return "error", "Lamo Stories cannot reach Amazon Bedrock right now. Try again later."
        client = self.bedrock(region)
        try:
            got = client.get_foundation_model_availability(modelId=model_id)
        except Exception as e:
            code, said = _error(e)
            if code in ("ResourceNotFoundException", "ValidationException"):
                return "not_found", _sentence(f"Amazon Bedrock cannot find {label} in {where}: {said}")
            if code == "AccessDeniedException":
                return "denied", _sentence(f"Amazon Bedrock says this account may not use {label} in {where}: {said}")
            if code in ("UnknownOperationException", "UnrecognizedClientException") or isinstance(e, AttributeError):
                return self._bedrock_model(client, label, where, model_id)
            log("warn", "stories.maker_check_failed", model=entry.get("key"), code=code)
            return "error", _sentence(f"Amazon Bedrock did not answer the check for {label}. Try again later")
        authorized = got.get("authorizationStatus") == "AUTHORIZED"
        entitled = got.get("entitlementAvailability") == "AVAILABLE"
        in_region = got.get("regionAvailability") == "AVAILABLE"
        agreement = got.get("agreementAvailability") or {}
        agreed = agreement.get("status") in (None, "AVAILABLE")
        if not in_region:
            return "not_found", f"Amazon Bedrock does not offer {label} in {where}."
        if not authorized:
            return "denied", f"Amazon Bedrock says this account may not use {label} in {where}."
        if not agreed:
            said = _sentence(str(agreement.get("errorMessage") or ""))
            if agreement.get("status") == "PENDING":
                return "denied", f"Amazon Bedrock is still turning on {label} for this account in {where}."
            return "denied", f"{label} is not turned on for this account in {where}." + (
                f" Bedrock said: {said}" if said else ""
            )
        if not entitled:
            return "denied", f"{label} is not turned on for this account in {where}. Turn it on in the Bedrock console."
        return "ok", f"Amazon Bedrock says this account can use {label} in {where}."

    def _bedrock_model(self, client: Any, label: str, where: str, model_id: str) -> tuple[str, str]:
        try:
            client.get_foundation_model(modelIdentifier=model_id)
        except Exception as e:
            code, said = _error(e)
            if code in ("ResourceNotFoundException", "ValidationException"):
                return "not_found", _sentence(f"Amazon Bedrock cannot find {label} in {where}: {said}")
            if code == "AccessDeniedException":
                return "denied", _sentence(f"Amazon Bedrock says this account may not use {label} in {where}: {said}")
            return "error", _sentence(f"Amazon Bedrock did not answer the check for {label}. Try again later")
        return "ok", f"Amazon Bedrock has {label} in {where}."

    # --- the keyed hosts and Amazon Polly ----------------------------------------------------------------------

    def _key(self, workspace_id: str, host: str) -> str:
        found = self.keys.key(workspace_id, host) if self.keys is not None else None
        if not found:
            raise keyed.no_key(host)
        return found

    def _elevenlabs(self, workspace_id: str) -> tuple[str, str]:
        key = self._key(workspace_id, "elevenlabs")
        keyed.ElevenLabs(key, self.http or keyed.https).check()
        return "ok", "ElevenLabs accepted your key."

    def _openai(self, workspace_id: str, entry: dict[str, Any]) -> tuple[str, str]:
        key = self._key(workspace_id, "openai_compatible")
        listed = keyed.openai_models(self.http or keyed.https, str(entry.get("baseUrl") or ""), key)
        model_id = str(entry.get("modelId") or "")
        if listed and model_id not in listed:
            return "not_found", f"The address accepted your key but does not list {model_id}."
        return "ok", "The address accepted your key" + (f" and lists {model_id}." if listed else ".")

    def _polly(self, entry: dict[str, Any]) -> tuple[str, str]:
        region = str(entry.get("region") or "eu-west-1")
        voice = str(entry.get("voice") or "Joanna")
        if self.polly is None:
            return "error", "Lamo Stories cannot reach Amazon Polly right now. Try again later."
        try:
            got = self.polly(region).describe_voices(Engine=str(entry.get("modelId") or "neural"))
        except Exception as e:
            code, said = _error(e)
            if code in ("AccessDeniedException", "UnrecognizedClientException"):
                return "denied", _sentence(
                    f"Amazon Polly says this account may not use it in {region_words(region)}: {said}"
                )
            return "error", "Amazon Polly did not answer the check. Try again later."
        names = {str(v.get("Id") or v.get("Name")) for v in got.get("Voices") or [] if isinstance(v, dict)}
        if voice not in names:
            return "not_found", f"Amazon Polly has no {voice} voice in {region_words(region)}."
        return "ok", f"Amazon Polly can speak with the {voice} voice in {region_words(region)}."


def status_item(
    user_id: str, workspace_id: str, entry: dict[str, Any], status: str, line: str, at: str
) -> dict[str, Any]:
    """``MAKERSTATUS#{key}``: what the last check found (Check models writes it; ``by`` ``check``)."""
    key = str(entry["key"])
    return {
        "pk": keys.ws_pk(user_id, workspace_id),
        "sk": f"MAKERSTATUS#{key}",
        "type": "ws_makerstatus",
        "userId": user_id,
        "workspaceId": workspace_id,
        "model": key,
        "kind": str(entry.get("kind") or ""),
        "status": status,
        "line": line,
        "checkedAt": at,
        "by": "check",
    }
