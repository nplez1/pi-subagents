# Scheduling — the reference a model needs to use `manage_schedules` correctly

`manage_schedules` is the model's only door to recurring and delayed work. The user's door is
`/loop` (pi-config). Both reach the same two execution homes, and a job either door creates is
visible to, and stoppable from, the other one.

This page is the full contract: every verb, the schedule grammar each home accepts, when a fire
actually happens, what survives what, the bounds, and the gotchas. The short version is in
[`README.md`](../README.md#scheduling).

## Verbs

| action | needs | what it does |
| --- | --- | --- |
| `create` | `schedule`, `prompt` | arm a job; `backend` picks the home (`cold` by default) |
| `preview` | `schedule` | the next fire times `create` would produce, with `backend` / `timezone` / `maxRuns` / `until` applied. **Arms nothing.** Refuses what `create` would refuse |
| `list` | — | every job in the session, both homes, one line each |
| `get` | `id` | one job, plus its failure policy and its last 10 fires (when, outcome, how late, slots skipped, the head of what it answered) |
| `update` | `id` + any field | change cadence, prompt, bounds, failure policy, and for cold the agent/model/thinking/turn cap/name/zone. Values the job already has are a no-op (`already has those values — nothing changed`), not an error; an update naming no field is refused |
| `run` | `id` | fire now, as an *extra* fire; the armed slot still fires |
| `pause` / `resume` | `id` | hold it (row and history kept) / re-arm its cadence. `resume` does not fire; `run` does |
| `cancel` | `id` | remove it for good. For a live loop this is the same act as `/loop stop <id>` (or `/loop cancel <id>`) |
| `pause_all` / `cancel_all` | — | every job in the session, optionally narrowed with `backend` |

Always use the `id` a `create` or `list` returned. Never ask the user to type a command; every
operation is reachable here.

## Two homes

| | `cold` (default) | `live` |
| --- | --- | --- |
| what fires | a fresh subagent per fire, in the background | the prompt re-enters **this** conversation as a user message |
| costs | a small fresh context per fire; nothing added to this transcript | the whole transcript every fire, and the fire's turns stay in it |
| result | arrives here as a notification | is the turn itself |
| agent knobs | `subagent_type`, `model`, `thinking`, `max_turns`, `name` | none: it runs on whatever this session runs on |
| owned by | this extension's scheduler | pi-config's `/loop` (`extensions/loop.ts`) |
| can it manage itself? | no — a fire has no scheduling tools; manage it from here | it is this conversation, so yes |

A job keeps the home it was created in. `update` with a different `backend` is refused; to move a
job, create a new one in the other home and cancel the old one.

## Schedule grammar

| form | cold | live | first fire |
| --- | --- | --- | --- |
| interval `30s` `25m` `2h` `1d` | yes | yes, floored at `1m` | cold: one interval after create · live: as soon as the creating turn ends |
| one-shot relative `+10m` | yes | yes | at that instant |
| one-shot ISO `2026-11-21T18:30:00-08:00` | yes | yes | at that instant |
| 6-field cron `0 0 9 * * 1` | yes, read in `timezone` | **no** — refused by name | the next matching wall-clock time |
| self-paced (no interval) | no | `/loop <prompt>` only, paced by `ScheduleWakeup` | — |

- Cron has **six** fields: `second minute hour day-of-month month day-of-week`. A 5-field expression is
  refused. `preview` before `create` is the cheap way to catch a misreading.
- `timezone` applies to cron only and is recorded on the job (defaulting to this machine's zone), so a
  cron job does not move with the machine. It is refused on an interval or one-shot.
- A one-shot is converted to an absolute instant **once, at create**, so it does not move afterwards.
  An ISO string without an offset (`2026-11-21T18:30:00`) is read in this machine's zone at that
  moment — give an offset or `Z` when the zone matters.

## When a fire actually happens

- **Live fires never steer a turn in flight.** A live fire that comes due while the session is busy
  waits for it to go idle, one fire per idle window, earliest-due first. While it waits, `list` says
  `due 4m ago, waiting for this session to go idle` and the footer says `1 due · waiting for idle`.
- **No catch-up, in either home.** A fire that comes late is one fire. The slots it ran past are not
  replayed; they are counted (`skipped N` in `list`, per fire in `get`) and the late fire records how
  late it was.
  - *Live*: the cadence stays on its original phase — after a late fire the next one is the next slot
    of the original rhythm, not "one interval after the late fire", so "every 2h" does not drift.
  - *Cold interval*: Node timers stop while the machine sleeps, so the interval resumes from the late
    fire's phase. The lateness and skipped slots are recorded; the phase is not restored. A forward
    wall-clock correction counts as lateness too: from inside the timer, an NTP jump and a sleep look
    the same.
  - *Cold cron*: croner schedules against the wall clock, so a slept-through slot is simply missed and
    the next matching time fires. It is not counted.
  - *Cold, still running*: a timer tick that finds the previous fire still running is skipped (scheduled
    fires bypass the concurrency queue, so stacking would put several agents on one prompt). Its own slot
    is counted, and so is every slot it arrived past — nothing fired in their place.
- **A closed session fires nothing.** On `/resume`, a live interval lands back on its phase, counts the
  slots that passed while closed, and says so once; it does not fire a burst. A live one-shot comes back
  at its own instant, and fires once at the first idle moment if that instant passed while closed. A cold
  job re-arms from the store; a cold one-shot whose instant passed while closed is disabled with an
  error and never fires.

## Bounds, lifetime and failure

- `maxRuns` (stop after N fires) and `until` (no fire at or after an instant) work in both homes, on
  create or update; `maxRuns: 0` and `until: ""` clear them. A bound reached by a fire is applied by
  that fire. **Bound every repeating job that should not run forever.**
- **Live TTL**: an *unbounded* live loop stops 7 days after it was created — it is removed at the mark,
  and only a fire already waiting for the session when the mark passes still lands. A live loop with
  `maxRuns` or `until` has its own end and is exempt. Clearing the last bound starts a fresh 7 days.
  Cold jobs have no TTL.
- **Failure policy** (both homes): after `pauseAfterFailures` failed fires in a row (default **3**;
  `0` never), the job pauses itself and says why (`paused after 3 failed fires in a row`). It is paused,
  not cancelled — read `get` for what went wrong, fix it, then `resume`, which resets the count. A cold
  fire fails when its agent ends in error/aborted/stopped or cannot be spawned; a live fire fails when
  any turn of it ends with `error` or `aborted`. A manual `run` that fails counts toward the streak, and
  a live fire interrupted with Esc ends `aborted`, so three interrupted fires also pause the loop.

## What survives what

| event | cold job | live loop |
| --- | --- | --- |
| `/resume` of the same session | restored | restored, on phase |
| `/new` or another session | not visible | not visible |
| pi restarted, then `/resume` | restored | restored |
| the session's cwd (worktree) deleted | gone with it | gone with it |

Both stores are per-session files under the session's cwd: `.pi/subagent-schedules/<sessionId>.json`
(cold) and `.pi/loops/<sessionId>.json` (live). Each directory writes its own `.gitignore` (`*`), so the
state never reaches a commit in whatever repository pi is running in.

## Limits

| limit | value | where |
| --- | --- | --- |
| live interval floor | 60 s | `loop.ts` `MIN_INTERVAL_MS` |
| live loops per session | 50 | `loop.ts` `MAX_LOOPS` |
| live TTL (unbounded loops) | 7 days | `loop.ts` `LOOP_TTL_MS` |
| `ScheduleWakeup` delay | clamped to 60–3600 s | `loop.ts` |
| self-paced fallback wakeup | 20 min, then the loop ends after a second silent tick | `loop.ts` `FALLBACK_WAKEUP_MS` |
| fires kept per job | 10 | `HISTORY_MAX` / `SCHEDULE_HISTORY_MAX` |
| fire summary | 280 chars of the answer's head | both |
| default failure policy | 3 in a row | `DEFAULT_PAUSE_AFTER_FAILURES` (both) |

## Gotchas

- A cold `prompt` must be self-contained: the fire starts in a fresh agent that cannot see this
  conversation.
- Cold intervals do not fire at create; live ones do (after the creating turn). `preview` shows both.
- `resume` re-arms the cadence; it does not fire. Use `run` for "now".
- `run` on a live loop is queued for the next idle window; on a cold job it starts immediately and is
  refused while the previous fire is still running.
- Turning scheduling off (`/agents → Settings → Scheduling`) stops cold jobs firing but keeps them
  listed and cancellable; it does not touch live loops.
- `ScheduleWakeup` only paces a self-paced `/loop`; it never creates scheduled work.

## Not supported, on purpose or not yet

- **Cron on live**: a wall-clock expression spanning days would fire into a transcript nobody is
  watching; use cold.
- **Per-job model or thinking on live**: a live fire is a turn of this session and runs on its model.
- **Moving a job between homes**: create and cancel.
- **Jitter and quiet hours**: two jobs armed "every 2h" at the same moment fire together, and a 3am slot
  fires at 3am. Bound the job with `until`, or pick a cron expression that skips the hours.
- **Cold interval phase restore after sleep**: recorded, not corrected (see above).
