"""The client against `spec/openapi.yaml` and `spec/schemas/`: a route the spec gains, drops or
moves, a parameter it adds or removes, or a property it adds, renames, removes or makes
(un)required in a body this client sends or reads fails here, until the client follows it.

A route the client leaves out on purpose is in `seshi._routes.UNCOVERED`, with why; a schema it
has no model for is in `NOT_MODELLED` below, with why.
"""

from __future__ import annotations

import copy
import types
import typing
from functools import cache
from pathlib import Path
from typing import Any, Literal, Union, get_args, get_origin

import pytest
import yaml
from pydantic import BaseModel

from seshi import models as m
from seshi._routes import ROUTES, UNCOVERED

SPEC = Path(__file__).resolve().parents[4] / "spec"
METHODS = ("get", "put", "post", "patch", "delete")

# The model of each component schema the client reads or sends.
MODELS: dict[str, type[BaseModel]] = {
    "AuthConfig": m.AuthConfig,
    "ExchangeRequest": m.ExchangeRequest,
    "ExchangeResult": m.ExchangeResult,
    "TokenRequest": m.TokenRequest,
    "TokenInfo": m.TokenInfo,
    "OwnersPage": m.OwnersPage,
    "JobRecord": m.JobRecord,
    "ReloadReport": m.ReloadReport,
    "ConfigStatus": m.ConfigStatus,
    "JobsStatus": m.JobsStatus,
    "Shipped": m.Shipped,
    "Upload": m.Upload,
    "Stored": m.Stored,
    "NotWritten": m.NotWritten,
    "Identity": m.Identity,
    "StorageView": m.StorageView,
    "Continuation": m.Continuation,
    "SessionMetadata": m.SessionMetadata,
    "SessionsPage": m.SessionsPage,
    "StaleSessionsPage": m.StaleSessionsPage,
    "ToolCall": m.ToolCall,
    "TraceEvent": m.TraceEvent,
    "Trace": m.Trace,
    "LettaTrace": m.LettaTrace,
    "AtifDocument": m.AtifDocument,
    "OtlpTrace": m.OtlpTrace,
    "OtlpKeyValue": m.OtlpKeyValue,
    "OtlpSpan": m.OtlpSpan,
    "ChangeEntry": m.ChangeEntry,
    "ChangesPage": m.ChangesPage,
    "AllChangesPage": m.AllChangesPage,
    "RedactionRules": m.RedactionRules,
    "CaptureRules": m.CaptureRules,
    "RulePack": m.RulePack,
    "RuleTests": m.RuleTests,
    "ReviewFinding": m.ReviewFinding,
    "ReviewDecision": m.ReviewDecision,
    "ReviewsPage": m.ReviewsPage,
    "SearchResults": m.SearchResults,
    "SearchResult": m.SearchResult,
    "SearchMatch": m.SearchMatch,
    "SourceStatus": m.SourceStatus,
    "SourceDetail": m.SourceDetail,
    "SourceRecord": m.SourceRecord,
    "RuntimeHere": m.RuntimeHere,
    "RuntimeInstance": m.RuntimeInstance,
    "RuntimeConfigStatus": m.RuntimeConfigStatus,
    "RuntimeWrite": m.RuntimeWrite,
    "RuntimeFileWrite": m.RuntimeFileWrite,
    "SecretView": m.SecretView,
    "StoredSourceWrite": m.StoredSourceWrite,
    "ResealResult": m.ResealResult,
    "RecordsPage": m.RecordsPage,
}

NOT_MODELLED: dict[str, str] = {
    **dict.fromkeys(
        ["Format", "Owner", "Visibility", "Scope", "TokenKind", "Sha256", "RenderFormat", "RuleId"],
        "a string: a Literal or str in the models",
    ),
    "Labels": "a map of strings: dict[str, str] in the models",
    "Error": "an error answer: raised as seshi.errors",
    "OffsetMismatch": "an error answer: raised as seshi.errors.OffsetMismatch",
    "Conflict": "an error answer: raised as seshi.errors.SessionConflict",
    "Whole": "part of Stored and NotWritten, which hold its fields",
    "IngestResult": "Stored | NotWritten",
    "Record": "its variants are trace.schema.json's records, which the models follow",
    "OtlpExportResponse": "otlpTraces is not a client call",
    "OtlpStatus": "otlpTraces is not a client call",
}

