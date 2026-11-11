# live-sessions

A live broadcast layer for a mobile app: a host goes live, members watch, comment and react in real time, and the host can pull someone else on as a co-host.

Extracted and rewritten standalone from a production system I built and maintain: a multi-tenant platform of about 49,000 lines of TypeScript across 41 modules and 71 tables. No client code, data or configuration is in this repository.

**NestJS · TypeScript · Prisma · PostgreSQL · Socket.IO**

```
npm install
npx prisma generate
npm test
```

No database is needed to run the tests.

---

## The problem this solves

Ending a broadcast is something the host's app has to ask for. A force-close never asks. Neither does a crash, a flat battery, or the operating system reclaiming the app in the background.

So the session stayed standing. The live ring stayed lit on every member's home screen, and everyone who tapped it walked into an empty room. The only backstop was a six-hour cut-off — most of a day.

It was reported to me in one sentence: *"the live still continues even after closing the app."*

## The fix, and why it's shaped this way

The host's screen stamps the session every 20 seconds while it is live. A cron pass every minute closes anything that has gone quiet for **two** minutes.

Two minutes rather than one, because the two mistakes do not cost the same. Ending a real broadcast because the host walked behind a wall is far worse than a stale ring lasting one more minute. The grace window is deliberately generous next to the beat.

Three details that matter more than the idea:

**The heartbeat is scoped to the host's own live session.**
```ts
where: { id: sessionId, hostId: userId, isActive: true }
```
A viewer cannot prop up somebody else's broadcast, and a beat arriving for an ended session is a no-op rather than a resurrection.

**Sessions that predate heartbeats get the old six-hour rope.** A session with no beat at all isn't evidence of an absent host — it's evidence of an older client. Killing those on the first pass would mean shipping the fix ends broadcasts that are genuinely on air.
```ts
OR: [
  { lastHostBeatAt: { lt: cutoff } },                        // gone quiet
  { lastHostBeatAt: null, startedAt: { lt: legacyCutoff } }, // no beats at all
]
```

**It closes out properly, with an `endedAt`.** Not left null. That makes a reaped session read as *recently ended*, so the was-just-live ring behaves exactly as it does after a normal End, and the UI needs no special case for "died" versus "ended."

Clearing guests is deliberately swallowed with a `.catch()`. A failure there must never stop the session itself being closed — a stuck camera slot is recoverable, a broadcast that will not die is not.

## Real-time

One Socket.IO room per session. A comment costs one emit to the people actually watching, not a broadcast to everyone connected.

The gateway holds no business rules. The service writes, then asks the gateway to tell the room. That keeps every rule testable without standing up a socket server, which is why the suite needs no database and no server.

Viewer count is read off the room's own membership rather than tracked in a counter, so a dropped connection cannot leave a phantom viewer behind.

## Data model

| Table | What it carries |
|---|---|
| `LiveSession` | host, room, on-air flags, `lastHostBeatAt` |
| `LiveComment` | chat, with a one-level reply that snapshots its parent |
| `LiveCommentReaction` | one emoji per person per comment, uniquely constrained |
| `LiveReaction` | floating emoji on the broadcast itself |
| `LiveGuest` | co-host lifecycle: invited, active, declined, ended |

Two decisions worth naming:

**Author name and avatar are denormalised onto comments.** A past broadcast's history should still read correctly after someone deletes their account, and the feed renders without a join.

**Comment reactions are uniquely constrained on `(comment, user, emoji)`.** That one constraint is what makes reacting a toggle instead of a counter that only goes up — the same tap twice becomes a delete, with no read-modify-write race.

**Broadcast reactions are deliberately not deduplicated.** A hundred hearts is a hundred rows, because the volume is the point.

## Tests

17 unit tests, no database, no socket server. They cover the parts that are easy to get wrong and hard to notice:

- a dead host's broadcast is closed, a live one is left alone
- a pre-heartbeat session an hour old survives a deploy
- guests are ended *before* the session, and a failure clearing them still closes it
- a viewer's heartbeat cannot keep someone else's broadcast alive
- a heartbeat never throws, even with the database down
- comment reactions toggle
- only the host or an admin can end a broadcast

```
npm test
```

## Layout

```
src/live/
  live.service.ts          rules: sessions, heartbeat, reaper, comments, reactions, guests
  live-reaper.service.ts   the cron pass
  live.gateway.ts          Socket.IO fan-out, no business logic
  live.controller.ts       HTTP surface
prisma/schema.prisma
test/
```

## Licence

MIT.
