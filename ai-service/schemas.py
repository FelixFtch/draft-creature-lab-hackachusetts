"""Runtime JSON-Schema subset: load the shared contracts, validate, repair, summarise.

The design and look schemas are owned by other agents and may gain fields at
any time, so nothing here hardcodes their field lists. The service reads
``contracts/design.schema.json`` and ``contracts/look.schema.json`` when it
starts (and again whenever a file changes on disk) and derives prompts,
validation and repairs from whatever they contain.

Supported keywords (the subset the contracts use, plus a little headroom):
type, enum, const, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
minLength, maxLength, pattern, required, properties, additionalProperties,
items, minItems, maxItems, uniqueItems, $ref (within a file and between the
two files), allOf, anyOf, oneOf (as anyOf), default. Annotations such as
title/description are ignored by validation and used for prompt summaries.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path
import re
import threading

DESIGN_ID = "creature-design/1"
LOOK_ID = "creature-look/1"
SCHEMA_FILES = {DESIGN_ID: "design.schema.json", LOOK_ID: "look.schema.json"}
MAX_SCHEMA_BYTES = 256 * 1024
MAX_DEPTH = 24


class SchemaUnavailable(RuntimeError):
    pass


# Named colours LLMs (and people) commonly use instead of hex. Only used to
# repair strings that must match a #rrggbb pattern.
NAMED_COLORS = {
    "black": "#1b1b1f", "white": "#f4f4f2", "red": "#d93a32", "green": "#3fa34d", "blue": "#2f6fd6",
    "yellow": "#f2c230", "orange": "#f08a24", "purple": "#7c4dbe", "violet": "#8f5bd9", "pink": "#f07aa8",
    "brown": "#8a5a3b", "grey": "#8c9196", "gray": "#8c9196", "silver": "#c3c8cf", "gold": "#d4a72c",
    "cyan": "#2fc2d6", "teal": "#1f8c80", "turquoise": "#38c7b8", "lime": "#9ad63a", "navy": "#1f2f66",
    "maroon": "#7a2230", "beige": "#e3d5b8", "cream": "#f3ead2", "tan": "#c9a46b", "olive": "#6f7a2e",
    "mint": "#9de0c2", "lavender": "#b9a4e6", "magenta": "#d63aa8", "coral": "#f2735c", "peach": "#f6b48f",
    "indigo": "#4b3fa8", "crimson": "#b81d3a", "ivory": "#f7f2e0", "charcoal": "#33363b", "sand": "#d9c39a",
    "sky": "#7cc4f0", "rose": "#e86a8a", "amber": "#f2a51a", "emerald": "#2a9d68", "ruby": "#b3123a",
    "sapphire": "#2449a8", "jade": "#3f9e7a", "copper": "#b8733a", "bronze": "#a8743a", "chocolate": "#5e3a24",
    "lilac": "#c8a2d8", "aqua": "#4fd6d0", "scarlet": "#e0301e", "khaki": "#b8ad7a", "plum": "#7d3c6b",
}


def _hex_from(value):
    """Best-effort conversion of a colour-ish string to #rrggbb, else None."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if text in NAMED_COLORS:
        return NAMED_COLORS[text]
    text = text.replace(" ", "")
    match = re.fullmatch(r"#?([0-9a-f]{6})", text)
    if match:
        return "#" + match.group(1)
    match = re.fullmatch(r"#?([0-9a-f])([0-9a-f])([0-9a-f])", text)
    if match:
        return "#" + "".join(c * 2 for c in match.groups())
    match = re.fullmatch(r"#?([0-9a-f]{6})[0-9a-f]{2}", text)  # #rrggbbaa -> drop alpha
    if match:
        return "#" + match.group(1)
    match = re.fullmatch(r"rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,[0-9.]+)?\)", text)
    if match:
        parts = [min(255, int(p)) for p in match.groups()]
        return "#" + "".join(f"{p:02x}" for p in parts)
    return None


def _norm_token(value):
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _is_number(value):
    return type(value) in (int, float) and math.isfinite(value)