OPTIONAL_HERE: dict[tuple[str, str], str] = {}
"""Properties the spec requires that a model takes as optional, and why."""

# The records of a trace, in spec/schemas/trace.schema.json.
TRACE_RECORDS: dict[str, type[BaseModel]] = {
    "TraceMetaRecord": m.MetaRecord,
    "TraceTextRecord": m.TextRecord,
    "TraceAssistantRecord": m.AssistantRecord,
    "TraceToolResultRecord": m.ToolResultRecord,
    "TraceToolCall": m.ToolCall,
    "LlmCall": m.LlmCall,
}

# What each call sends as its body, and what it reads from each answer that succeeds.
REQUESTS: dict[str, type[BaseModel]] = {
    "exchange": m.ExchangeRequest,
    "ingest": m.Upload,
    "setVisibility": m.VisibilityChange,
    "createToken": m.TokenRequest,
    "revokeOwnerTokens": m.OwnerRevocation,
    "patchAdminConfig": m.RuntimeConfigPatch,
}
UNTYPED_REQUESTS: dict[str, str] = {
    "putAdminSource": "a source's settings as in [[sources]], any type: a Mapping",
    "putAdminConfigFile": "a file's bytes (application/octet-stream)",
}
"""Calls whose body has no model, and why."""
Reads = type[BaseModel] | tuple[type[BaseModel], ...] | None
RESPONSES: dict[str, dict[str, Reads]] = {
    "health": {"200": m.Health},
    "authConfig": {"200": m.AuthConfig},
    "exchange": {"200": m.ExchangeResult},
    "me": {"200": m.Identity},
    "listOwners": {"200": m.OwnersPage},
    "ingest": {"201": m.Stored, "200": (m.Stored, m.NotWritten)},
    "listSessions": {"200": m.SessionsPage},
    "staleSessions": {"200": m.StaleSessionsPage},
    "getSession": {"200": m.SessionMetadata},
    "setVisibility": {"200": m.SessionMetadata},
    "tombstone": {"200": m.Removed},
    "getTrace": {"200": (m.Trace, m.LettaTrace, m.OtlpTrace, m.AtifDocument)},
    "sessionReviews": {"200": m.ReviewsPage},
    "getSessionByArchive": {"200": m.SessionMetadata},
    "getTraceByArchive": {"200": (m.Trace, m.LettaTrace, m.OtlpTrace, m.AtifDocument)},
    "sessionReviewsByArchive": {"200": m.ReviewsPage},
    "changes": {"200": m.ChangesPage},
    "allChanges": {"200": m.AllChangesPage},
    "search": {"200": m.SearchResults},
    "redactionRules": {"200": m.RedactionRules, "304": None},
    "captureRules": {"200": m.CaptureRules, "304": None},
    "createToken": {"201": m.CreatedToken},
    "listTokens": {"200": m.TokenList},
    "revokeOwnerTokens": {"200": m.RevokedTokens},
    "revokeToken": {"200": m.RevokedToken},
    "adminJobs": {"200": m.JobsStatus},
    "adminSources": {"200": m.SourceList},
    "adminSource": {"200": m.SourceDetail},
    "adminSourceRecords": {"200": m.RecordsPage},
    "adminReloadStatus": {"200": m.ConfigStatus},
    "adminReload": {"200": m.ReloadResult},
    "adminConfig": {"200": m.RuntimeConfigStatus},
    "patchAdminConfig": {"200": m.RuntimeWrite},
    "putAdminConfigFile": {"200": m.RuntimeFileWrite},
    "deleteAdminConfigFile": {"200": m.RuntimeFileWrite},
    "putAdminSource": {"200": m.StoredSourceWrite, "201": m.StoredSourceWrite},
    "deleteAdminSource": {"200": m.SourceDeleted},
    "resealSecrets": {"200": m.ResealResult},
}


# --- Reading the spec -----------------------------------------------------------------------


@cache
def document(name: str) -> Any:
    return yaml.safe_load((SPEC / name).read_text())


