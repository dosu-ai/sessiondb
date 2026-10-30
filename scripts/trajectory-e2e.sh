#!/usr/bin/env bash
# Fake a Datadog Trajectory session and ship it to a sessiondb server, whole and in chunks.
#
#   scripts/trajectory-e2e.sh [--keep] [--turns N] [session.jsonl]
#
# Writes a session file in the daemon's format (what `~/.trajectory/trajectories/sessions/`
# holds for a Claude Code session: session_start, prompts, tool calls and results, agent
# messages with thinking, turn ends, session_end), with a planted credential so redaction is
# visible. Ships it to the server as one whole upload and again as chunks, the way the file
# grows during a live session; checks both arrive at the same normalized session; reads the
# trace back; tombstones the test sessions unless --keep.
#
# A path replaces the fake: a real file from the daemon works as-is.
#
# Server: SESSIONDB_URL and SESSIONDB_TOKEN; without them, http://localhost:7200 and the first
# token in .env (so `bun start` in another terminal is enough). Production:
#   SESSIONDB_URL=https://sessiondb-23e1741-j2xb2lmnza-uw.a.run.app \
#   SESSIONDB_TOKEN=$(gcloud secrets versions access latest --secret sessiondb-tokens --project dosu-production | cut -d: -f2) \
#   scripts/trajectory-e2e.sh

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
keep=false
turns=4
file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep=true ;;
    --turns) turns=$2; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) file=$1 ;;
  esac
  shift
done
for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "need $tool on PATH" >&2; exit 1; }
done

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# --- a fake session, in the daemon's shape -----------------------------------------------------

