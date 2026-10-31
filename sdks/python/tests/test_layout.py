"""The key layout agrees with the TypeScript SDK's: the golden bucket's keys are the ones the
Python builders produce for the same owner, agent, session and time."""

from datetime import UTC, datetime, timedelta

import pytest

from sessiondb import (
    LAYOUT_KEY,
    Keys,
    LayoutError,
    archive_id,
    assert_owner,
    change_stamp,
    lag_start,
    parse_change_key,
)
from tests.conftest import AUTH, OWNER


def test_archive_id_is_what_the_typescript_sdk_wrote(manifest):
    for session in manifest["sessions"]:
        if session["archive_id"]:
            assert (
                archive_id(OWNER, session["agent"], session["session_id"]) == session["archive_id"]
            )


def test_keys_spell_the_layout():
    keys = Keys("acme")
    archive = archive_id("acme", "claude-code", AUTH)
    assert keys.layout == LAYOUT_KEY == "sessionstorage.json"
    assert keys.probe == "owners/acme/.probe"
    assert keys.sessions == "owners/acme/sessions/"
    assert keys.changes == "owners/acme/changes/"
    assert keys.metadata(archive) == f"owners/acme/sessions/{archive}/metadata.json"
    assert (
        keys.trace(archive, "ab" * 32)
        == f"owners/acme/sessions/{archive}/trace.{'ab' * 32}.json.gz"
    )
    assert keys.raw(archive, 1, "json") == f"owners/acme/sessions/{archive}/raw.1.json.gz"
    at = datetime(2026, 10, 21, 21, 4, 5, 123000, tzinfo=UTC)
    assert (
        keys.change(at, "ab" * 32) == f"owners/acme/changes/20261021T210405.123Z-{'ab' * 32}.json"
    )
    assert keys.change(at, None) == "owners/acme/changes/20261021T210405.123Z-tombstone.json"


def test_change_stamp_is_utc_to_the_millisecond():
    at = datetime(2026, 10, 21, 23, 4, 5, 123456, tzinfo=UTC).astimezone(
        __import__("datetime").timezone(timedelta(hours=2))
    )
    assert change_stamp(at) == "20261021T230405.123Z"
    # Naive is taken as UTC.
    assert change_stamp(datetime(2026, 10, 21, 21, 4, 5)) == "20261021T210405.000Z"


def test_parse_change_key_round_trips_and_ignores_strays():
    key = "owners/acme/changes/20261021T210405.123Z-" + "ab" * 32 + ".json"
    parsed = parse_change_key(key)
    assert parsed is not None
    assert parsed.at == datetime(2026, 10, 21, 21, 4, 5, 123000, tzinfo=UTC)
    assert parsed.content_hash == "ab" * 32
    tomb = parse_change_key("owners/acme/changes/20261021T210405.123Z-tombstone.json")
    assert tomb is not None and tomb.content_hash is None
    assert parse_change_key("owners/acme/changes/notes.txt") is None
    assert parse_change_key("owners/acme/changes/20261021T210405.123Z-ab.json") is None


@pytest.mark.parametrize("owner", ["acme", "a", "team.one_two-3", "A" * 128])
def test_owner_is_one_path_segment(owner):
    assert assert_owner(owner) == owner


@pytest.mark.parametrize("owner", ["", ".hidden", "a/b", "a b", "-x", "A" * 129, "é"])
def test_owner_refuses_what_is_not_a_segment(owner):
    with pytest.raises(LayoutError):
        assert_owner(owner)


def test_lag_start_backs_the_cursor_off_by_the_window():
    at = datetime(2026, 10, 21, 21, 4, 5, tzinfo=UTC)
    assert lag_start(at, 300) == at - timedelta(minutes=5)
    assert lag_start(at, timedelta(hours=1)) == at - timedelta(hours=1)
    assert lag_start(None, 300) is None