def resolve(node: Any, base: str) -> tuple[Any, str]:
    """Follow `$ref`s, across files, to the schema they name; `base` is the file `node` is in."""
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        target, _, pointer = ref.partition("#")
        if target:
            base = str((Path(base).parent / target).as_posix()).removeprefix("./")
        node = document(base)
        for part in pointer.strip("/").split("/") if pointer else []:
            node = node[part]
    return node, base


def flatten(schema: Any, base: str) -> tuple[dict[str, tuple[Any, str]], set[str]]:
    """An object schema's properties (each with its file) and required names, `allOf` merged."""
    schema, base = resolve(schema, base)
    properties: dict[str, tuple[Any, str]] = {}
    required: set[str] = set(schema.get("required", []))
    for part in schema.get("allOf", []):
        more, needed = flatten(part, base)
        properties.update(more)
        required |= needed
    for name, prop in schema.get("properties", {}).items():
        properties[name] = (prop, base)
    return properties, required


def operations() -> dict[str, tuple[str, str, dict[str, Any]]]:
    found: dict[str, tuple[str, str, dict[str, Any]]] = {}
    for path, item in document("openapi.yaml")["paths"].items():
        for method in METHODS:
            if method in item:
                operation = dict(item[method])
                shared = item.get("parameters", [])
                operation["parameters"] = [
                    resolve(p, "openapi.yaml")[0]
                    for p in [*shared, *operation.get("parameters", [])]
                ]
                found[operation["operationId"]] = (method.upper(), path, operation)
    return found


# --- Comparing a schema with a model --------------------------------------------------------


def _models_in(annotation: Any) -> list[type[BaseModel]]:
    """The models a field's type holds: through Optional, unions, list, tuple and Annotated."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    origin = get_origin(annotation)
    if origin is dict:
        return []
    if origin in (list, tuple, Union, types.UnionType, typing.Annotated):
        found: list[type[BaseModel]] = []
        for arg in get_args(annotation):
            found.extend(_models_in(arg))
        return found
    return []


def _item_schema(schema: Any, base: str) -> tuple[Any, str]:
    schema, base = resolve(schema, base)
    if isinstance(schema, dict) and schema.get("type") == "array" and "items" in schema:
        return resolve(schema["items"], base)
    return schema, base


SCALARS: dict[str, type] = {"string": str, "integer": int, "number": float, "boolean": bool}


def _strip(annotation: Any) -> Any:
    """A field's type through Optional and Annotated (`Open`)."""
    while True:
        origin = get_origin(annotation)
        if origin is typing.Annotated:
            annotation = get_args(annotation)[0]
            continue
        if origin in (Union, types.UnionType):
            rest = [a for a in get_args(annotation) if a is not type(None)]
            if len(rest) == 1:
                annotation = rest[0]
                continue
        return annotation


def _literals(annotation: Any) -> set[Any] | None:
    """The values a field's Literal allows (`Format | str` allows Format's), or None."""
    annotation = _strip(annotation)
    origin = get_origin(annotation)
    if origin is Literal:
        return set(get_args(annotation))
    if origin in (Union, types.UnionType):
        found = [_literals(a) for a in get_args(annotation) if a is not type(None)]
        known = [values for values in found if values is not None]
        return set().union(*known) if known else None
    return None


def _types(annotation: Any) -> set[Any]:
    annotation = _strip(annotation)
    origin = get_origin(annotation)
    if origin is Literal:
        return {type(v) for v in get_args(annotation)}
    if origin in (Union, types.UnionType):
        return set().union(*(_types(a) for a in get_args(annotation) if a is not type(None)))
    return {origin or annotation}


def _scalar(schema: Any, base: str, annotation: Any, where: str) -> list[str]:
    """A scalar property's enum (or const) and type against the field's Literal and type."""
    schema, base = resolve(schema, base)
    if not isinstance(schema, dict):
        return []
    problems: list[str] = []
    allowed = set(schema["enum"]) if "enum" in schema else None
    if "const" in schema:
        allowed = {schema["const"]}
    known = _literals(annotation)
    if allowed is not None and known is not None and allowed != known:
        problems.append(f"{where}: the spec allows {sorted(allowed)}; the model {sorted(known)}")
    spec_types = schema.get("type", [])
    held = _types(annotation)
    for spec_type in [spec_types] if isinstance(spec_types, str) else spec_types:
        wanted = SCALARS.get(spec_type)
        if wanted is not None and Any not in held and wanted not in held:
            problems.append(f"{where}: the spec says {spec_type}; the model holds {held}")
    return problems


