"""Tinker, the robot-design partner behind POST /chat.

Flow per request:
  1. validate the request and read the client's state (design, look, body
     build result, policies) defensively;
  2. with a brain provider: build a compact prompt from the LIVE contract
     schemas, ask for one JSON object, parse leniently, repair (clamp numbers,
     drop invalid fields, merge partial designs onto the current one), retry
     once with the validation errors, and otherwise fall back;
  3. without a provider (or when it fails): the offline designer answers;
  4. every design/look action is schema-valid, and the reply never claims
     that something was built or trained - the client does that.
"""
from __future__ import annotations

import copy
import json
import re
import threading

from modeljson import clean_text, extract_json_object
from offline_designer import DRAFT_LINE, MODEL as OFFLINE_MODEL, OfflineDesigner, StateView
from providers import ProviderError, message_content
from schemas import DESIGN_ID, LOOK_ID
from vision import ServiceError, deep_merge
from vocabulary import SYNONYMS

MAX_MESSAGES = 40
MAX_MESSAGE_CHARS = 4000
HISTORY_MESSAGES = 8
HISTORY_CHARS = 700
MAX_REPLY_CHARS = 700
MAX_SUGGESTION_CHARS = 60
CHAT_RESPONSE_LIMIT = 1024 * 1024

FAMILY_FOR_PLAN = {"cheetah": "quadruped", "bear": "quadruped", "giraffe": "quadruped", "flower": "multileg"}

TINKER_PROMPT = """You are Tinker, the warm, playful robot-design partner in Draft Creature Lab. You turn creature ideas into robot designs that the real Draft generator (MIT, 2026) builds and checks, plus fun cosmetic looks.
Rules:
- 1-3 short sentences, friendly, no markdown, in the user's language.
- Ask at most ONE clarifying question, only if the idea is too vague; otherwise propose a design right away.
- Never say the robot was built, trained, tested or can already walk. The app builds and trains when the user presses buttons; you only propose.
- Looks are cosmetic and never change physics. Skills: "walk" (always first) and optionally "jump"; jumping needs a light body, qdd actuators and high strength.
- To explain Draft (at most once per conversation): "{draft}"
- If CURRENT STATE says the build FAILED or the trainer warned, explain the reason simply and propose a revised design that fixes it (lighter, shorter legs, stronger motors, or more room for the motors).
- Presets: cheetah = light short-legged qdd quadruped; bear = heavy geared quadruped; giraffe = long-legged harmonic quadruped; flower = six-legged radial crawler.
- Be imaginative: vary names, proportions and looks so every creature has personality.
Output exactly one JSON object and nothing else:
{{"reply": "...", "design": <complete Design or null>, "look": <complete Look or null>, "train": ["walk"] or ["walk","jump"] or null, "play": false, "suggestions": ["2-4 short things the user could say next"]}}
- design: only when proposing a new or changed body, always the complete object.
- look: when proposing a new or changed appearance.
- train: only when the user asks to train. play: true only if the user asks to play and the walk policy is ready.
Example: {example}

{design_schema}

{look_schema}"""

EXAMPLE = {
    "reply": "Meet Ribbit: a springy frog bot with short, punchy legs, tuned to jump.",
    "design": {"schema": DESIGN_ID, "name": "Ribbit", "bodyPlan": "quadruped", "basePreset": "cheetah",
               "quadruped": {"torsoLength": 0.36, "torsoWidth": 0.22, "upperLeg": 0.24, "lowerLeg": 0.23,
                             "actuator": "qdd", "strength": 1.35},
               "skills": ["walk", "jump"]},
    "look": {"schema": LOOK_ID, "theme": "frog", "palette": {"body": "#4caf50", "limbs": "#7cc96b", "accent": "#f4d03f"},
             "pattern": {"kind": "spots", "color": "#2e6b34", "scale": 1.2}, "face": {"eyes": "cute"}},
    "train": None, "play": False,
    "suggestions": ["Make it a poison dart frog", "Longer legs"],
}

