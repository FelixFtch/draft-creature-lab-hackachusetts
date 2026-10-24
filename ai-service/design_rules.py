"""Physical design rules applied after schema repair, read from the live schema.

The morphology agent's schema can carry machine-readable extensions:
  x-actuatorFamilies.<plan>.<family>.minimums / strengthMax   (enforced here)
  x-designRules                                              (shown to the LLM;
                                                              the hub rules below
                                                              mirror them)
When those keys are absent (older schema), only the plain invariants run.
Nothing here can make a design schema-invalid: designer.py repairs again
afterwards. Draft's own gate still has the last word (HTTP 422 + hints).
"""
from __future__ import annotations

from schemas import DESIGN_ID

PRESET_FAMILY = {"cheetah": "qdd", "bear": "geared", "giraffe": "harmonic"}


def _num(value):
    return type(value) in (int, float)


def design_rules(store):
    try:
        rules = store.doc(DESIGN_ID).get("x-designRules")
    except Exception:
        return []
    return [r for r in rules if isinstance(r, str)][:16] if isinstance(rules, list) else []


def _family(design, plan, detail):
    family = detail.get("actuator")
    if family:
        return family
    if plan == "quadruped":
        return PRESET_FAMILY.get(design.get("basePreset"))
    if plan == "multileg" and design.get("basePreset") != "flower":
        return "micro"  # the multileg template default
    return None


def enforce(store, design):
    """Return (design, notes). Mutates and returns the given design."""
    notes = []
    plan = design.get("bodyPlan")
    detail = design.get(plan)
    if not isinstance(detail, dict):
        return design, notes
    try:
        document = store.doc(DESIGN_ID)
    except Exception:
        document = {}
    if plan == "multileg":
        count = detail.get("legCount")
        if detail.get("arrangement") == "bilateral" and isinstance(count, int) and count % 2:
            detail["arrangement"] = "radial"
            detail["bodyAspect"] = min(detail.get("bodyAspect", 1.0), 1.2)
            notes.append(f"{count} legs cannot pair up, so they are arranged radially")
    families = document.get("x-actuatorFamilies")
    family = _family(design, plan, detail)
    spec = families.get(plan, {}).get(family) if isinstance(families, dict) and isinstance(families.get(plan), dict) else None
    if isinstance(spec, dict):
        for field, minimum in (spec.get("minimums") or {}).items():
            if _num(minimum) and _num(detail.get(field)) and detail[field] < minimum:
                notes.append(f"{plan}.{field} raised to {minimum:g} to make room for {family} actuators")
                detail[field] = minimum
        limit = spec.get("strengthMax")
        if _num(limit) and _num(detail.get("strength")) and detail["strength"] > limit:
            notes.append(f"{plan}.strength capped at {limit:g} for {family} actuators")
            detail["strength"] = limit
    if plan == "multileg" and document.get("x-designRules") is not None:
        notes += fit_multileg(detail, family)
    return design, notes


def fit_multileg(detail, family=None):
    """Hub and link rules for multileg bodies (from the template's design rules)."""
    notes = []
    count = detail.get("legCount", 6)
    arrangement = detail.get("arrangement", "radial")
    radius = detail.get("bodyRadius")
    aspect = detail.get("bodyAspect", 1.0)
    if isinstance(count, int) and count >= 7 and arrangement == "radial":
        if _num(radius) and radius < 0.11:
            detail["bodyRadius"] = radius = 0.11
            notes.append("hub widened so 7-8 radial hip actuators do not touch")
        if _num(aspect) and aspect > 1.2:
            detail["bodyAspect"] = aspect = 1.2
            notes.append("hub kept round so radial legs do not bunch up")
    if count == 8 and arrangement == "bilateral":
        if _num(aspect) and aspect < 1.6 and not (_num(radius) and radius >= 0.17):
            detail["bodyAspect"] = aspect = 1.6
            notes.append("body lengthened so eight paired legs have room")
        if _num(radius) and radius < 0.11:
            detail["bodyRadius"] = radius = 0.11
    if count == 6 and arrangement == "bilateral" and family == "qdd" and _num(aspect) and aspect <= 1.05 \
            and _num(radius) and radius < 0.11:
        detail["bodyRadius"] = radius = 0.11
    if _num(detail.get("coxa")):
        minimum = 0.08 if family != "qdd" else (0.10 if detail.get("strength", 1.0) > 1.2 else 0.09)
        if detail["coxa"] < minimum:
            detail["coxa"] = minimum
            notes.append(f"coxa lengthened to {minimum:g} to hold the hip actuators apart")
    upper, lower = detail.get("upperLeg"), detail.get("lowerLeg")
    if _num(upper) and _num(lower):
        if upper > lower:
            detail["upperLeg"] = upper = lower
            notes.append("thigh kept no longer than the shank to spare the hips")
        big_hub = (_num(radius) and radius > 0.2) or (_num(aspect) and aspect > 1.8)
        if big_hub and upper + lower > 0.5:
            scale = 0.5 / (upper + lower)
            detail["upperLeg"], detail["lowerLeg"] = round(upper * scale, 3), round(lower * scale, 3)
            notes.append("legs shortened: a big hub with long legs is too heavy to stand")
    return notes