def _list_item(annotation: Any) -> Any:
    annotation = _strip(annotation)
    return get_args(annotation)[0] if get_origin(annotation) is list else None


def compare(schema: Any, base: str, model: type[BaseModel], where: str) -> list[str]:
    """Every difference between an object schema and a model: properties missing on either side,
    required-ness, and each scalar's enum, const and type (a list's items too). Nested objects
    are compared with the models their fields hold."""
    properties, required = flatten(schema, base)
    fields = {(info.alias or name): info for name, info in model.model_fields.items()}
    problems = [f"{where}: the spec has {p!r}; {model.__name__} does not" for p in properties]
    problems = [p for p, name in zip(problems, properties, strict=True) if name not in fields]
    problems += [
        f"{where}: {model.__name__} has {name!r}; the spec does not"
        for name in fields
        if name not in properties
    ]
    for name, (prop, prop_base) in properties.items():
        info = fields.get(name)
        if info is None:
            continue
        is_required = name in required
        if is_required and (model.__name__, name) in OPTIONAL_HERE:
            is_required = info.is_required()
        if info.is_required() != is_required:
            problems.append(
                f"{where}.{name}: required in the {'spec' if is_required else 'model'} only"
            )
        problems += _scalar(prop, prop_base, info.annotation, f"{where}.{name}")
        resolved, resolved_base = resolve(prop, prop_base)
        element = _list_item(info.annotation)
        if element is not None and isinstance(resolved, dict) and "items" in resolved:
            problems += _scalar(resolved["items"], resolved_base, element, f"{where}.{name}[]")
        nested = _models_in(info.annotation)
        item, item_base = _item_schema(prop, prop_base)
        if (
            len(nested) == 1
            and isinstance(item, dict)
            and ("properties" in item or "allOf" in item)
        ):
            problems += compare(item, item_base, nested[0], f"{where}.{name}")
    return problems


# --- The tests ------------------------------------------------------------------------------


def test_every_route_in_the_spec_is_covered_or_left_out_on_purpose() -> None:
    spec = set(operations())
    client = set(ROUTES) | set(UNCOVERED)
    assert sorted(spec - client) == [], "routes in the spec the client neither calls nor skips"
    assert sorted(client - spec) == [], "routes the client names that the spec does not have"
    assert set(ROUTES).isdisjoint(UNCOVERED)


@pytest.mark.parametrize("operation_id", sorted(ROUTES))
def test_each_route_is_where_the_spec_puts_it_with_its_parameters(operation_id: str) -> None:
    method, path, operation = operations()[operation_id]
    route = ROUTES[operation_id]
    assert (route.method, route.path) == (method, path)
    by_place: dict[str, set[str]] = {"query": set(), "header": set(), "path": set()}
    for parameter in operation["parameters"]:
        by_place[parameter["in"]].add(parameter["name"])
    assert set(route.query) == by_place["query"]
    assert {h.lower() for h in route.headers} == {h.lower() for h in by_place["header"]}
    assert {p.strip("{}") for p in path.split("/") if p.startswith("{")} == by_place["path"]
    assert route.auth == (operation.get("security") != [])


def test_search_sends_every_filter_the_spec_takes() -> None:
    assert set(m.SearchRequest.model_fields) == set(ROUTES["search"].query)


@pytest.mark.parametrize("operation_id", sorted(ROUTES))
def test_each_request_body_is_the_one_the_spec_takes(operation_id: str) -> None:
    operation = operations()[operation_id][2]
    body = operation.get("requestBody")
    if body is None:
        assert operation_id not in REQUESTS
        return
    if operation_id in UNTYPED_REQUESTS:
        assert operation_id not in REQUESTS
        return
    schema = body["content"]["application/json"]["schema"]
    assert compare(schema, "openapi.yaml", REQUESTS[operation_id], operation_id) == []