fake_session() { # $1 = path to write; $2 = turns
  local out=$1 n=$2 sid seq=0 t0 ts turn id
  sid=$(uuidgen | tr 'A-Z' 'a-z')
  t0=$(date -u +%s)
  ts() { date -u -r $(( t0 + seq )) +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d "@$(( t0 + seq ))" +%Y-%m-%dT%H:%M:%S.000Z; }
  ev() { # $1 = event_type, rest = jq --arg/--argjson pairs already as a jq object literal in $2
    jq -nc --arg et "$1" --arg sid "$sid" --argjson seq "$seq" --arg ts "$(ts)" --argjson extra "$2" \
      '{sequence_number:$seq, client_source:"claude-code", session_id:$sid, event_type:$et, timestamp:$ts} + $extra' >>"$out"
    seq=$(( seq + 1 ))
  }
  : >"$out"
  ev session_start "$(jq -nc --arg ts "$(ts)" '{client_version:"2.1.283", format_version:1, git_branch:"james/fake-session", model:"claude-sonnet-4-5", next_turn_id:1, parent_session_id:null, project_dir:"/Users/james/Documents/dosu-global/sessiondb", provider:"anthropic", start_source:"startup", start_trigger:"fresh", started_at:$ts}')"
  ev inventory.snapshot '{"event_kind":"state","inventory_items":[{"id":"client:claude-code","kind":"client","name":"claude-code"}],"project":{"dir":"/Users/james/Documents/dosu-global/sessiondb"},"schema_version":1}'

  local prompts=(
    "Why does the chunked upload path return 409 when I resend the same chunk? Walk me through storeSession."
    "Add a test for a tool-only continuation chunk, then run the suite."
    "Now deploy it. The R2 creds are R2_ACCESS_KEY_ID=19bee4777777777777777777777777aa and R2_SECRET_ACCESS_KEY=93b63e0000000000000000000000000000000000000000000000000000ce0c, put them in Secret Manager."
    "Clean up anything the scanner removal left behind and open a PR."
    "What's left before I can point dosu-cli at production?"
    "Write the PR description."
  )
  local cmds=("bun run test" "rg -n 'OffsetMismatch' src" "gcloud secrets create sessiondb-tokens --data-file=-" "git status --short" "bunx biome check ." "gh pr create --fill")
  local files=("src/ingest/session.ts" "src/app.test.ts" "docs/server.md" "src/main.ts" "README.md" "package.json")

  for (( turn=1; turn<=n; turn++ )); do
    local p=${prompts[$(( (turn-1) % ${#prompts[@]} ))]}
    ev user_prompt "$(jq -nc --arg p "$p" --argjson turn "$turn" '{hour_of_day:20, input_source:"user", model:"claude-sonnet-4-5", prompt_type:"human", provenance:{actor_type:"human"}, turn_id:$turn, prompt:$p}')"

    id="toolu_$(printf '%02d' "$turn")Read$(openssl rand -hex 6)"
    local f=${files[$(( (turn-1) % ${#files[@]} ))]}
    ev tool_use "$(jq -nc --arg id "$id" --arg f "$f" --argjson turn "$turn" '{tool_use_id:$id, tool_name:"Read", tool_operation:"file.read", tool_type:"read", phase:"pre", provenance:{actor_type:"agent"}, turn_id:$turn, input:{file_path:$f}}')"
    ev tool_use "$(jq -nc --arg id "$id" --arg f "$f" --argjson turn "$turn" '{tool_use_id:$id, tool_name:"Read", tool_operation:"file.read", tool_type:"read", phase:"post", provenance:{actor_type:"agent"}, turn_id:$turn, success:true, is_interrupt:false, output_summary:("/** " + $f + " */\nexport async function storeSession(upload, options) {\n  const offset = upload.offset ?? 0;\n  if (offset > 0) {\n    const expected = existing?.normalized?.bytes ?? 0;\n    if (offset !== expected) throw new OffsetMismatch(offset, expected);\n  }\n  // … 140 more lines\n}")}')"

    id="toolu_$(printf '%02d' "$turn")Bash$(openssl rand -hex 6)"
    local c=${cmds[$(( (turn-1) % ${#cmds[@]} ))]}
    ev tool_use "$(jq -nc --arg id "$id" --arg c "$c" --argjson turn "$turn" '{tool_use_id:$id, tool_name:"Bash", tool_operation:"shell.execute", tool_type:"shell", phase:"pre", provenance:{actor_type:"agent"}, turn_id:$turn, input:{command:$c}}')"
    ev tool_use "$(jq -nc --arg id "$id" --argjson turn "$turn" '{tool_use_id:$id, tool_name:"Bash", tool_operation:"shell.execute", tool_type:"shell", phase:"post", provenance:{actor_type:"agent"}, turn_id:$turn, success:true, is_interrupt:false, output_summary:" Test Files  11 passed (11)\n      Tests  172 passed | 2 skipped (174)\n   Duration  784ms"}')"

    ev agent_message "$(jq -nc --argjson turn "$turn" --arg p "$p" '{has_thinking:true, model:"claude-sonnet-4-5", provenance:{actor_type:"agent"}, provider:"anthropic", content_blocks:["thinking","text"], tool_use_ids:[], turn_id:$turn, token_usage:{input_tokens:1840, output_tokens:412, total_tokens:2252}, thinking_text:("The user asked: " + $p + " The relevant code is in storeSession: a chunk must start exactly where normalized.bytes says the log ends, otherwise the server answers 409 with the expected offset so the client can resend from there. Resending an identical chunk therefore hits the mismatch because bytes_total already moved on. I should explain that, point at the test that covers it, and suggest the client keep bytes_total from the last answer."), text:("A chunk has to start at the session'"'"'s current `bytes_total`. When you resend a chunk the server already took, its `offset` is behind where the log now ends, so `storeSession` throws `OffsetMismatch` and the route answers `409 offset_mismatch` with `expected` set to the real end. That is deliberate: the client resumes from `expected` instead of guessing. The test for this is in `src/app.test.ts` under \"chunked uploads\"; I ran the suite and all 172 tests pass. Nothing else in the path changed.")}')"
    ev turn_end "$(jq -nc --argjson turn "$turn" '{model:"claude-sonnet-4-5", provider:"anthropic", turn_id:$turn, token_usage:{input_tokens:1840, output_tokens:412, total_tokens:2252}, tokens_status:"final"}')"
  done
  ev session_end "$(jq -nc --argjson n "$n" '{exit_reason:"exit", total_input_tokens:($n*1840), total_output_tokens:($n*412), total_turns:$n}')"
  echo "$sid"
}

# --- which server --------------------------------------------------------------------------------

url=${SESSIONDB_URL:-http://localhost:7200}
token=${SESSIONDB_TOKEN:-}
if [ -z "$token" ] && [ -f "$repo/.env" ]; then
  token=$(grep -E '^SESSIONDB_TOKENS=' "$repo/.env" | cut -d= -f2- | cut -d, -f1 | cut -d: -f2 || true)
  [ -n "$token" ] || token=$(grep -E '^SESSIONDB_TOKEN=' "$repo/.env" | cut -d= -f2- || true)
fi
[ -n "$token" ] || { echo "no token: set SESSIONDB_TOKEN, or put SESSIONDB_TOKENS in .env" >&2; exit 1; }
auth=(-H "Authorization: Bearer $token" -H "Content-Type: application/json")

health=$(curl -fsS "$url/healthz/" 2>/dev/null) || { echo "no server at $url (for local: run 'bun start' in another terminal)" >&2; exit 1; }
me=$(curl -fsS "$url/v1/me" "${auth[@]}") || { echo "token rejected by $url" >&2; exit 1; }
echo "server   $url  $(echo "$health" | jq -r '"v" + .version')"
echo "owner    $(echo "$me" | jq -r '.owner')  →  $(echo "$me" | jq -r '.storage.url')"

# --- which file ------------------------------------------------------------------------------------

if [ -z "$file" ]; then
  file="$tmp/session.jsonl"
  sid=$(fake_session "$file" "$turns")
  echo "file     fake Claude Code session $sid, $turns turns (a credential is planted in turn 3's prompt)"
else
  [ -s "$file" ] || { echo "empty or missing: $file" >&2; exit 1; }
  sid=$(grep -m1 '"session_start"' "$file" | jq -r .session_id)
  echo "file     $file ($sid)"
fi
lines=$(grep -c '' "$file"); bytes=$(wc -c <"$file" | tr -d ' ')
echo "content  $lines events, $bytes bytes"
echo

stamp=$(date +%s)
post() { curl -sS "$url/v1/sessions" "${auth[@]}" --data-binary @-; }
field() { jq -r "$1" <<<"$2"; }
refused() { # $1 label, $2 response
  if [ "$(field '.error // empty' "$2")" != "" ]; then
    echo "$1 refused: $(field '.error.code + ": " + .error.message' "$2")" >&2; exit 1
  fi
}
row() { printf '%-8s %-8s records=%-5s bytes=%-7s prefix=%s\n' "$1" "$(field .status "$2")" "$(field .records_total "$2")" "$(field .bytes_total "$2")" "$(field '.prefix_sha256[0:12]' "$2")"; }

# --- 1. whole --------------------------------------------------------------------------------------

whole_id="e2e-whole-$stamp"
whole=$(jq -n --arg sid "$whole_id" --rawfile t "$file" '{agent:"datadog-trajectory", session_id:$sid, transcript:$t, project:"github.com/dosu-ai/sessiondb"}' | post)
refused whole "$whole"; row whole "$whole"

# --- 2. chunks: the file as it would grow, one upload per turn ----------------------------------------

chunk_id="e2e-chunk-$stamp"
split -l 7 "$file" "$tmp/part." # 7 events per turn in the fake; any line boundary is fine
offset=0; last=""; n=0
for part in "$tmp"/part.*; do
  n=$(( n + 1 ))
  resp=$(jq -n --arg sid "$chunk_id" --rawfile t "$part" --argjson off "$offset" '{agent:"datadog-trajectory", session_id:$sid, transcript:$t, project:"github.com/dosu-ai/sessiondb", offset:$off}' | post)
  refused "chunk $n" "$resp"; row "chunk $n" "$resp"
  offset=$(field .bytes_total "$resp"); last=$resp
done

# --- 3. same session either way? ------------------------------------------------------------------------

echo
ok=true
for f in prefix_sha256 records_total bytes_total; do
  w=$(field ".$f" "$whole"); c=$(field ".$f" "$last")
  if [ "$w" = "$c" ]; then echo "✓ $f matches ($c)"; else echo "✗ $f differs: whole=$w chunked=$c"; ok=false; fi
done

# --- 4. read back --------------------------------------------------------------------------------------
# The chunked session's head is its last continuation (only the final chunk's records), so the
# whole upload's trace is the one to read for the full conversation.

echo
meta=$(curl -fsS "$url/v1/sessions/datadog-trajectory/$chunk_id" "${auth[@]}")
echo "chunked  status=$(field .status "$meta") raw_parts=$(field '.raw|length' "$meta") traces=$(field '.traces|length' "$meta") head=$(field '.head // "none" | .[0:12]' "$meta") source=$(field '.source // "-"' "$meta") branch=$(field '.branch // "-"' "$meta")"
wmeta=$(curl -fsS "$url/v1/sessions/datadog-trajectory/$whole_id" "${auth[@]}")
if [ "$(field '.head // empty' "$wmeta")" != "" ]; then
  trace=$(curl -fsS "$url/v1/sessions/datadog-trajectory/$whole_id/trace" "${auth[@]}")
  echo "trace    $(field '.events|length' "$trace") events; $(field '[.events[].role] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "$trace")"
  redacted=$( (grep -o '\[redacted:[a-z-]*\]' <<<"$trace" || true) | sort | uniq -c | awk '{printf "%s×%s ", $2, $1}')
  echo "redacted ${redacted:-nothing}"
  if grep -q '93b63e0000' <<<"$trace"; then echo "✗ the planted secret is in the trace"; ok=false; fi
  echo "turn 3   $(field '[.events[] | select(.role=="user")][2].text // "" | .[0:150]' "$trace")"
else
  echo "trace    none: under the worth-a-trace threshold (raw stored, no head)"
fi

# --- 5. clean up -------------------------------------------------------------------------------------

echo
if $keep; then
  echo "kept $whole_id and $chunk_id (--keep)"
else
  for s in "$whole_id" "$chunk_id"; do curl -fsS -X DELETE "$url/v1/sessions/datadog-trajectory/$s" "${auth[@]}" >/dev/null; done
  echo "tombstoned $whole_id and $chunk_id"
fi
echo
$ok && echo "OK" || { echo "FAIL" >&2; exit 1; }
