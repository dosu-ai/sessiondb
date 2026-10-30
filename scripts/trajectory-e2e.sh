#!/usr/bin/env bash
# End-to-end check of the Datadog Trajectory path against a running sessiondb server.
#
#   scripts/trajectory-e2e.sh [session.jsonl] [--keep] [--install]
#
# Takes a Trajectory session file (the daemon writes them to
# ~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl), ships it to the server
# twice, as one whole upload and as three chunks the way the file would grow during a live
# session, checks that both arrive at the same normalized session, reads it back, and
# tombstones both test sessions unless --keep is given.
#
# Which file: the path given, else the newest session file the daemon has written on this
# machine, else the fixture in testdata/ (with a note, since that is not a real session).
#
# Which server: SESSIONDB_URL and SESSIONDB_TOKEN. Without them, the local server
# (http://localhost:7200) and the first token in .env, so `bun start` in another terminal is
# enough. For production:
#   SESSIONDB_URL=https://sessiondb-23e1741-j2xb2lmnza-uw.a.run.app \
#   SESSIONDB_TOKEN=$(gcloud secrets versions access latest --secret sessiondb-tokens --project dosu-production | cut -d: -f2) \
#   scripts/trajectory-e2e.sh
#
# --install runs Datadog's installer for a local-only Trajectory (no Datadog API key, Claude
# Code hooked) so a real session file exists next time. It changes your Claude Code hooks;
# it is never run without the flag.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
keep=false
install=false
file=""
for arg in "$@"; do
  case "$arg" in
    --keep) keep=true ;;
    --install) install=true ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) file="$arg" ;;
  esac
done

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "need $tool on PATH" >&2; exit 1; }
done