class Ctx:
    """Repair/validation context: which document we are in and what changed."""

    def __init__(self, store, doc_id, notes=None, errors=None, synonyms=None):
        self.store, self.doc_id = store, doc_id
        self.notes = [] if notes is None else notes
        self.errors = [] if errors is None else errors
        self.synonyms = synonyms or {}

    def at(self, doc_id):
        return Ctx(self.store, doc_id, self.notes, self.errors, self.synonyms)


def _path(path):
    return path or "(root)"


class SchemaStore:
    """Loads the two contract schemas and reloads them when the files change."""

    def __init__(self, contracts_dir):
        self.directory = Path(contracts_dir)
        self.lock = threading.Lock()
        self.docs = {}      # $id -> schema dict
        self.by_file = {}   # file name -> $id
        self.mtimes = {}
        self.reload(force=True)

    # -- loading -------------------------------------------------------
    def reload(self, force=False):
        with self.lock:
            changed = False
            for schema_id, name in SCHEMA_FILES.items():
                path = self.directory / name
                try:
                    stat = path.stat()
                except OSError:
                    if schema_id not in self.docs:
                        raise SchemaUnavailable(f"Missing contract schema {name}") from None
                    continue
                stamp = (stat.st_mtime_ns, stat.st_size)
                if not force and self.mtimes.get(schema_id) == stamp:
                    continue
                try:
                    if stat.st_size > MAX_SCHEMA_BYTES:
                        raise ValueError("schema too large")
                    document = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(document, dict):
                        raise ValueError("schema must be an object")
                except (OSError, ValueError, UnicodeDecodeError):
                    # A half-written file during another agent's edit keeps the
                    # last good copy instead of breaking the service.
                    if schema_id not in self.docs:
                        raise SchemaUnavailable(f"Contract schema {name} is not valid JSON") from None
                    continue
                self.docs[schema_id] = document
                self.by_file[name] = schema_id
                declared = document.get("$id")
                if isinstance(declared, str) and declared != schema_id:
                    self.docs[declared] = document
                self.mtimes[schema_id] = stamp
                changed = True
            return changed

    def doc(self, schema_id):
        self.reload()
        try:
            return self.docs[schema_id]
        except KeyError:
            raise SchemaUnavailable(f"Unknown schema {schema_id}") from None

    def resolve(self, ref, doc_id):
        """Resolve a $ref relative to doc_id. Returns (target_doc_id, schema)."""
        if not isinstance(ref, str):
            raise ValueError("$ref must be a string")
        base, _, fragment = ref.partition("#")
        if base:
            name = base.rsplit("/", 1)[-1]
            target = self.by_file.get(name) or (base if base in self.docs else None)
            if target is None:
                raise ValueError(f"Unresolvable $ref {ref}")
        else:
            target = doc_id
        node = self.docs[target]
        if fragment:
            for part in fragment.lstrip("/").split("/"):
                part = part.replace("~1", "/").replace("~0", "~")
                if not isinstance(node, dict) or part not in node:
                    raise ValueError(f"Unresolvable $ref {ref}")
                node = node[part]
        if not isinstance(node, dict):
            raise ValueError(f"$ref {ref} does not point at a schema")
        return target, node

    # -- public helpers ------------------------------------------------
    def validate(self, schema_id, value):
        """Return a list of human-readable errors (empty when valid)."""
        ctx = Ctx(self, schema_id)
        _validate(value, self.doc(schema_id), ctx, "", 0)
        return ctx.errors

    def repair(self, schema_id, value, synonyms=None):
        """Return (repaired_value_or_None, notes, errors).

        Out-of-range numbers are clamped, unknown or invalid optional fields are
        dropped, near-miss enum/colour strings are normalised. A value that still
        cannot satisfy the schema (e.g. a missing required field) yields None.
        """
        ctx = Ctx(self, schema_id, synonyms=synonyms)
        ok, repaired = _repair(copy.deepcopy(value), self.doc(schema_id), ctx, "", 0)
        if ok:
            remaining = self.validate(schema_id, repaired)
            if remaining:
                ctx.errors.extend(remaining)
                ok = False
        return (repaired if ok else None), ctx.notes, ctx.errors

    def summary(self, schema_id, title=None, skip=()):
        """Compact, prompt-friendly description of a schema (top-level
        properties named in skip are left out)."""
        self.reload()
        document = self.doc(schema_id)
        if skip:
            document = dict(document, properties={k: v for k, v in (document.get("properties") or {}).items()
                                                  if k not in skip})
        lines = [f"{title or document.get('title') or schema_id} ({schema_id}) - JSON object:"]
        _summarise_object(self, schema_id, document, lines, "", 0)
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _type_ok(value, kind):
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "null":
        return value is None
    if kind == "integer":
        return type(value) is int or (type(value) is float and math.isfinite(value) and value.is_integer())
    if kind == "number":
        return _is_number(value)
    return True  # unknown type keyword: do not block


