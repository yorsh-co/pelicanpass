#!/usr/bin/env bash
#
# Replaces identifying fields in the app's Pino NDJSON log with placeholders so
# an excerpt can be pasted to an external support assistant.
#
# Reads stdin, writes stdout, and emits exactly one JSON line per input line, so
# it works on a live stream. A line that is not a JSON object (a crash, a
# truncated write, a blank line) is wrapped as {"_raw": "..."} and scrubbed as
# text. Requires bash and jq 1.6 or later.
#
# Identifying keys are replaced wholesale. Every remaining string is scrubbed
# for emails, IP addresses, phone numbers, WhatsApp message ids and UUIDs. Ids
# in `url`, `path` and `route` become `:id`. The request id (`req.id`) and
# `runId` are kept, since they correlate lines and name no one.
#
# A ticket code is masked only under an identifying key such as `ticketCode`.
# In free text it is indistinguishable from an ordinary six-letter word, so it
# is left as is.
#
# Usage:
#   docker compose logs --since 10m --no-log-prefix app | strip-log.sh
#   docker compose exec -T app cat /var/log/pelicanpass/current.log | strip-log.sh

set -euo pipefail

exec jq -cR --unbuffered '
  def drop: [
    "ip", "xff", "cfIp", "userAgent", "remoteIp",
    "attendeeId", "adminId", "volunteerId", "username", "checkinNumber",
    "ticketCode", "to", "wamid", "sendId", "identifier", "mintedBy", "winner",
    "detail", "where", "internalQuery", "cookie", "token", "phoneStart",
    "client"
  ];
  def keep($parent; $key):
    ($parent == "req" and $key == "id") or $key == "runId";
  def hex($n): "[0-9a-fA-F]{\($n)}";
  def uuid: "\(hex(8))-\(hex(4))-\(hex(4))-\(hex(4))-\(hex(12))";
  def h: "[0-9a-fA-F]{1,4}";

  # An id segment in a URL: a UUID or a number.
  def maskpath:
    gsub("/(?:\(uuid)|[0-9]+)(?=[/?#]|$)"; "/:id");

  def scrub:
    gsub("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"; "[email]")
    | gsub("(?:::[fF]{4}:)?\\b(?:[0-9]{1,3}\\.){3}[0-9]{1,3}\\b"; "[ip]")
    | gsub("(?<![\\w:])(?:\(h):){7}\(h)(?![\\w:])"; "[ip]")
    | gsub("(?<![\\w:])(?:\(h):){1,6}:(?:\(h)(?::\(h)){0,5})?(?![\\w:])"; "[ip]")
    | gsub("(?<![\\w:])::(?:\(h)(?::\(h)){0,6})?(?![\\w:])"; "[ip]")
    | gsub("\\+\\d[\\d ()-]{8,}\\d|\\+?\\d{10,13}"; "[number]")
    | gsub("\\bwamid\\.[A-Za-z0-9=+/_-]+"; "[wamid]")
    | gsub(uuid; "[uuid]");

  def clean($parent; $key):
    if type == "object" then
      with_entries(
        if (.key | IN(drop[])) and .value != null then .value = "[stripped]"
        else .key as $k | .value |= clean($key; $k)
        end
      )
    elif type == "array" then map(clean($parent; $key))
    elif type == "string" then
      if keep($parent; $key) then .
      else (if $key | IN("url", "path", "route") then maskpath else . end) | scrub
      end
    else .
    end;

  # Keeps the key name so a truncated line still shows which field was removed.
  def raw:
    gsub("(?<k>\"(?:\(drop | join("|")))\")\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\"?"; "\(.k):\"[stripped]\"")
    | scrub;

  . as $line
  | (try fromjson catch null)
  | if type == "object" then clean(""; "")
    else {_raw: ($line | raw)}
    end
'
