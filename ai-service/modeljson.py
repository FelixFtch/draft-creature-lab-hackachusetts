"""Lenient extraction of one JSON object from chat-model text.

Used by /chat and /critique, where a friendly model may wrap its JSON in a
code fence, prepend a sentence or leak a <think> block. /decide deliberately
does NOT use this: its legacy contract rejects anything but a bare object.
"""
from __future__ import annotations

import json
import re

MAX_TEXT = 64 * 1024


def _reject_constant(_):
    raise ValueError("Non-finite JSON constant")


def _balanced_object(text, start):
    depth, in_string, escaped = 0, False, False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def _loads(candidate):
    value = json.loads(candidate, parse_constant=_reject_constant)
    if not isinstance(value, dict):
        raise ValueError("not an object")
    return value


def extract_json_object(text):
    """Return the first JSON object found in text, or raise ValueError."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("empty model output")
    text = text[:MAX_TEXT]
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S | re.I)
    if "</think>" in text.lower():
        text = text[text.lower().rfind("</think>") + len("</think>"):]
    fence = re.search(r"```(?:json|JSON)?\s*(\{.*?\})\s*```", text, flags=re.S)
    candidates = [fence.group(1)] if fence else []
    start = text.find("{")
    while start != -1 and len(candidates) < 4:
        block = _balanced_object(text, start)
        if block:
            candidates.append(block)
            break
        start = text.find("{", start + 1)
    for candidate in candidates:
        for attempt in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
            try:
                return _loads(attempt)
            except (ValueError, RecursionError):
                continue
    raise ValueError("no JSON object in model output")


def clean_text(value, limit):
    """Collapse whitespace and cap length for user-facing model text."""
    if not isinstance(value, str):
        return ""
    value = re.sub(r"<think>.*?</think>", "", value, flags=re.S | re.I)
    value = re.sub(r"[ \t]+", " ", value).strip()
    value = re.sub(r"\n{3,}", "\n\n", value)
    if len(value) > limit:
        cut = value[:limit]
        stop = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        value = cut[:stop + 1] if stop > limit // 2 else cut.rstrip() + "…"
    return value