def _validate(value, schema, ctx, path, depth):
    if depth > MAX_DEPTH:
        ctx.errors.append(f"{_path(path)}: nesting too deep")
        return
    if not isinstance(schema, dict):
        return
    if "$ref" in schema:
        try:
            target, node = ctx.store.resolve(schema["$ref"], ctx.doc_id)
        except ValueError as exc:
            ctx.errors.append(f"{_path(path)}: {exc}")
            return
        _validate(value, node, ctx.at(target), path, depth + 1)
    for sub in schema.get("allOf", []) or []:
        _validate(value, sub, ctx, path, depth + 1)
    branches = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(branches, list) and branches:
        if not any(not _errors_for(value, sub, ctx, path, depth + 1) for sub in branches):
            ctx.errors.append(f"{_path(path)}: does not match any allowed shape")
    if "const" in schema and value != schema["const"]:
        ctx.errors.append(f"{_path(path)}: must be {json.dumps(schema['const'])}")
    if "enum" in schema and not any(value == item and type(value) is type(item) for item in schema["enum"]):
        ctx.errors.append(f"{_path(path)}: must be one of {', '.join(map(str, schema['enum']))}")
    kinds = schema.get("type")
    if kinds is not None:
        kinds = kinds if isinstance(kinds, list) else [kinds]
        if not any(_type_ok(value, kind) for kind in kinds):
            ctx.errors.append(f"{_path(path)}: must be {' or '.join(kinds)}")
            return
    if _is_number(value):
        if "minimum" in schema and value < schema["minimum"]:
            ctx.errors.append(f"{_path(path)}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            ctx.errors.append(f"{_path(path)}: must be <= {schema['maximum']}")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            ctx.errors.append(f"{_path(path)}: must be > {schema['exclusiveMinimum']}")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            ctx.errors.append(f"{_path(path)}: must be < {schema['exclusiveMaximum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            ctx.errors.append(f"{_path(path)}: must have at least {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            ctx.errors.append(f"{_path(path)}: must have at most {schema['maxLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            ctx.errors.append(f"{_path(path)}: must match {schema['pattern']}")
    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        for key in schema.get("required", []) or []:
            if key not in value:
                ctx.errors.append(f"{_join(path, key)}: is required")
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                _validate(item, properties[key], ctx, _join(path, key), depth + 1)
            elif extra is False:
                ctx.errors.append(f"{_join(path, key)}: is not an allowed field")
            elif isinstance(extra, dict):
                _validate(item, extra, ctx, _join(path, key), depth + 1)
    if isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            ctx.errors.append(f"{_path(path)}: must have at most {schema['maxItems']} items")
        if "minItems" in schema and len(value) < schema["minItems"]:
            ctx.errors.append(f"{_path(path)}: must have at least {schema['minItems']} items")
        if schema.get("uniqueItems"):
            seen = []
            for item in value:
                if item in seen:
                    ctx.errors.append(f"{_path(path)}: items must be unique")
                    break
                seen.append(item)
        if isinstance(schema.get("items"), dict):
            for index, item in enumerate(value):
                _validate(item, schema["items"], ctx, f"{_path(path)}[{index}]", depth + 1)


def _errors_for(value, schema, ctx, path, depth):
    probe = Ctx(ctx.store, ctx.doc_id)
    _validate(value, schema, probe, path, depth)
    return probe.errors


def _join(path, key):
    return f"{path}.{key}" if path else str(key)


# ---------------------------------------------------------------------------
# Repair
# ---------------------------------------------------------------------------

def _repair(value, schema, ctx, path, depth):
    """Return (ok, value). Never raises for bad data; only reports."""
    if depth > MAX_DEPTH or not isinstance(schema, dict):
        return (depth <= MAX_DEPTH), value
    if "$ref" in schema:
        try:
            target, node = ctx.store.resolve(schema["$ref"], ctx.doc_id)
        except ValueError as exc:
            ctx.errors.append(f"{_path(path)}: {exc}")
            return False, None
        ok, value = _repair(value, node, ctx.at(target), path, depth + 1)
        if not ok:
            return False, None
    for sub in schema.get("allOf", []) or []:
        ok, value = _repair(value, sub, ctx, path, depth + 1)
        if not ok:
            return False, None
    branches = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(branches, list) and branches:
        for sub in branches:
            if not _errors_for(value, sub, ctx, path, depth + 1):
                break
        else:
            for sub in branches:
                probe = Ctx(ctx.store, ctx.doc_id, synonyms=ctx.synonyms)
                ok, candidate = _repair(copy.deepcopy(value), sub, probe, path, depth + 1)
                if ok:
                    ctx.notes.extend(probe.notes)
                    value = candidate
                    break
            else:
                ctx.errors.append(f"{_path(path)}: does not match any allowed shape")
                return False, None
    if "const" in schema:
        if value != schema["const"]:
            if value is not None:
                ctx.notes.append(f"{_path(path)} set to {json.dumps(schema['const'])}")
            value = copy.deepcopy(schema["const"])
        return True, value
    kinds = schema.get("type")
    if kinds is not None:
        kinds = kinds if isinstance(kinds, list) else [kinds]
        coerced = _coerce(value, kinds)
        if coerced is _FAIL:
            ctx.errors.append(f"{_path(path)}: must be {' or '.join(kinds)}")
            return False, None
        if coerced is not value and coerced != value:
            ctx.notes.append(f"{_path(path)} converted to {' or '.join(kinds)}")
        value = coerced
    if "enum" in schema:
        options = schema["enum"]
        if not any(value == item and type(value) is type(item) for item in options):
            fixed = _enum_match(value, options, ctx.synonyms)
            if fixed is _FAIL:
                ctx.errors.append(f"{_path(path)}: {json.dumps(value)[:60]} is not one of {', '.join(map(str, options))}")
                return False, None
            ctx.notes.append(f"{_path(path)} normalised to {json.dumps(fixed)}")
            value = fixed
    if _is_number(value) and not isinstance(value, bool):
        low, high = schema.get("minimum"), schema.get("maximum")
        if "exclusiveMinimum" in schema:
            bound = schema["exclusiveMinimum"]
            low = max(low, bound + 1e-6) if low is not None else bound + 1e-6
        if "exclusiveMaximum" in schema:
            bound = schema["exclusiveMaximum"]
            high = min(high, bound - 1e-6) if high is not None else bound - 1e-6
        clamped = value
        if low is not None and clamped < low:
            clamped = low
        if high is not None and clamped > high:
            clamped = high
        if clamped != value:
            ctx.notes.append(f"{_path(path)} clamped from {value:g} to {clamped:g}")
            value = clamped
        if "integer" in (kinds or []) and not isinstance(value, int):
            value = int(round(value))
            if low is not None and value < low:
                value = int(math.ceil(low))
            if high is not None and value > high:
                value = int(math.floor(high))
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            fixed = _hex_from(value)
            if fixed is not None and re.search(schema["pattern"], fixed):
                ctx.notes.append(f"{_path(path)} normalised to {fixed}")
                value = fixed
            else:
                ctx.errors.append(f"{_path(path)}: {json.dumps(value)[:60]} must match {schema['pattern']}")
                return False, None
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            value = value[:schema["maxLength"]].rstrip()
            ctx.notes.append(f"{_path(path)} shortened to {schema['maxLength']} characters")
        if "minLength" in schema and len(value) < schema["minLength"]:
            ctx.errors.append(f"{_path(path)}: must have at least {schema['minLength']} characters")
            return False, None
    if isinstance(value, dict):
        ok, value = _repair_object(value, schema, ctx, path, depth)
        if not ok:
            return False, None
    if isinstance(value, list):
        ok, value = _repair_array(value, schema, ctx, path, depth)
        if not ok:
            return False, None
    return True, value


_FAIL = object()


def _coerce(value, kinds):
    if any(_type_ok(value, kind) for kind in kinds):
        if "integer" in kinds and type(value) is float and value.is_integer() and "number" not in kinds:
            return int(value)
        return value
    for kind in kinds:
        if kind in ("number", "integer") and isinstance(value, str):
            try:
                number = float(value.strip().rstrip("m").strip())
            except ValueError:
                continue
            if math.isfinite(number):
                return int(round(number)) if kind == "integer" else number
        if kind == "integer" and _is_number(value) and not isinstance(value, bool):
            return int(round(value))
        if kind == "boolean" and isinstance(value, str) and value.strip().lower() in ("true", "false"):
            return value.strip().lower() == "true"
        if kind == "string" and _is_number(value) and not isinstance(value, bool):
            return f"{value:g}"
        if kind == "array" and value is not None and not isinstance(value, (dict, list)):
            return [value]
    return _FAIL


def _enum_match(value, options, synonyms):
    if not isinstance(value, str):
        return _FAIL
    token = _norm_token(value)
    for option in options:
        if isinstance(option, str) and _norm_token(option) == token:
            return option
    mapped = synonyms.get(token)
    if mapped in options:
        return mapped
    return _FAIL


def _repair_object(value, schema, ctx, path, depth):
    properties = schema.get("properties") or {}
    extra = schema.get("additionalProperties", True)
    # Map near-miss keys (snake_case, different case) to declared properties.
    lookup = {}
    for name in properties:
        lookup.setdefault(_norm_token(name), name)
    result = {}
    for key, item in value.items():
        target = key
        if key not in properties and isinstance(key, str):
            candidate = lookup.get(_norm_token(key))
            if candidate and candidate not in value:
                ctx.notes.append(f"{_join(path, key)} renamed to {candidate}")
                target = candidate
        if target in properties:
            ok, fixed = _repair(item, properties[target], ctx, _join(path, target), depth + 1)
            if ok:
                result[target] = fixed
            else:
                ctx.notes.append(f"{_join(path, target)} dropped (invalid)")
        elif extra is False:
            ctx.notes.append(f"{_join(path, key)} dropped (not an allowed field)")
        elif isinstance(extra, dict):
            ok, fixed = _repair(item, extra, ctx, _join(path, key), depth + 1)
            if ok:
                result[key] = fixed
            else:
                ctx.notes.append(f"{_join(path, key)} dropped (invalid)")
        else:
            result[key] = item
    for key in schema.get("required", []) or []:
        if key in result:
            continue
        filled = _fill_required(properties.get(key), ctx)
        if filled is _FAIL:
            ctx.errors.append(f"{_join(path, key)}: is required")
            return False, None
        result[key] = filled
    return True, result


def _fill_required(schema, ctx, depth=0):
    if not isinstance(schema, dict) or depth > 4:
        return _FAIL
    if "const" in schema:
        return copy.deepcopy(schema["const"])
    if "default" in schema:
        return copy.deepcopy(schema["default"])
    if "$ref" in schema:
        try:
            target, node = ctx.store.resolve(schema["$ref"], ctx.doc_id)
        except ValueError:
            return _FAIL
        return _fill_required(node, ctx.at(target), depth + 1)
    return _FAIL


def _repair_array(value, schema, ctx, path, depth):
    items = schema.get("items")
    result = []
    for index, item in enumerate(value):
        if isinstance(items, dict):
            ok, fixed = _repair(item, items, ctx, f"{_path(path)}[{index}]", depth + 1)
            if not ok:
                ctx.notes.append(f"{_path(path)}[{index}] dropped (invalid)")
                continue
            item = fixed
        result.append(item)
    if schema.get("uniqueItems"):
        unique = []
        for item in result:
            if item not in unique:
                unique.append(item)
        if len(unique) != len(result):
            ctx.notes.append(f"{_path(path)} duplicates removed")
        result = unique
    if "maxItems" in schema and len(result) > schema["maxItems"]:
        ctx.notes.append(f"{_path(path)} trimmed to {schema['maxItems']} items")
        result = result[:schema["maxItems"]]
    if "minItems" in schema and len(result) < schema["minItems"]:
        ctx.errors.append(f"{_path(path)}: must have at least {schema['minItems']} items")
        return False, None
    return True, result


# ---------------------------------------------------------------------------
# Prompt summaries
# ---------------------------------------------------------------------------

def _short(text, limit):
    if not isinstance(text, str):
        return ""
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _deref(store, schema_id, schema, depth=0):
    while isinstance(schema, dict) and "$ref" in schema and depth < 8:
        try:
            schema_id, target = store.resolve(schema["$ref"], schema_id)
        except ValueError:
            return schema_id, {}
        merged = dict(target)
        merged.update({k: v for k, v in schema.items() if k != "$ref"})
        schema = merged
        depth += 1
    return schema_id, schema


def _describe_scalar(schema):
    if "const" in schema:
        return "= " + json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(str(item) for item in schema["enum"])
    kind = schema.get("type")
    kind = kind[0] if isinstance(kind, list) and kind else kind
    if kind in ("number", "integer"):
        low = schema.get("minimum", schema.get("exclusiveMinimum"))
        high = schema.get("maximum", schema.get("exclusiveMaximum"))
        word = "integer " if kind == "integer" else ""
        if low is not None and high is not None:
            return f"{word}{low:g}-{high:g}"
        return word.strip() or "number"
    if kind == "string":
        pattern = schema.get("pattern")
        if pattern == "^#[0-9a-fA-F]{6}$":
            return "#rrggbb"
        limit = schema.get("maxLength")
        return f"text<={limit}" if limit else "text"
    if kind == "boolean":
        return "true|false"
    return kind or "value"


def _summarise_object(store, schema_id, schema, lines, indent, depth):
    if depth > 4:
        return
    schema_id, schema = _deref(store, schema_id, schema)
    required = set(schema.get("required", []) or [])
    simple = []
    for name, prop in (schema.get("properties") or {}).items():
        prop_id, resolved = _deref(store, schema_id, prop)
        mark = " (required)" if name in required else ""
        # Enum explanations (e.g. what qdd/geared/harmonic mean) are the most
        # useful hints for a small model, so they get a longer budget.
        limit = 280 if "enum" in resolved else 150
        description = _short(prop.get("description") or resolved.get("description"), limit)
        kind = resolved.get("type")
        if prop_id != schema_id and resolved.get("properties"):
            title = resolved.get("title") or prop_id
            lines.append(f"{indent}* {name}{mark}: {title} object ({prop_id}), see its own field list.")
            continue
        if kind == "object" or resolved.get("properties"):
            head = f"{indent}* {name}{mark}: object"
            lines.append(head + (f" - {description}" if description else ""))
            _summarise_object(store, prop_id, resolved, lines, indent + "  ", depth + 1)
            continue
        if kind == "array" or "items" in resolved:
            item_id, items = _deref(store, prop_id, resolved.get("items") or {})
            limit = resolved.get("maxItems")
            size = f" (max {limit})" if limit is not None else ""
            if items.get("properties"):
                lines.append(f"{indent}* {name}{mark}: list{size} of objects" + (f" - {description}" if description else ""))
                _summarise_object(store, item_id, items, lines, indent + "  ", depth + 1)
            else:
                lines.append(f"{indent}* {name}{mark}: list{size} of {_describe_scalar(items)}" + (f" - {description}" if description else ""))
            continue
        text = _describe_scalar(resolved)
        if "enum" in resolved or "const" in resolved or name in required or (description and len(description) > 40):
            lines.append(f"{indent}* {name}{mark}: {text}" + (f" - {description}" if description else ""))
        else:
            simple.append(f"{name} {text}")
    if simple:
        lines.append(f"{indent}* " + "; ".join(simple))