@pytest.mark.parametrize("operation_id", sorted(ROUTES))
def test_each_answer_is_read_as_the_spec_defines_it(operation_id: str) -> None:
    operation = operations()[operation_id][2]
    successes = {
        status: response
        for status, response in operation["responses"].items()
        if str(status).startswith(("2", "3"))
    }
    reads = RESPONSES[operation_id]
    assert set(map(str, successes)) == set(reads)
    for status, response in successes.items():
        model = reads[str(status)]
        content = resolve(response, "openapi.yaml")[0].get("content")
        if model is None:
            assert content is None
            continue
        schema = content["application/json"]["schema"]
        if isinstance(model, tuple):
            resolved = resolve(schema, "openapi.yaml")[0]
            variants = [v["$ref"].rsplit("/", 1)[-1] for v in resolved["oneOf"]]
            assert [MODELS[v] for v in variants] == list(model)
        else:
            assert compare(schema, "openapi.yaml", model, f"{operation_id} {status}") == []


def test_every_component_schema_has_a_model_or_a_reason() -> None:
    components = set(document("openapi.yaml")["components"]["schemas"])
    named = set(MODELS) | set(NOT_MODELLED)
    assert sorted(components - named) == [], "schemas in the spec with no model and no reason"
    assert sorted(named - components) == [], "names here the spec no longer has"


@pytest.mark.parametrize("name", sorted(MODELS))
def test_each_model_has_the_properties_of_its_schema(name: str) -> None:
    schema = {"$ref": f"#/components/schemas/{name}"}
    assert compare(schema, "openapi.yaml", MODELS[name], name) == []


@pytest.mark.parametrize("name", sorted(TRACE_RECORDS))
def test_each_trace_record_model_has_the_properties_of_its_schema(name: str) -> None:
    schema = {"$ref": f"#/$defs/{name}"}
    assert compare(schema, "schemas/trace.schema.json", TRACE_RECORDS[name], name) == []


def test_the_drift_check_notices_a_property_the_spec_adds() -> None:
    schema = {
        "type": "object",
        "required": ["removed", "why"],
        "properties": {"removed": {"type": "integer"}, "why": {"type": "string"}},
    }
    assert compare(schema, "openapi.yaml", m.Removed, "x") == [
        "x: the spec has 'why'; Removed does not"
    ]
    schema = {"type": "object", "properties": {"removed": {"type": "integer"}}}
    assert compare(schema, "openapi.yaml", m.Removed, "x") == [
        "x.removed: required in the model only"
    ]


def test_the_drift_check_looks_into_nested_objects() -> None:
    schema = copy.deepcopy(resolve({"$ref": "#/components/schemas/JobsStatus"}, "openapi.yaml")[0])
    others = schema["properties"]["worker"]["properties"]["others"]["items"]
    others["properties"]["host"] = {"type": "string"}
    assert compare(schema, "openapi.yaml", m.JobsStatus, "JobsStatus") == [
        "JobsStatus.worker.others: the spec has 'host'; OtherWorker does not"
    ]


def test_the_drift_check_notices_an_enum_value_or_type_the_spec_changes() -> None:
    schema = copy.deepcopy(resolve({"$ref": "#/components/schemas/Upload"}, "openapi.yaml")[0])
    schema["properties"]["format"] = {"enum": ["claude-code", "amp"]}
    schema["properties"]["offset"] = {"type": "string"}
    problems = compare(schema, "openapi.yaml", m.Upload, "Upload")
    assert any(p.startswith("Upload.format: the spec allows") for p in problems)
    assert any(p.startswith("Upload.offset: the spec says string") for p in problems)
    identity = copy.deepcopy(resolve({"$ref": "#/components/schemas/Identity"}, "openapi.yaml")[0])
    identity["properties"]["scopes"]["items"] = {"enum": ["sessions:read"]}
    assert [p for p in compare(identity, "openapi.yaml", m.Identity, "I") if "scopes" in p] != []


def test_a_rejected_reload_is_read_as_the_spec_defines_it() -> None:
    """`reload()` returns the 422 `reload_rejected` answer's `reload` and `config`."""
    response = operations()["adminReload"][2]["responses"]["422"]
    schema = response["content"]["application/json"]["schema"]
    properties, required = flatten(schema, "openapi.yaml")
    assert {"reload", "config"} <= required
    for name, model in (("reload", m.ReloadReport), ("config", m.ConfigStatus)):
        prop, prop_base = properties[name]
        assert compare(prop, prop_base, model, f"adminReload 422.{name}") == []
