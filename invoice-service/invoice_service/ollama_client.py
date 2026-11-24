"""Thin client for the local Ollama HTTP API.

Streaming is used so that a deadline can actually stop the work: closing the
connection makes Ollama abandon the generation instead of finishing it for nobody.
"""

from __future__ import annotations

import json
import time

import requests

from .errors import ModelInvalidOutput, ModelTimeout, ModelUnavailable


def _same_model(wanted: str, installed: str) -> bool:
    def norm(name: str) -> str:
        return name[:-7] if name.endswith(":latest") else name

    return norm(wanted) == norm(installed)


class OllamaClient:
    def __init__(self, base_url: str, session: requests.Session | None = None):
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()

    # -- health -----------------------------------------------------------

    def health(self, model: str, timeout: float = 3.0) -> dict:
        try:
            response = self.session.get(f"{self.base_url}/api/tags", timeout=timeout)
            response.raise_for_status()
            names = [m.get("name", "") for m in response.json().get("models", [])]
        except (requests.RequestException, ValueError):
            return {"reachable": False, "model_available": False}
        return {"reachable": True, "model_available": any(_same_model(model, n) for n in names)}

    # -- generation -------------------------------------------------------

    def chat_json(self, *, model: str, messages: list[dict], schema: dict, options: dict,
                  keep_alive: str, timeout_s: float) -> dict:
        """Returns the parsed JSON object the model produced, or raises an ApiError."""
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "format": schema,
            "options": options,
            "keep_alive": keep_alive,
        }
        deadline = time.monotonic() + timeout_s
        try:
            response = self.session.post(
                f"{self.base_url}/api/chat", json=payload, stream=True, timeout=(5, timeout_s),
            )
        except requests.exceptions.ConnectTimeout as exc:
            raise ModelUnavailable("The model server did not answer.") from exc
        except requests.exceptions.ReadTimeout as exc:
            raise ModelTimeout("The model did not respond in time.") from exc
        except requests.exceptions.ConnectionError as exc:
            raise ModelUnavailable("The model server is not reachable.") from exc
        except requests.RequestException as exc:
            raise ModelUnavailable("The model server request failed.") from exc

        pieces: list[str] = []
        done_reason = None
        try:
            if response.status_code == 404:
                raise ModelUnavailable("The configured model is not installed on the model server.")
            if response.status_code >= 400:
                raise ModelUnavailable(f"The model server rejected the request (HTTP {response.status_code}).")
            for line in response.iter_lines():
                if time.monotonic() > deadline:
                    raise ModelTimeout("The model did not finish in time.")
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except ValueError as exc:
                    raise ModelInvalidOutput("The model server sent an unreadable response.") from exc
                if "error" in chunk:
                    raise ModelUnavailable("The model server reported an error.")
                pieces.append((chunk.get("message") or {}).get("content", ""))
                if chunk.get("done"):
                    done_reason = chunk.get("done_reason")
                    break
        except requests.exceptions.ReadTimeout as exc:
            raise ModelTimeout("The model did not respond in time.") from exc
        except (requests.exceptions.ChunkedEncodingError, requests.exceptions.ConnectionError) as exc:
            raise ModelUnavailable("The connection to the model server was lost.") from exc
        finally:
            response.close()

        if done_reason == "length":
            raise ModelInvalidOutput("The model's answer was cut off before it finished.")
        return _parse_json_object("".join(pieces))


def _parse_json_object(text: str) -> dict:
    text = text.strip()
    candidates = [text]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ModelInvalidOutput("The model did not return valid JSON.")