CLAIM_PATTERNS = [
    re.compile(r"\b(i|we)\s*('ve|'re| have| just| already)*\s+(built|trained|compiled|tested|printed|fabricated|validated)\b", re.I),
    re.compile(r"\b(it|this|he|she|they|your (robot|creature|bot)|the (robot|creature|bot)|[A-Z][a-z]+)\s*('s| is| has been| was| are| have been)"
               r"\s+(now |already |successfully |fully )?(built|trained|compiled|tested|validated|printed)\b", re.I),
    re.compile(r"\b(is|are)\s+now\s+(able|ready)\s+to\s+(walk|jump|run|play)\b", re.I),
    re.compile(r"\bcan now (walk|jump|run|play)\b", re.I),
    re.compile(r"\btraining (is )?(complete|completed|done|finished)\b", re.I),
    re.compile(r"\b(build|compilation|draft) (succeeded|is complete|completed|passed)\b", re.I),
]
CONDITIONAL = re.compile(r"\b(once|after|when|whenever|if|until|before|will|would|could|should|can be|needs? to|to be|gets?|ready to build)\b", re.I)


def scrub_claims(text):
    """Drop sentences that claim a build/training happened (the client owns that)."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    kept = []
    for sentence in sentences:
        if any(p.search(sentence) for p in CLAIM_PATTERNS) and not CONDITIONAL.search(sentence):
            continue
        kept.append(sentence)
    result = " ".join(kept).strip()
    return result or "Here's my proposal - press Build to let Draft check it."


class ChatRequest:
    def __init__(self, messages, state, view, language):
        self.messages, self.state, self.view, self.language = messages, state, view, language


class Tinker:
    def __init__(self, store, provider=None):
        self.store = store
        self.provider = provider
        self.offline = OfflineDesigner(store)
        self.slot = threading.BoundedSemaphore(2)

    # -- request ------------------------------------------------------------
    def validate(self, value):
        if not isinstance(value, dict) or set(value) - {"messages", "state", "language"}:
            raise ServiceError("invalid_request", "Use messages, state and optional language only")
        raw_messages = value.get("messages", [])
        if not isinstance(raw_messages, list) or len(raw_messages) > MAX_MESSAGES:
            raise ServiceError("invalid_request", f"messages must be a list of at most {MAX_MESSAGES} items")
        messages = []
        for item in raw_messages:
            if (not isinstance(item, dict) or set(item) - {"role", "content"} or item.get("role") not in ("user", "assistant")
                    or not isinstance(item.get("content"), str)):
                raise ServiceError("invalid_request", "Each message needs role 'user' or 'assistant' and string content")
            content = item["content"].strip()
            if len(content) > MAX_MESSAGE_CHARS:
                raise ServiceError("invalid_request", f"Messages are limited to {MAX_MESSAGE_CHARS} characters")
            if content:
                messages.append({"role": item["role"], "content": content})
        state = value.get("state", {})
        if state is None:
            state = {}
        if not isinstance(state, dict):
            raise ServiceError("invalid_request", "state must be an object")
        language = value.get("language")
        if language is not None and (not isinstance(language, str) or not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?", language)):
            raise ServiceError("invalid_request", "language must be a short language tag such as en or zh")
        design = self._repair(DESIGN_ID, state.get("design")) if isinstance(state.get("design"), dict) else None
        if design is None and isinstance(state.get("body"), dict) and isinstance(state["body"].get("design"), dict):
            design = self._repair(DESIGN_ID, state["body"]["design"])
        look = self._repair(LOOK_ID, state.get("look")) if isinstance(state.get("look"), dict) else None
        if look is None and design and isinstance(design.get("look"), dict):
            look = design["look"]
        if design is not None:
            design = {k: v for k, v in design.items() if k != "look"}
        return ChatRequest(messages, state, StateView(state, design, look), language)

    def _repair(self, schema_id, value):
        repaired, _, _ = self.store.repair(schema_id, value, synonyms=SYNONYMS)
        return repaired

    # -- main ---------------------------------------------------------------
    def chat(self, value):
        request = self.validate(value)
        if self.provider is None:
            return self._finish(self.offline.respond(request.messages, request.view), request, None, None)
        if not self.slot.acquire(blocking=False):
            raise ServiceError("busy", "Tinker is already answering two messages; try again in a moment", 429)
        try:
            proposal, problem = self._ask_model(request)
        except ProviderError as exc:
            return self._finish(self.offline.respond(request.messages, request.view), request, None, exc.code)
        finally:
            self.slot.release()
        if proposal is None:
            return self._finish(self.offline.respond(request.messages, request.view), request, None, problem)
        return self._finish(proposal, request, self.provider, None)

    def _ask_model(self, request):
        messages = self.build_messages(request)
        problem = "invalid_model_output"
        for attempt in range(2):
            try:
                response = self.provider.complete(messages, max_tokens=900, temperature=0.7, json_mode=True,
                                                  limit=CHAT_RESPONSE_LIMIT)
                content = message_content(response)
            except ProviderError as exc:
                if exc.code in ("model_output_truncated", "invalid_model_response", "model_refused") and attempt == 0:
                    messages = messages + [{"role": "user", "content": "Your last answer was cut off or unusable. Reply again "
                                                                       "with ONE short JSON object (keep reply under 40 words)."}]
                    problem = exc.code
                    continue
                if exc.code in ("model_output_truncated", "invalid_model_response", "model_refused"):
                    return None, exc.code
                raise
            try:
                parsed = extract_json_object(content)
            except ValueError:
                errors = ["The answer was not a JSON object."]
            else:
                proposal, errors = self.interpret(parsed, request)
                if not errors:
                    return proposal, None
            problem = "invalid_model_output"
            if attempt == 0:
                messages = messages + [
                    {"role": "assistant", "content": content[:1500]},
                    {"role": "user", "content": "Your JSON had problems:\n- " + "\n- ".join(errors[:8])
                     + "\nReply again with only the corrected JSON object."}]
        return None, problem

    # -- prompt -------------------------------------------------------------
    def build_messages(self, request):
        example, _, _ = self.store.repair(DESIGN_ID, EXAMPLE["design"], synonyms=SYNONYMS)
        example_look, _, _ = self.store.repair(LOOK_ID, EXAMPLE["look"], synonyms=SYNONYMS)
        sample = dict(EXAMPLE, design=example, look=example_look)
        # Looks travel in their own "look" field, so the design's embedded
        # look property is left out of the prompt.
        system = TINKER_PROMPT.format(draft=DRAFT_LINE, example=json.dumps(sample, separators=(",", ":")),
                                      design_schema=self.store.summary(DESIGN_ID, "Design", skip=("look",)),
                                      look_schema=self.store.summary(LOOK_ID, "Look"))
        system += "\n\n" + self.state_block(request)
        if request.language:
            system += f"\nReply language: {request.language}."
        messages = [{"role": "system", "content": system}]
        history = request.messages[-HISTORY_MESSAGES:]
        for item in history:
            content = item["content"]
            if len(content) > HISTORY_CHARS:
                content = content[:HISTORY_CHARS] + "…"
            messages.append({"role": item["role"], "content": content})
        if not history or history[-1]["role"] != "user":
            messages.append({"role": "user", "content": "(No new message from me. React to the CURRENT STATE: if the build "
                                                        "failed or the trainer warned, propose a fix; otherwise suggest a fun next "
                                                        "step.) Answer in JSON."})
        else:
            messages[-1] = {"role": "user", "content": messages[-1]["content"] + "\n\n(Answer in JSON.)"}
        return messages

    def state_block(self, request):
        view = request.view
        lines = ["CURRENT STATE"]
        lines.append("Design: " + (json.dumps(view.design, separators=(",", ":")) if view.design else "none yet"))
        lines.append("Look: " + (json.dumps(view.look, separators=(",", ":")) if view.look else "none yet"))
        if view.passed is True:
            build = "built by Draft, feasibility PASSED"
            if view.mass:
                build += f", mass {view.mass:.1f} kg"
        elif view.passed is False:
            build = "Draft build FAILED: " + ("; ".join(view.feasibility_messages) or "feasibility gate did not pass")
        else:
            build = "not built yet"
        lines.append("Build: " + build)
        if view.passed is True and view.feasibility_messages:
            lines.append("Draft warnings: " + "; ".join(view.feasibility_messages))
        if view.trainability:
            lines.append("Trainer warnings: " + "; ".join(view.trainability))
        lines.append("Policies: " + ", ".join(f"{skill} {status}" for skill, status in view.policies.items()))
        if self.provider is not None and self.provider.local:
            # Small local models copy structure well; give them an optional,
            # schema-valid starting point from the offline designer.
            hint = self.offline.respond(request.messages, view)
            if hint.get("design"):
                design, _, _ = self.store.repair(DESIGN_ID, hint["design"], synonyms=SYNONYMS)
                if design:
                    lines.append("Optional starter sketch (improve freely, rename, change proportions): "
                                 + json.dumps(design, separators=(",", ":")))
        return "\n".join(lines)

    # -- model output ---------------------------------------------------------
    def interpret(self, parsed, request):
        """Turn the model's JSON into a proposal; return (proposal, errors)."""
        errors, repairs = [], []
        view = request.view
        reply = clean_text(parsed.get("reply") if isinstance(parsed.get("reply"), str) else parsed.get("message"), MAX_REPLY_CHARS)
        if not reply:
            errors.append('"reply" must be a non-empty string.')
        design_value, look_value = parsed.get("design"), parsed.get("look")
        train_value, play_value = parsed.get("train"), parsed.get("play")
        for action in parsed.get("actions") or [] if isinstance(parsed.get("actions"), list) else []:
            if not isinstance(action, dict):
                continue
            kind = action.get("type")
            if kind == "design" and design_value is None:
                design_value = action.get("design")
            elif kind == "look" and look_value is None:
                look_value = action.get("look")
            elif kind == "train" and train_value is None:
                train_value = action.get("skills") or ["walk"]
            elif kind == "play":
                play_value = True
        proposal = {"reply": reply, "design": None, "look": None, "train": None, "play": False}
        if isinstance(design_value, dict) and design_value:
            design, embedded_look, problems, notes = self.normalise_design(design_value, view.design)
            repairs += notes
            if design is None:
                errors += problems
            else:
                proposal["design"] = design
                if look_value is None and embedded_look is not None:
                    look_value = embedded_look
        elif design_value not in (None, False, {}):
            errors.append('"design" must be an object or null.')
        if isinstance(look_value, dict) and look_value:
            look, notes = self.normalise_look(look_value, view.look)
            repairs += notes
            if look is not None:
                proposal["look"] = look
        proposal["train"] = _skills(train_value)
        if play_value is True:
            if view.ready("walk"):
                proposal["play"] = True
            elif reply and re.search(r"\b(play|park|playground)\b", reply, re.I):
                proposal["reply"] = reply + " (It needs a validated walking policy for this body first.)"
        suggestions = []
        raw = parsed.get("suggestions")
        for item in raw if isinstance(raw, list) else []:
            item = clean_text(item, MAX_SUGGESTION_CHARS)
            if item and item not in suggestions:
                suggestions.append(item)
        proposal["suggestions"] = suggestions[:4]
        proposal["repairs"] = repairs[:8]
        return proposal, errors

    def normalise_design(self, value, current):
        """Return (design|None, embedded_look|None, errors, notes)."""
        value = copy.deepcopy(value)
        plan = value.get("bodyPlan")
        if isinstance(plan, str):
            token = re.sub(r"[^a-z0-9]", "", plan.lower())
            mapped = SYNONYMS.get(token, plan)
            if mapped == "multileg" and token in ("hexapod", "sixlegged", "octopod", "eightlegged"):
                legs = 6 if token in ("hexapod", "sixlegged") else 8
                value.setdefault("multileg", {}).setdefault("legCount", legs)
            value["bodyPlan"] = mapped
        # A partial design ("just change the legs") is merged onto the current one.
        if current and ("bodyPlan" not in value or "name" not in value):
            value = deep_merge(current, value)
        embedded_look = value.pop("look", None)
        plan = value.get("bodyPlan")
        if plan in ("quadruped", "multileg"):
            other = "multileg" if plan == "quadruped" else "quadruped"
            if isinstance(value.get(other), dict):
                # Parameters filed under the wrong plan: keep the ones both plans share.
                target = value[plan] if isinstance(value.get(plan), dict) else {}
                for key in ("upperLeg", "lowerLeg", "actuator", "strength"):
                    if key in value[other] and key not in target:
                        target[key] = value[other][key]
                value[plan] = target
            value.pop(other, None)
            preset = value.get("basePreset")
            if isinstance(preset, str) and FAMILY_FOR_PLAN.get(preset.lower()) not in (None, plan):
                value.pop("basePreset", None)
        if not value.get("name") and current and current.get("name"):
            value["name"] = current["name"]
        if not value.get("name"):
            value["name"] = "Tinker Bot"
        skills = _skills(value.get("skills"))
        value["skills"] = skills or ["walk"]
        design, notes, errors = self.store.repair(DESIGN_ID, value, synonyms=SYNONYMS)
        if design is None:
            return None, embedded_look, [f"design.{e}" if not e.startswith("design") else e for e in errors], notes
        return design, embedded_look, [], notes

    def normalise_look(self, value, current):
        value = copy.deepcopy(value)
        theme = value.get("theme")
        if current and (not theme or theme == current.get("theme")):
            value = deep_merge(current, value)
        value["schema"] = LOOK_ID
        look, notes, _ = self.store.repair(LOOK_ID, value, synonyms=SYNONYMS)
        return look, notes

    # -- response -------------------------------------------------------------
    def _finish(self, proposal, request, provider, fallback):
        """Validate actions once more and build the HTTP response."""
        actions = []
        repairs = list(proposal.get("repairs") or [])
        design = proposal.get("design")
        if design is not None:
            design = {k: v for k, v in design.items() if k != "look"}
            checked, notes, _ = self.store.repair(DESIGN_ID, design, synonyms=SYNONYMS)
            repairs += notes
            if checked is not None:
                actions.append({"type": "design", "design": checked})
        look = proposal.get("look")
        if look is not None:
            checked, notes, _ = self.store.repair(LOOK_ID, look, synonyms=SYNONYMS)
            repairs += notes
            if checked is not None:
                actions.append({"type": "look", "look": checked})
        skills = _skills(proposal.get("train"))
        if skills:
            actions.append({"type": "train", "skills": skills})
        if proposal.get("play") and request.view.ready("walk"):
            actions.append({"type": "play"})
        reply = scrub_claims(clean_text(proposal.get("reply") or "", MAX_REPLY_CHARS) or "Let's design something!")
        suggestions = [clean_text(s, MAX_SUGGESTION_CHARS) for s in proposal.get("suggestions") or []]
        suggestions = [s for s in dict.fromkeys(suggestions) if s][:4]
        if provider is None:
            info = {"name": "offline", "model": OFFLINE_MODEL, "offline": True, "local": True}
            if fallback and self.provider is not None:
                info["fallbackReason"] = fallback
                info["fallbackFrom"] = {"name": self.provider.name, "model": self.provider.model}
        else:
            info = {"name": provider.name, "model": provider.model, "offline": False, "local": provider.local}
        result = {"ok": True, "reply": reply, "actions": actions, "suggestions": suggestions, "provider": info}
        if repairs:
            result["repairs"] = repairs[:8]
        return result


def _skills(value):
    if value is True:
        return ["walk"]
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return None
    skills = []
    for item in value:
        if isinstance(item, str):
            token = SYNONYMS.get(re.sub(r"[^a-z]", "", item.lower()), item.lower())
            if token in ("walk", "jump") and token not in skills:
                skills.append(token)
    if not skills:
        return None
    if "jump" in skills and "walk" not in skills:
        skills.insert(0, "walk")
    return ["walk"] + [s for s in skills if s != "walk"]