if $install; then
  echo "Installing Datadog Trajectory, local-only, hooking Claude Code…"
  bash <(curl -fsSL https://raw.githubusercontent.com/datadog-labs/trajectory/main/install.sh) \
    --local-only --non-interactive --clients cc
  echo
  echo "Installed under ~/.trajectory. Run a Claude Code session, then run this script again:"
  echo "it will pick up the newest file under ~/.trajectory/trajectories/sessions/."
  exit 0
fi

# --- which server ---------------------------------------------------------------------------

url=${SESSIONDB_URL:-http://localhost:7200}
token=${SESSIONDB_TOKEN:-}
if [ -z "$token" ] && [ -f "$repo/.env" ]; then
  # first name:token pair of SESSIONDB_TOKENS, else SESSIONDB_TOKEN
  token=$(grep -E '^SESSIONDB_TOKENS=' "$repo/.env" | cut -d= -f2- | cut -d, -f1 | cut -d: -f2 || true)
  [ -n "$token" ] || token=$(grep -E '^SESSIONDB_TOKEN=' "$repo/.env" | cut -d= -f2- || true)
fi
[ -n "$token" ] || { echo "no token: set SESSIONDB_TOKEN, or put SESSIONDB_TOKENS in .env" >&2; exit 1; }

auth=(-H "Authorization: Bearer $token" -H "Content-Type: application/json")

if ! health=$(curl -fsS "$url/healthz/" 2>/dev/null); then
  echo "no server at $url (for local: run 'bun start' in another terminal)" >&2
  exit 1
fi
me=$(curl -fsS "$url/v1/me" "${auth[@]}") || { echo "token rejected by $url" >&2; exit 1; }
echo "server   $url  $(echo "$health" | jq -r '"v" + .version')"
echo "owner    $(echo "$me" | jq -r '.owner')  →  $(echo "$me" | jq -r '.storage.url')"

# --- which file -----------------------------------------------------------------------------

if [ -z "$file" ]; then
  file=$(ls -t "$HOME"/.trajectory/trajectories/sessions/*/session-*.jsonl 2>/dev/null | head -1 || true)
fi
if [ -z "$file" ]; then
  file="$repo/testdata/transcripts/datadog-claude-session.datadog-trajectory.jsonl"
  echo "file     $file"
  echo "         (no Trajectory session on this machine; this is the test fixture, which is small"
  echo "          enough to come back 'trivial'. Run with --install to capture a real one.)"
else
  echo "file     $file"
fi
[ -s "$file" ] || { echo "empty or missing: $file" >&2; exit 1; }

lines=$(grep -c '' "$file")
bytes=$(wc -c <"$file" | tr -d ' ')
client=$(grep -m1 '"session_start"' "$file" | jq -r '.client_source // "unknown"')
echo "content  $lines events, $bytes bytes, captured from $client"
echo

stamp=$(date +%s)
post() { # body on stdin → response json (any status)
  curl -sS "$url/v1/sessions" "${auth[@]}" --data-binary @-
}
field() { jq -r "$1" <<<"$2"; }

# --- 1. whole upload --------------------------------------------------------------------------

whole_id="e2e-whole-$stamp"
whole=$(jq -n --arg sid "$whole_id" --rawfile t "$file" \
  '{agent:"datadog-trajectory", session_id:$sid, transcript:$t, project:"e2e"}' | post)
if [ "$(field '.error // empty' "$whole")" != "" ]; then
  echo "whole upload refused: $(field '.error.code + ": " + .error.message' "$whole")" >&2; exit 1
fi
printf '%-8s %-8s records=%-5s bytes=%-7s prefix=%s\n' "whole" "$(field .status "$whole")" \
  "$(field .records_total "$whole")" "$(field .bytes_total "$whole")" "$(field '.prefix_sha256[0:12]' "$whole")"

# --- 2. the same file as three chunks ------------------------------------------------------------

chunk_id="e2e-chunk-$stamp"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
a=$(( lines / 3 )); b=$(( 2 * lines / 3 ))
[ "$a" -ge 1 ] || a=1; [ "$b" -gt "$a" ] || b=$(( a + 1 ))
head -n "$a" "$file" > "$tmp/1"
sed -n "$((a+1)),${b}p" "$file" > "$tmp/2"
tail -n +"$((b+1))" "$file" > "$tmp/3"

offset=0
last=""
for n in 1 2 3; do
  [ -s "$tmp/$n" ] || continue
  resp=$(jq -n --arg sid "$chunk_id" --rawfile t "$tmp/$n" --argjson off "$offset" \
    '{agent:"datadog-trajectory", session_id:$sid, transcript:$t, project:"e2e", offset:$off}' | post)
  if [ "$(field '.error // empty' "$resp")" != "" ]; then
    echo "chunk $n refused: $(field '.error.code + ": " + .error.message' "$resp")" >&2; exit 1
  fi
  printf '%-8s %-8s records=%-5s bytes=%-7s prefix=%s\n' "chunk $n" "$(field .status "$resp")" \
    "$(field .records_total "$resp")" "$(field .bytes_total "$resp")" "$(field '.prefix_sha256[0:12]' "$resp")"
  offset=$(field .bytes_total "$resp")
  last=$resp
done

# --- 3. same session either way? ------------------------------------------------------------------

echo
ok=true
for f in prefix_sha256 records_total bytes_total; do
  w=$(field ".$f" "$whole"); c=$(field ".$f" "$last")
  if [ "$w" = "$c" ]; then
    echo "✓ $f matches ($c)"
  else
    echo "✗ $f differs: whole=$w chunked=$c"; ok=false
  fi
done

# --- 4. read back -------------------------------------------------------------------------------

echo
meta=$(curl -fsS "$url/v1/sessions/datadog-trajectory/$chunk_id" "${auth[@]}")
echo "stored   status=$(field .status "$meta") raw_parts=$(field '.raw|length' "$meta") traces=$(field '.traces|length' "$meta") head=$(field '.head // "none" | .[0:12]' "$meta") source=$(field '.source // "-"' "$meta")"
if [ "$(field '.head // empty' "$meta")" != "" ]; then
  trace=$(curl -fsS "$url/v1/sessions/datadog-trajectory/$chunk_id/trace" "${auth[@]}")
  echo "trace    $(field '.events|length' "$trace") events; roles: $(field '[.events[].role] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "$trace")"
  redacted=$(grep -o '\[redacted:[a-z-]*\]' <<<"$trace" | sort | uniq -c | awk '{printf "%s×%s ", $2, $1}')
  echo "redacted ${redacted:-nothing}"
  echo "first    $(field '[.events[] | select(.role=="user")][0].text // "" | gsub("\n";" ") | .[0:110]' "$trace")"
else
  echo "trace    none: the session is under the worth-a-trace threshold (raw is stored; a real session gets a trace)"
fi

# --- 5. clean up ---------------------------------------------------------------------------------

echo
if $keep; then
  echo "kept $whole_id and $chunk_id (--keep)"
else
  for sid in "$whole_id" "$chunk_id"; do
    curl -fsS -X DELETE "$url/v1/sessions/datadog-trajectory/$sid" "${auth[@]}" >/dev/null
  done
  echo "tombstoned $whole_id and $chunk_id"
fi

$ok || { echo; echo "FAIL: whole and chunked uploads disagree" >&2; exit 1; }
echo
echo "OK"
