# Concepts — the backend and AI ideas this project uses

**Who this is for:** you, coming from 7 years of frontend, needing to explain every moving part of
this system out loud without hand-waving.

**How to use it:** read this first, then [`flows.md`](flows.md) to see the concepts in motion, then
[`interview-prep.md`](interview-prep.md) to rehearse. [`hld.md`](hld.md) and [`lld.md`](lld.md) are
the formal design docs — they assume you already know everything below.

Nothing here is generic tutorial material. Every concept is one this codebase actually uses, and
each section ends with **where it lives in the repo**.

---

## Part 1 — The backend half

### 1.1 What a "server" actually is here

A Node process that never exits. It opens a TCP port and waits.

```ts
// api/src/index.ts — the entire startup
const app = createApp();
app.listen(env.PORT, () => console.log(`API on http://localhost:${env.PORT}`));
```

That's it. `app.listen` binds port 4000 and hands control to Node's event loop. From then on, every
incoming HTTP request is a callback fired on that loop.

**The frontend bridge:** you already understand this — it's `addEventListener`, but the event source
is a network socket instead of the DOM, and it runs forever instead of until navigation.

**The consequence that matters:** it's *one process*, and Node is single-threaded for JavaScript. If
one request blocks the loop with synchronous CPU work, *every other user waits*. This is why
password hashing (`argon2`, deliberately slow) uses `@node-rs/argon2` — a native Rust addon that
runs on libuv's threadpool, not on the main thread — and why embedding calls are `await`ed network
I/O rather than local computation.

📁 [`api/src/index.ts`](../api/src/index.ts)

---

### 1.2 Express, middleware, and the request pipeline

Express is a thin router over Node's HTTP server. Its one big idea is the **middleware chain**: a
request passes through an ordered list of functions, each of which can read it, modify it, respond
to it, or pass it along by calling `next()`.

```
request → cors → express.json → [route-specific middleware] → handler → response
                                                          ↘ (thrown error)
                                                            errorHandler
```

A middleware is just:

```ts
(req, res, next) => { /* do something */ next(); }
```

**The frontend bridge:** it is Redux middleware, or an axios interceptor chain, or React Router
loaders — same shape, same "each layer can short-circuit or enrich and pass on."

**Order is load-bearing, and this project leans on that hard.** From
[`app.ts`](../api/src/app.ts#L111-L123):

```ts
app.use("/queries",
  requireAuth,           // 1. must be first — everything below reads req.user.id
  queryBurstLimiter,     // 2. 10/min
  queryDailyLimiter,     // 3. 50/day — burst rejection must not spend daily budget
  globalQueryLimiter,    // 4. 2000/day shared
  limitConcurrent(2, …), // 5. last — it holds state for the request's LIFETIME
  queryRouter,
);
```

Each position has a reason. Swap 2 and 3 and a flood drains the user's daily budget before the cheap
burst check rejects it. Move 5 earlier and it increments a counter for requests that are about to be
rejected anyway — a slow leak that eventually locks a user out of their own account.

**Two things you must know about Express 5 specifically** (this project uses 5.2, not 4):

1. **Async errors are forwarded automatically.** In Express 4, `throw` inside an `async` handler was
   an unhandled rejection that crashed nothing and answered nothing — you needed
   `try/catch + next(err)` in every route. Express 5 catches it and routes it to the error
   middleware. That's why every route in this repo is a bare `async (req, res) => { … }` with no
   try/catch, and it still produces correct 400s and 404s.
2. **Error middleware is identified by arity.** A function taking *four* arguments
   `(err, req, res, next)` is an error handler. Four is the signal. That's why
   [`error.ts`](../api/src/middleware/error.ts#L47) takes `_next` it never uses — dropping the
   unused parameter would silently turn it into a normal middleware and every error would become an
   unhandled 500.

📁 [`api/src/app.ts`](../api/src/app.ts) · [`api/src/middleware/`](../api/src/middleware/)

---

### 1.3 The layering: routes → service → lib

Every backend feature in this repo is split three ways. This is the single most important structural
idea in the codebase, and it's the one an interviewer will probe.

| Layer | Knows about | Never knows about | Example |
|---|---|---|---|
| **route** | `req`, `res`, status codes, validation | business rules, SQL | [`document.routes.ts`](../api/src/modules/documents/document.routes.ts) |
| **service** | business rules, the database, orchestration | HTTP, Express, `res` | [`document.service.ts`](../api/src/modules/documents/document.service.ts) |
| **lib** | one technical capability, done well | the feature it serves | [`embed.ts`](../api/src/lib/embed.ts), [`chunk.ts`](../api/src/lib/chunk.ts) |

**The frontend bridge:** this is exactly "keep logic out of the component." A route is the component
— it deals with the transport (props/events for you, HTTP here). A service is the custom hook or
store — pure logic, testable without rendering. A lib is the utility module.

**How to prove it's real, not decorative:** grep the service layer for `express`. Zero hits. That's
what makes these facts true:

- `answerQuestion()` can be called from a test, a CLI script, or a queue worker without booting a
  server.
- The transport can change — NDJSON today, WebSocket tomorrow — without reopening the logic that
  decides what an answer *is*.
- `ingestDocument()` will become a background-job handler later **with its exact current signature**
  ([`lld.md §4.2`](lld.md#42-target---enqueue-and-return)). That's the payoff, banked in advance.

**The related trick: `createApp()` instead of a top-level app.** Wiring lives in a function; only
`index.ts` calls `.listen()`. A test can `import { createApp }` and hit routes in memory via
supertest, with no port, no teardown, no flakiness.

That seam is now spent rather than merely banked: the HTTP tests exercise the **real** middleware
chain in its real order — no stubbed guards, no fake app. Which is the only version where an
ordering bug can actually appear, and one promptly did. `express.json()` is mounted app-wide, so it
runs *ahead* of `requireAuth`: an oversized body on a protected route returns `413`, not `401`. That
is correct, it is the opposite of most people's first guess, and it is now pinned by an assertion
rather than left to be rediscovered.

---

### 1.4 Validation at the boundary — zod

Every request body is untrusted. `zod` is a runtime schema validator that parses unknown input into
a typed value, or throws.

```ts
// api/src/modules/queries/query.schema.ts
export const askSchema = z.object({
  question: z.string().trim().min(1, "Question is required").max(1000, "…"),
  k: z.number().int().min(1).max(10).default(5),
});
export type AskInput = z.infer<typeof askSchema>;   // ← type derived FROM the validator
```

**The frontend bridge:** it's form validation, but the "form" is an HTTP body sent by someone who
might be hostile. And unlike frontend validation, this one is load-bearing — the client-side copies
in [`DocumentForm.tsx`](../web/src/components/DocumentForm.tsx#L26-L35) exist only to save a
round-trip.

**Four details in this project worth being able to explain:**

| Detail | Why |
|---|---|
| `z.infer` gives the TS type | One source of truth. A TypeScript `interface` describes *compile time* and evaporates at runtime; zod does both. |
| `.trim()` **before** `.min(1)` | Refinements run left to right. `.min(1).trim()` measures `"   "` as 3 chars → passes → *then* trims to `""`. You'd store an empty title with no error. |
| `userId` is **absent** from every schema | Ownership comes from the verified token, never the body. If `userId` were a field, any user could write into another's library by editing one line of JSON. |
| Unknown keys are **stripped**, not rejected | zod's object default. A client POSTing `status: "READY"` to skip the ingestion pipeline just has it dropped. |

The same library validates the *environment* at boot
([`env.ts`](../api/src/lib/env.ts)) — a missing `OPENAI_API_KEY` kills the process at startup with a
readable message, instead of throwing inside a request three hours later.

📁 [`api/src/modules/*/[name].schema.ts`](../api/src/modules/) · [`api/src/lib/env.ts`](../api/src/lib/env.ts)

---

### 1.5 Passwords: hashing is not encryption

**Encryption is reversible** (you hold a key, you can get the plaintext back). **Hashing is not** —
it's one-way by design. Passwords are hashed, never encrypted, because the server never needs to
*read* a password; it only needs to check whether a candidate produces the same hash.

Why not SHA-256, which is also one-way?

| Approach | Attack on a leaked DB |
|---|---|
| Plaintext | Every account compromised instantly |
| SHA-256 / MD5 | A GPU tries **billions of guesses per second**. Common passwords fall in seconds. |
| **argon2id** | Deliberately slow **and memory-hard** — each guess needs a large chunk of RAM, which is what neuters GPU parallelism |

`argon2id` is the current OWASP recommendation. Two things it gives you for free:

- **Salt** — a random value per password, so two users with the same password get different hashes,
  and a precomputed rainbow table is useless. The library generates it and stores it *inside* the
  output string alongside the algorithm parameters, so you never manage salts by hand.
- **Params baked into the digest** — `verify()` re-derives using whatever cost parameters were used
  at hash time, so raising the cost later doesn't invalidate old hashes.

```ts
// api/src/modules/auth/password.ts — note the argument order
export function verifyPassword(digest: string, plain: string): Promise<boolean> {
  return verify(digest, plain);   // stored digest FIRST, candidate second
}
```

**The deliberate contrast in this repo:** `hashContent()` in
[`document.service.ts`](../api/src/modules/documents/document.service.ts#L42-L44) uses plain SHA-256
with **no salt** — because there we *want* identical input to collide. That's the whole point of a
dedupe fingerprint. Same primitive family, opposite requirement. Being able to articulate that
contrast is a good signal in an interview.

📁 [`api/src/modules/auth/password.ts`](../api/src/modules/auth/password.ts)

---

### 1.6 JWT — how the server knows who you are

HTTP is stateless. Every request arrives with no memory of the last one. Something must carry
identity.

A **JWT** (JSON Web Token) is three base64url segments joined by dots:

```
eyJhbGciOiJIUzI1NiJ9  .  eyJzdWIiOiJ1c2VyLTEyMyIsImVtYWlsIjoi…  .  4pcPyMD09olPSyXnrXCjTw
     header                        payload (claims)                      signature
   {"alg":"HS256"}      {"sub":"user-123","email":"…","iat":…,"exp":…}
```

**The single most misunderstood fact, and interviewers ask it:** a JWT is **signed, not encrypted**.
Anyone holding the token can base64-decode the payload and read it. Paste one into jwt.io and you'll
see your own email. What they *cannot* do is change a value and produce a matching signature without
`JWT_SECRET`.

So the rules follow directly:
- Never put secrets in the payload — it's public.
- Always set a short expiry (this project: **1 hour**).
- The server stores nothing. Verification is a local HMAC computation, no DB round-trip.

```ts
// api/src/lib/jwt.ts
const alg = "HS256";            // HMAC-SHA256 — symmetric: one secret both signs and verifies
new SignJWT({ email })
  .setProtectedHeader({ alg })
  .setSubject(claims.sub)       // "sub" = subject = the user id (a JWT-standard claim)
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(secret);
```

**Why `jose` and not `jsonwebtoken`:** `jose` is ESM-native and built on Web Crypto, so it runs in
edge runtimes. That means this exact `verifyToken` can later be reused inside a Next.js middleware
for server-side route protection. `jsonwebtoken` depends on Node's `crypto` and can't.

**Why HS256 (symmetric) rather than RS256 (asymmetric):** one service both issues and verifies, so a
shared secret is the simpler correct choice. RS256 earns its keep when *other* services must verify
tokens without being able to mint them — that's a multi-service concern this system doesn't have.
Say exactly that if asked; "because it's the default" is the wrong answer.

**The trade-off you must own:** stateless means **you cannot revoke a token**. `logout()` in
[`auth-context.tsx`](../web/src/lib/auth-context.tsx#L100-L108) deletes the browser's copy; the token
itself stays valid until it expires. The fix is short-lived access tokens + a refresh token with a
server-side revocation list — designed, deliberately not built, and flagged as such.

📁 [`api/src/lib/jwt.ts`](../api/src/lib/jwt.ts) · [`api/src/middleware/auth.ts`](../api/src/middleware/auth.ts)

---

### 1.7 CORS — why the browser blocks you and curl doesn't

The **same-origin policy** is a browser rule: JS on `localhost:3000` may not read a response from
`localhost:4000` unless that server explicitly opts in. Different port = different origin.

Key points:
- **It's enforced by the browser, not the server.** `curl` and Postman ignore CORS entirely. It is
  *not* an authentication mechanism — it stops other *websites* reading your API on a user's behalf,
  nothing more.
- The server opts in with `Access-Control-Allow-Origin`. The `cors` middleware sets it.
- For non-simple requests the browser first sends an `OPTIONS` **preflight** asking "may I send this
  method and these headers?" — which is why an `Authorization` header triggers one.

```ts
app.use(cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true }));
```

Naming an explicit origin rather than `*` matters: with `credentials: true`, a wildcard is illegal,
and the moment auth moves to cookies you'd have to fix it anyway.

📁 [`api/src/app.ts`](../api/src/app.ts#L45-L50)

---

### 1.8 The database: Postgres, Prisma, and migrations

**Postgres** is the relational store. **Prisma** is the ORM — you describe tables in
`schema.prisma`, and it generates a fully typed client.

```prisma
model Document {
  id          String    @id @default(uuid())
  userId      String
  contentHash String
  status      DocStatus @default(PENDING)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  chunks Chunk[]
  @@unique([userId, contentHash])
  @@index([userId, createdAt(sort: Desc)])
}
```

**The frontend bridge:** Prisma is to SQL roughly what a typed API client is to raw `fetch` — you
get autocomplete and compile-time errors instead of stringly-typed calls. And like a typed client,
it can only protect you as far as its type coverage reaches (see `$queryRaw` in §1.9).

**Migrations** are the versioned history of your schema — the git of your database. Each is a
timestamped `.sql` file in `prisma/migrations/`, applied in order and recorded in a
`_prisma_migrations` table so it runs exactly once. The alternative (editing tables by hand) means
dev, staging and prod drift apart with no record of how.

Two commands, and the difference is a real gotcha in this repo:

| Command | What it does | Use when |
|---|---|---|
| `prisma migrate dev` | diffs schema vs DB, **generates** a migration, applies it, **detects drift** | local development |
| `prisma migrate deploy` | applies pending migrations only, **no drift detection** | production — *and here* |

⚠️ **`migrate dev` is unsafe on this database.** Prisma models the vector column as
`Unsupported("vector(1536)")` — it knows the column exists but understands nothing about it, so it
cannot represent the HNSW index in `schema.prisma`. `migrate dev` sees an index it can't account
for, calls it drift, and helpfully generates a `DROP INDEX` to "fix" it. Your vector search then
silently falls back to a sequential scan: still correct, quietly slow. Use `migrate deploy`.

**Indexes** are the same idea as a hash map: without one, finding rows means reading every row
(`O(n)` sequential scan). The two on `Document` each exist for a specific query:

- `@@unique([userId, contentHash])` — enforces the dedupe rule *in the database*, so two concurrent
  uploads of the same text cannot both succeed no matter how the application code races.
- `@@index([userId, createdAt(sort: Desc)])` — serves `listDocuments` exactly. Postgres seeks to
  this user's slice and walks it **already sorted**, with no sort step at all.

**Cascade deletes:** `onDelete: Cascade` means deleting a User deletes their Documents, which
deletes their Chunks. Enforced by Postgres, not by application code that might forget.

📁 [`api/prisma/schema.prisma`](../api/prisma/schema.prisma) · [`api/prisma/migrations/`](../api/prisma/migrations/)

---

### 1.9 Transactions, and why they appear twice here for different reasons

A **transaction** is a group of statements that all commit or all roll back. The classic framing is
ACID; the practical framing is "no half-written state."

This codebase uses transactions in two places, and they are there for **completely different
reasons**. Knowing which is which is a good interview differentiator.

**(a) Ingestion — the classic reason: atomicity.**

```ts
await prisma.$transaction(async (tx) => {
  await tx.chunk.createMany({ … });          // insert chunk text
  for (…) await tx.$executeRaw`UPDATE "Chunk" SET embedding = …`;  // then vectors
  await tx.document.update({ data: { status: "READY", chunkCount } });
}, { timeout: 30_000, maxWait: 5_000 });
```

Without this, a crash mid-write leaves half the chunks saved *and* the document marked `READY` — a
document that looks searchable and silently isn't.

Note what is deliberately **outside** it: `chunkText()` and `embedFn()`. Holding a Postgres
transaction open across a multi-second network call to OpenAI would pin a connection from a small
pool for the whole round-trip. That's a classic way to turn a slow dependency into a database
outage.

**(b) Retrieval — an unusual reason: scoping `SET LOCAL`.**

```ts
await prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = 100`);
  await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = 'strict_order'`);
  return tx.$queryRaw`SELECT … ORDER BY c.embedding <=> …`;
});
```

There is nothing to make atomic — it's a read. The transaction exists purely because **`SET LOCAL`
is scoped to a transaction and reverts on commit.** Plain `SET` would mutate the *connection's
session*, and with a pool that connection goes to the next request — one query's tuning silently
becomes global configuration for whoever gets that connection next. A genuinely nasty class of bug:
non-deterministic, load-dependent, invisible in dev.

**Connection pooling**, since it just came up: opening a Postgres connection is expensive, so a pool
keeps a few open and hands them out per query. That's *why* session state leaks across requests, and
why the `prisma` client is a module-level singleton guarded against `tsx watch` hot-reloads —
without the guard, each save spawns a new pool and eventually exhausts Neon's connection limit.

📁 [`api/src/lib/prisma.ts`](../api/src/lib/prisma.ts) · [`api/src/lib/retrieve.ts`](../api/src/lib/retrieve.ts#L97-L127)

---

### 1.10 Raw SQL, and the one place the compiler stops helping

Prisma cannot express `ORDER BY embedding <=> $1::vector` — it has no model of pgvector's operators.
So retrieval drops to `$queryRaw`, and that has two consequences you should be able to state
without prompting:

**1. Types become a promise, not a proof.**

```ts
tx.$queryRaw<ChunkRow[]>`SELECT c.id AS "chunkId", …`
```

`<ChunkRow[]>` is an *unchecked cast*. Whatever you write there is what TypeScript believes; nothing
verifies it against the actual SELECT list. Rename a column and you get a runtime `undefined`, not a
compile error.

**2. Tenant isolation stops being structural and becomes a line you must not delete.**

```sql
WHERE d."userId" = ${userId}
```

Everywhere else in the codebase, ownership is enforced through Prisma's query builder where
`where: { userId }` is type-checked. Here, deleting that line **breaks no test, produces no type
error, and turns the endpoint into a full-corpus search across every user in the database.** That is
precisely why [`retrieve.ts`](../api/src/lib/retrieve.ts#L1-L16) opens with a comment block saying
so.

**Is `${userId}` injectable?** No — Prisma's tagged template turns interpolations into **bind
parameters** ($1, $2), which Postgres treats as data, never as SQL. The `$executeRawUnsafe` calls
above them are the exception, and they're safe for one specific reason: Postgres does not accept
bind parameters in `SET` (it parses as configuration, not a query), so string interpolation is the
only option — and both interpolated values are module-level constants, never request-derived. If
either ever became caller-controlled, that's SQL injection immediately.

**The related pattern — IDOR, and how it's prevented.** *Insecure Direct Object Reference* is when a
user reads someone else's row by guessing its id. The tempting shape:

```ts
const doc = await prisma.document.findUnique({ where: { id } });
if (doc.userId !== userId) throw new HttpError(403);   // ← one forgotten `if` from a breach
```

versus what this codebase does:

```ts
const document = await prisma.document.findFirst({ where: { id, userId } });
if (!document) throw new HttpError(404, "Document not found");
```

Ownership is *in the query*, so it cannot be omitted by a later edit. And note the status code:
**404, not 403** — a 403 would confirm the id exists, letting an attacker enumerate ids to map
another user's library. The response itself would become an oracle.

📁 [`api/src/lib/retrieve.ts`](../api/src/lib/retrieve.ts) · [`api/src/modules/documents/document.service.ts`](../api/src/modules/documents/document.service.ts#L256-L288)

---

### 1.11 Rate limiting and concurrency — two different problems

**A rate limiter bounds requests per time window.** It does not bound dollars and it does not bound
concurrency. This project needs all three answers.

**Why two limiters on the same route:**

- `10/min` alone permits **14,400 requests/day**.
- `50/day` alone permits **all 50 in one second**.

Burst and budget are different problems and one window cannot express both. Mounted burst-first so a
flood is rejected by the cheap short window and never consumes the daily budget it was trying to
drain.

**What you key on decides whether the limit means anything:**

| Route type | Key | Why |
|---|---|---|
| Unauthenticated (signup/login) | IP **subnet**, via `ipKeyGenerator` | No identity exists yet. Subnet, not exact address — an IPv6 client typically gets a whole /64 and could otherwise rotate through more addresses than there are IPv4 addresses on Earth. |
| Authenticated (ingest/query) | `req.user.id` | An IP is shared behind corporate NAT and changed at will on mobile data — simultaneously too coarse and too easy to escape. **The account is what costs money, so the account gets the budget.** |

**`trust proxy` is the setting that makes all of it real or fake.** In production the TCP socket
belongs to the platform's edge (Vercel's), not the user, so `req.ip` is the proxy unless Express is
told otherwise. It's set to `1` — a **hop count**, not `true`:

- Unset → every request on Earth shares one bucket; the first stranger to trip a limit locks out
  everyone.
- `true` → "trust the whole `X-Forwarded-For` chain." Anyone can send that header, so an attacker
  mints a fresh unlimited bucket per request. The limiter is still there, still reporting, and
  **enforcing nothing.**

**`skipSuccessfulRequests` on login** is the difference between stopping credential stuffing and
punishing a real user with two devices: only *failed* logins consume the budget.

**Concurrency is the separate problem.** Ten requests arriving in the same millisecond all pass a
`10/min` limit — and on a streaming route that's ten simultaneous LLM generations from one account.
A stream isn't a request that finishes in 20ms; it holds an expensive resource open for many
seconds. Hence [`concurrency.ts`](../api/src/middleware/concurrency.ts), an in-memory `Map` of
in-flight counts per user.

The subtle bug it's shaped to prevent: a counter incremented on the way in and decremented on a path
that doesn't always run **leaks**, and a leaked counter locks a user out of their own account
permanently, with no error to point at. So release listens on `close` — which Node fires for *both*
"finished normally" and "client vanished." Adding `finish` as belt-and-braces would be exactly
wrong: on a successful response both fire, double-decrementing, and the count drifts negative until
the cap silently stops applying. A `released` flag makes it idempotent either way.

**Where the counters live, and why the two answers differ.** The rate limiters use **Redis**
(`rate-limit-redis` + `ioredis`); the concurrency guard stays an in-memory `Map`. That is not an
inconsistency — they count different things:

- A **rate limit** is a claim about an account, which exists independently of any process. In memory
  it is exact on one instance and meaningless on many: the effective limit becomes
  `limit × instance count` and a "global" cap becomes per-instance, while every `RateLimit` header
  keeps reporting correctly. On an autoscaling platform that is a limiter that enforces nothing, so
  `REDIS_URL` is **required in production** — the process refuses to boot without it rather than
  degrading silently.
- A **concurrency count** is a claim about open sockets, which *are* owned by this process. A shared
  Redis counter would be worse: it would need a lease with a timeout to survive an instance dying
  mid-stream, where a `Map` simply cannot outlive the sockets it counts. It is not broken, it is
  scoped — the cross-instance reading ("2 streams per user") became "2 per instance", and the
  per-user *cost* bound it used to double as is now the Redis limiters' job.

**The trap the swap actually contained,** since "one line, everything goes through `makeLimiter()`"
was right about the seam and wrong about the cost: `rate-limit-redis` prefixes every store with `rl:`
by default, and the 1-minute and 1-day query limiters both key on `req.user.id`. Sharing a prefix
means both `INCR` the same key with different expiries — the burst window silently resets the daily
budget. Nothing errors. So `name` is a **required** field on the limiter config, not optional with a
default: the type system is the only thing that makes it impossible to forget.

📁 [`api/src/middleware/rate-limit.ts`](../api/src/middleware/rate-limit.ts) · [`api/src/middleware/concurrency.ts`](../api/src/middleware/concurrency.ts) · [`api/src/lib/redis.ts`](../api/src/lib/redis.ts)

---

### 1.12 Streaming, NDJSON, and async generators

**The problem:** a full answer takes several seconds to generate. Waiting for all of it, then
sending one JSON blob, means a user stares at a spinner. Streaming sends each fragment as it's
produced.

**The format: NDJSON** — newline-delimited JSON, one complete JSON object per line.

```
{"type":"sources","sources":[…]}
{"type":"token","value":"The"}
{"type":"token","value":" retriever"}
{"type":"done","answer":"The retriever runs first [2]."}
```

**Why not Server-Sent Events (SSE), the usual answer?** This is a **constraint, not a preference**,
and it's a great thing to be asked about. SSE's browser client is `EventSource`, and `EventSource`
**cannot set request headers**. Auth here is `Authorization: Bearer <token>`. SSE would force the
token into a query string — where it lands in server access logs, browser history, and `Referer`
headers — or force an immediate move to cookies. `fetch` + `ReadableStream` reads a stream just as
well and sends headers normally.

**Why NDJSON over a raw text stream?** Every event needs structure — sources, tokens and errors are
different shapes. `JSON.parse` per line is the entire client-side parser. The one rule it imposes —
no literal newline inside an event — is already guaranteed by `JSON.stringify`, which escapes them
as `\n`.

**The central constraint of any streaming endpoint:** *a response has exactly one status code, and
it is committed the instant the first byte leaves.* Before that, an error can be a clean 500/429/401.
After it, the client has been told `200 OK` and is parsing a body — a thrown error just truncates the
stream, which looks identical to a network drop.

So the error path forks on one question — **have headers been sent?**

```
not yet  → rethrow → normal error middleware → real HTTP status
already  → in-band {type:"error"} event → res.end() cleanly
```

**Async generators are what make that work.** A generator body is **lazy** — not one line runs until
the caller pulls the first value:

```ts
const events = queryService.answerQuestion({ … });  // ← nothing has executed yet
for await (const event of events) { … }             // ← NOW retrieval runs
```

Because retrieval happens on the first pull, a DB outage or an OpenAI 429 while embedding still
throws while a real status code is available. If the service fetched eagerly, *every* failure would
become a truncated 200.

**The frontend bridge:** `async function*` + `for await` is the same shape as an async iterator over
a `ReadableStream`. `break` cancels, `try/catch` catches, `finally` cleans up — ordinary control
flow, which is exactly why it beats callbacks or an EventEmitter here.

📁 [`api/src/modules/queries/query.routes.ts`](../api/src/modules/queries/query.routes.ts) · [`web/src/lib/api.ts`](../web/src/lib/api.ts#L207-L295)

---

### 1.13 Two stream-parsing bugs worth memorising

Both live in [`streamAsk`](../web/src/lib/api.ts#L244-L294), and both have the same character:
*works in dev, fails in production.*

**(a) `TextDecoder` needs `{ stream: true }`.**

A UTF-8 character is up to 4 bytes, and a network chunk can split one down the middle. Without the
flag, `TextDecoder` treats every chunk as a complete document and emits `` for the dangling bytes.
With it, the decoder holds the partial character back until the rest arrives. **This only breaks on
non-ASCII output** — which is why it reliably survives to production.

**(b) A network chunk has nothing to do with a line boundary.**

One `read()` can deliver two and a half events; the next delivers the missing half. So:

```ts
buffer += decoder.decode(value, { stream: true });
let newline: number;
while ((newline = buffer.indexOf("\n")) !== -1) {
  const line = buffer.slice(0, newline).trim();
  buffer = buffer.slice(newline + 1);       // remainder stays buffered
  if (line) yield JSON.parse(line) as QueryEvent;
}
```

`JSON.parse(chunk)` without buffering works perfectly on short answers and fails on long ones — the
worst possible failure schedule, because it passes every quick manual test.

---

### 1.14 File uploads — multipart, and the limit that doesn't apply

A JSON body is one string. A file upload isn't: `multipart/form-data` splits the body into **parts**,
each with its own headers, separated by a random token called a **boundary**:

```
Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryX7dK9

------WebKitFormBoundaryX7dK9
Content-Disposition: form-data; name="title"

Q3 handbook
------WebKitFormBoundaryX7dK9
Content-Disposition: form-data; name="file"; filename="q3.pdf"
Content-Type: application/pdf

%PDF-1.7 …binary…
------WebKitFormBoundaryX7dK9--
```

Three things follow from that layout, and each one is a bug people hit exactly once:

**1. Body parsers are content-type-gated.** `express.json()` is not a general body reader — it
checks `Content-Type` first, and if it isn't `application/json` it calls `next()` having read zero
bytes. So `express.json({ limit: "1mb" })` **never engages on an upload**, and multer's
`limits.fileSize` is the only ceiling that exists. Assume otherwise and you have shipped an
unbounded upload while believing you configured a limit.

> **Frontend analogy:** event delegation. One listener on the container fires for every click, but
> the handler opens with `if (!e.target.matches('.btn')) return`. Express stacks `express.json()`,
> `express.urlencoded()` and multer precisely because each self-selects on content type and ignores
> everything else.

**2. Never set `Content-Type` yourself when sending `FormData`.** The browser generates it
*including* the boundary token, and that token is what tells the server where each part begins.
Hard-code the header and the boundary is missing; the server is told "this is multipart" and handed
a body it cannot split. The failure looks like a backend bug, which is where you'll waste the
afternoon.

```ts
// ✅ browser fills in Content-Type: multipart/form-data; boundary=…
fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
```

**3. Every string in that body is attacker-controlled — including the ones that look like
metadata.** `Content-Type: application/pdf` on the file part is a claim *the client wrote*. So is
`filename`. Multer surfaces the first as `file.mimetype` and the second as `file.originalname`, and
neither has been verified by anything. `curl -F "file=@evil.html;type=application/pdf"` sets them
to whatever it likes.

The check that means something is the **magic bytes** — the actual leading bytes of the content. A
PDF starts with `%PDF-`. That is evidence; the header is testimony.

```ts
const PDF_MAGIC = Buffer.from("%PDF-");
buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
```

Be precise about how much that buys, because overclaiming it is worse than not doing it: magic bytes
are **necessary, not sufficient**. They prove the file *starts* like a PDF, not that it is valid or
safe. The real guarantee is that the parser either succeeds or throws — plus, here, that the bytes
are never stored and never served back, which is what forecloses the classic upload-HTML →
served-back → browser-sniffs-it → stored-XSS chain.

**Memory vs. disk storage.** `multer.memoryStorage()` keeps the file in a `Buffer`; `diskStorage`
writes it to a temp path you must then clean up on *every* path, including the failures. Memory is
right here because the file exists only long enough to become text, and it is only safe because
`limits.fileSize` bounds how much memory that can be. Reverse that reasoning — memory storage with
no size cap — and you have a one-request out-of-memory kill.

**A second multipart route makes one of these harder.** Voice input uploads a recording, and audio
gets a *different* size cap from a PDF — a PDF's is sized by the platform's request-body limit, a
recording's by what a minute of audio costs to transcribe. Two caps, one error handler, and the
handler only ever sees a `MulterError`. Whichever number is written into that 413 is then correct on
one route and wrong on the other, and a wrong limit is worse than no limit, because the user trusts
it and retries just under it.

The discriminator that exists is `err.field`, the form field the limit was hit on — `file` for a
document, `audio` for a recording. That works here for a reason worth noticing rather than assuming:
the field name is part of each route's published contract, not an incidental detail, so keying an
error message to it is not a coincidence. A field the handler doesn't recognise omits the number
entirely rather than guessing.

Magic bytes do a second job on audio that they don't do on PDFs. The transcription API picks its
**demuxer from the filename extension**, and browsers disagree about what they record — Chrome and
Firefox emit WebM, Safari emits MP4. If the client names the file, a Safari recording labelled
`.webm` fails *inside the paid call*, for something the first twelve bytes could have answered for
free. So the client sends bytes with no name at all, and the server names the file from what it
finds. The signatures are worth knowing because they are not all at offset zero:

```
1A 45 DF A3      at byte 0    EBML  → WebM/Matroska
"ftyp"           at byte 4    ISO   → MP4/M4A   ← preceded by a size field
"OggS"           at byte 0          → Ogg
"RIFF" … "WAVE"  at 0 and 8         → WAV       ← RIFF alone is also AVI and WebP
```

📁 [`api/src/lib/pdf.ts`](../api/src/lib/pdf.ts) ·
[`api/src/lib/audio.ts`](../api/src/lib/audio.ts) ·
[`api/src/modules/documents/document.routes.ts`](../api/src/modules/documents/document.routes.ts)

---

## Part 2 — The AI half

### 2.1 What RAG is, and what it is not

**RAG = Retrieval-Augmented Generation.** In one sentence: *don't ask the model what it knows — find
the relevant passages first, and ask it to answer using only those.*

```
question → [retrieve relevant chunks from YOUR data] → [stuff them into the prompt] → answer + citations
```

**The problem it solves.** An LLM's knowledge is frozen at training time and contains nothing
private. Ask it about your company handbook and it will produce something fluent and wrong. That's
**hallucination** — and the reason it's dangerous is that a hallucinated answer and a correct one
look *identical*: confident prose either way.

**The three alternatives, and why RAG wins here** (interviewers ask this):

| Approach | What it does | Why not here |
|---|---|---|
| **Fine-tuning** | Retrain weights on your data | Expensive, slow, must be redone for every new document, teaches *style* far better than *facts*, and gives you **no citations** |
| **Long context** | Paste all documents into every prompt | Cost scales with corpus size × every query; hits the context window; and accuracy *degrades* as context grows ("lost in the middle") |
| **RAG** | Retrieve the top-k relevant passages per query | Cost is bounded per query, new documents are live the moment they're ingested, and **every claim is traceable to a source** |

**What RAG is not:** it is not a fix for a bad retriever. If retrieval returns the wrong passages,
the model answers from the wrong passages — confidently. **Most "the AI is wrong" bugs in a RAG
system are retrieval bugs**, not model bugs. Which is exactly why
[`SourceList.tsx`](../web/src/components/SourceList.tsx#L69-L79) surfaces the raw cosine similarity
on screen: a top hit at 0.31 means retrieval found nothing relevant, which is a completely different
bug from the model misreading a good chunk.

---

### 2.2 Embeddings — the one idea to actually understand

An **embedding** is a list of numbers representing the *meaning* of a piece of text. In this project
each one is 1,536 floating-point numbers — a point in 1,536-dimensional space.

```
"How do I reset my password?"  →  [0.021, -0.118, 0.334, …]   (1536 numbers)
"I forgot my login credentials" →  [0.019, -0.121, 0.341, …]   ← lands nearby
"The mitochondria is the …"     →  [-0.442, 0.087, -0.203, …]  ← lands far away
```

The model that produces these was trained so that **text with similar meaning lands in nearby
positions.** That is the entire trick, and everything else in the retrieval stack is bookkeeping on
top of it.

**Why this beats keyword search.** Postgres full-text search for "reset password" would miss "I
forgot my login credentials" — zero words in common. Embeddings match on meaning, not on characters.
(The honest counterpoint, worth volunteering: keyword search *beats* embeddings on exact identifiers
— error codes, SKUs, proper nouns. Production systems often run both and merge, called **hybrid
search**. That's a genuine known gap here, not a defect you have to hide.)

**Why 1,536?** It's what `text-embedding-3-small` outputs. It's a fixed property of the model, which
is why the DB column is declared `vector(1536)` — the two must match exactly.

**The rule that shapes the whole system:** the question and the documents must go through the **same
embedding model**. Vectors from two different models live in unrelated coordinate spaces, so the
distance between them is a meaningless number that *still sorts and still looks plausible*. This is
why `EMBED_MODEL` is a **hardcoded constant** in [`embed.ts`](../api/src/lib/embed.ts#L3) while
`CHAT_MODEL` is an **env var**:

- Swapping the chat model = a deploy-config decision.
- Swapping the embedding model = **every vector in the database is now garbage** and the entire
  corpus must be re-embedded.

Making that a flag anyone can flip would be a footgun with no warning label. That asymmetry is one
of the best decisions in this codebase to talk about.

**Batching:** the API caps inputs per call, so `embed()` walks the array in strides of 100 and
appends each batch's results in order. It sorts each response by `index` defensively, so the output
is guaranteed aligned with the input — the caller can zip vectors back onto chunks by position.

📁 [`api/src/lib/embed.ts`](../api/src/lib/embed.ts)

---

### 2.3 Chunking — why documents get cut up

You cannot embed a 50-page document as one vector. Two reasons:

1. **Input limits.** The model caps input length.
2. **Dilution — the real reason.** One vector for a whole document is the *average* of everything in
   it. A document covering ten topics produces a vector that is close to nothing in particular. Ask
   about topic 3 and it doesn't match well, because topics 1, 2 and 4–10 dragged the average away.

So: split into ~1,000-character pieces, embed each separately. Retrieval then returns *the specific
passage*, which is also what makes citation meaningful — you can point at the paragraph, not the
file.

**Overlap.** Neighbouring chunks share 200 characters. Without it, a sentence straddling a boundary
is split across two chunks and fully present in neither — so the passage that actually answers the
question is retrievable from neither side. Overlap costs ~20% more storage and buys never losing a
citation to a seam.

**"Recursive" splitting.** `RecursiveCharacterTextSplitter` tries the largest natural boundary first
— paragraphs, then lines, then sentences, then words — so chunks stay semantically coherent instead
of being sliced mid-word every 1,000 characters. A chunk cut mid-sentence embeds badly, because half
a thought has a muddled meaning.

```ts
// api/src/lib/chunk.ts
export async function chunkText(text, { chunkSize = 1000, chunkOverlap = 200 } = {}) { … }
// returns [{ content, chunkIndex }, …]  — chunkIndex maps 1:1 to Chunk.chunkIndex, making it cite-able

export async function chunkPages(pages: string[], opts?) { … }
// the PDF path: splits each page independently
// returns [{ content, chunkIndex, page }, …]  — chunkIndex still runs across the whole document
```

**Structure-aware chunking, and the trade it forces.** A PDF arrives as an array of pages, so each
page is split *independently* and every chunk carries its page number. That is the entire reason
PDF upload is worth building: a citation becomes *"page 7"* — something a reader can open the file
and check — instead of *"chunk 12"*, an internal ordinal they have no way to look up. A citation
nobody can verify is just a claim with a number next to it.

It is not free, and the cost is the interesting part:

- **The page boundary becomes a *hard* chunk boundary.** Overlap only applies within one splitter
  call, so a paragraph spanning a page break is split with nothing bridging it. Accepted
  deliberately: a chunk covering two pages has no single honest page to cite, and a *wrong*
  citation is worse than a split paragraph.
- **`chunkSize` gains a second maximum that appears in no config file — the length of a page.** A
  300-page PDF with one short paragraph per page yields ~300 tiny chunks instead of ~45 well-sized
  ones. Follow that through: small chunks embed into vague vectors that match on surface keywords
  rather than meaning; `k = 5` then feeds the model ~750 characters of context instead of ~5,000;
  the model hedges or refuses; and it looks like a *prompt* problem when it is a *chunking*
  problem. That misdiagnosis is the expensive part.

The fix is a merge pass over consecutive short pages — which immediately breaks the data model,
because the merged chunk spans pages 4–9 and `Chunk.page` holds one integer. So it is a schema
change, not a tweak. Left unbuilt on purpose: whether it matters depends entirely on the corpus
(dense pages make the problem vanish), and that is a question hit-rate@k can answer and judgement
cannot. **"I shipped the simple version and let a measurement decide" is a stronger answer than
having guessed correctly.**

**The mechanism is now reproducible on demand.** The eval corpus renders each source document at two
page densities — same words, different amount per page. At the dense rendering chunking behaves
normally: the median chunk sits just under the configured ceiling, and almost nothing falls below
300 characters. At the sparse rendering it collapses.

The tell in the collapsed case isn't the chunk count, it's this: **the chars-per-page and
chars-per-chunk distributions are identical** — same minimum, same median, same p90, same maximum.
That can only happen if every page produced exactly one chunk, which means `chunkSize: 1000` never
got a vote. The page boundary had already decided every split. The median chunk then lands well
under half the configured size, and a substantial minority fall below 300 characters.

> Exact counts are deliberately absent, for a reason worth noticing: **this document is one of the
> corpus sources.** Printing a figure here changes the corpus and therefore the figure — adding this
> very paragraph moved the sparse rendering by a page. Statistics about a corpus don't belong inside
> it. `pnpm eval:inspect` prints current numbers; the *shape* above is what's stable.
>
> **That rule was stated here and then broken in the paragraph above it.** Earlier revisions read
> "median chunk ~330, ~38% under 300" — an exact claim wearing a disclaimer. Both figures were
> already wrong when written and moved again on the next documentation pass, while the sentences
> around them still read as current. The claims that have survived every rebuild are the structural
> ones: pages equal chunks exactly, the two distributions match at every quantile, and the
> configured chunk size is never consulted. Those are properties of the rendering. Percentages are
> properties of whatever the docs happened to say that week.

Be precise about what this does and does not show. It demonstrates the **mechanism**, not the
**cost**: "vague vectors retrieve badly" remains a plausible story about retrieval, not evidence
about it. Running the identical golden set against each rendering — everything else held constant —
makes page density the only variable that moved, which is what turns the delta into an attributable
number. Until then the merge pass stays unbuilt.

**Own the honest caveat:** 1000/200 were chosen by judgement, not measurement. Smaller chunks =
precise matches but fragmentary context; larger = richer context but diluted vectors and a more
expensive prompt. Settling this empirically is exactly what the eval harness (M7) exists for. Saying
*"chosen by judgement, and here's how I plan to measure it"* is a much stronger answer than
inventing a justification.

📁 [`api/src/lib/chunk.ts`](../api/src/lib/chunk.ts)

---

### 2.4 Vector search, cosine distance, and HNSW

**Retrieval** = embed the question, then find the stored chunks whose vectors are closest.

**Cosine distance** measures the *angle* between two vectors, ignoring magnitude — which is what you
want, since a longer passage shouldn't score differently just for being longer.

| `<=>` returns | Meaning |
|---|---|
| `0` | identical direction |
| `1` | orthogonal / unrelated |
| `2` | opposite |

**Lower is better** — the opposite of the intuition most people bring to a "score." That's exactly
why the field is named `distance`, and why `similarity = 1 - distance` is computed once in
[`retrieve.ts`](../api/src/lib/retrieve.ts#L158-L165) rather than re-derived (and inverted by
mistake) in a template.

**pgvector** is the Postgres extension adding the `vector` type and the distance operators (`<=>`
cosine, `<->` L2, `<#>` inner product).

**HNSW** — *Hierarchical Navigable Small World* — is the index. Comparing a question against every
chunk is `O(n)`: fine at 2,500 chunks, fatal at 25 million. HNSW builds a navigable graph where each
node links to near neighbours plus a few long-range "highways," so search hops toward the answer in
roughly logarithmic time.

**It is approximate.** It can miss a true nearest neighbour. That's the trade for sub-linear search,
and it's tunable:

| Knob | Value here | Effect |
|---|---|---|
| `m = 16` | build time | edges per node — higher = better recall, bigger index |
| `ef_construction = 64` | build time | candidate list while building — higher = better graph, slower build |
| `hnsw.ef_search = 100` | **query time** | how hard to search before giving up. pgvector's default is 40; 100 is a deliberate over-spend — unmeasurable at this corpus size, noticeably better recall |

**Why HNSW and not IVFFlat** (the other pgvector index): IVFFlat must be built on data that already
exists, to learn its cluster centroids. Building it on an empty or tiny table produces a permanently
bad index. HNSW builds incrementally and stays correct as rows arrive — the only sane option for a
table that grows one upload at a time.

**The operator class is load-bearing.** The index is declared `USING hnsw (embedding
vector_cosine_ops)`, which pairs with `<=>`. Query with `<->` instead and Postgres **does not
error** — it silently ignores the index and sequential-scans every row. A slow correct answer: the
failure mode that survives to production because nothing is ever red.

**The filtered-search recall problem** — the most sophisticated thing in this file, and a strong
interview topic. An HNSW index knows only about vectors; it has no idea which rows belong to which
user. So Postgres walks the index in distance order and *then* discards rows failing
`d."userId" = …` — **post-filtering**. Ask for the top 5, and the scan may surface 40 candidates that
all belong to other users, leaving you with two results, or none.

The query is still **correct** — never another tenant's data — but it silently **under-returns**, and
it degrades as more users join. The emptiest results land on the newest customers.

pgvector 0.8's **iterative scan** exists for exactly this: when the filter eats the candidate set,
keep scanning deeper instead of returning short.

```sql
SET LOCAL hnsw.iterative_scan = 'strict_order'
```

`strict_order` guarantees results still arrive in true distance order. `relaxed_order` is faster but
can return them slightly out of order — which would make "top match" not actually the top match.

*The alternative design*, worth naming because it shows you considered it: denormalise `userId` onto
`Chunk` and build per-tenant **partial indexes**. Genuinely faster at scale, but it multiplies index
count by tenant count and needs a backfill. Iterative scan is the right trade until there's real
traffic to argue otherwise.

📁 [`api/src/lib/retrieve.ts`](../api/src/lib/retrieve.ts) · [`api/prisma/migrations/20260725120000_chunk_embedding_hnsw/migration.sql`](../api/prisma/migrations/20260725120000_chunk_embedding_hnsw/migration.sql)

---

### 2.5 The prompt: grounding, temperature, refusal, citations

Retrieved chunks are formatted into numbered sources and sent with a system prompt.

```
system: 6 numbered rules
user:   Sources:

        [1] (from "Q3 Handbook", chunk 0)
        <chunk text>

        ---

        [2] (from "Q3 Handbook", chunk 4)
        <chunk text>

        ---

        Question: <the user's question>
```

**Each rule defends against a specific failure**, which is the right way to talk about a prompt —
not as prose, but as a list of defended failure modes:

| Rule | Failure it prevents |
|---|---|
| 1–2: answer only from sources, never from training data | The model answering from pretraining. It knows plenty about most topics; the *entire value* of RAG is answering from **your** data, and a plausible answer from the wrong source is worse than none. |
| 3: cite every claim inline `[2]` | Uncited claims. If it isn't traceable to a chunk, the user cannot verify it and "grounded with citations" is decoration. |
| 4: emit the `REFUSAL` string verbatim | Hedging. Left to its judgement the model writes a different apology every time, and a waffle is indistinguishable from a weak answer. |
| 5: don't speculate or extrapolate | The "helpful" instinct to fill gaps with adjacent context. |
| 6: be concise | Padding costs output tokens and buries the answer. |

**`temperature: 0`.** Temperature controls randomness in token selection. This is grounded QA, not
creative writing — every degree of creativity is a degree of freedom to invent something the sources
don't say. It *also* makes evals meaningful: under a non-deterministic model, a regression is
indistinguishable from noise.

**The fixed `REFUSAL` constant** is a small decision with outsized value:

```ts
export const REFUSAL = "I don't have enough information in your documents to answer that.";
```

A verbatim string is **UI-detectable** and **eval-assertable**. "Say you don't know" produces
untestable variety. And when retrieval returns zero chunks, `streamAnswer` yields this constant
directly with **no model call at all** — the model cannot answer from empty context, so asking is a
guaranteed refusal that costs a round-trip and real money. Both paths emit the identical string, so
they're indistinguishable to the client.

**Context before question.** Models attend most reliably to a prompt's start and end, so the
question landing last keeps it in the strongest position. A stable prefix also makes **prompt
caching** possible later, since caching keys on a shared leading substring.

**Sources numbered from 1, not 0.** These markers appear in prose a human reads; `[0]` looks like a
typo. The `n → sources[n-1]` off-by-one then lives in exactly one place (the frontend renderer)
rather than being re-derived at each call site.

**Citations are validated on render.** A model *can* hallucinate `[7]` when only 5 sources were
sent. [`AnswerView.tsx`](../web/src/components/AnswerView.tsx#L78-L83) checks each marker against the
real source list, so an invented one renders as inert grey text instead of a button that scrolls
nowhere.

**Tokens and cost, briefly.** Models bill per token (~4 characters of English). Input and output are
priced separately, output higher. Your per-query cost is roughly: one small embedding of the
question + (5 chunks × ~1000 chars ≈ 1,250 input tokens) + the answer's output tokens. That's the
arithmetic behind the rate-limit numbers — they're sized from unit cost, not from caution.

📁 [`api/src/lib/answer.ts`](../api/src/lib/answer.ts)

---

### 2.6 Evaluation — the milestone in progress, and why it matters

**Own this gap; don't hide it.** Several numbers in this system were chosen by judgement:
`k = 5`, `chunkSize = 1000`, `chunkOverlap = 200`, `ef_search = 100`.

An **eval harness** replaces judgement with measurement. The shape:

- **A golden set** — questions with known correct answers over a fixed corpus.
- **Retrieval hit-rate@k** — for each question, does the chunk that actually contains the answer
  appear in the top k? *This measures the retriever alone, isolated from the model* — which matters
  because most RAG failures are retrieval failures.
- **Groundedness** — is every claim in the answer supported by a cited chunk?
- **Refusal accuracy** — does it refuse when it should, and *only* when it should? Both directions
  are failures: refusing an answerable question is as broken as inventing one.

`temperature: 0` was chosen partly to make this possible. Under a non-deterministic model you cannot
tell a regression from noise.

#### The three design decisions that make it work

**1. Ground truth is anchored to text, not to chunk IDs.** The obvious design — "the answer to Q3
is in chunk 7" — destroys itself. The whole point is to vary `chunkSize`, and every re-ingest
recreates chunk rows with different boundaries and different indexes, so the ground truth would be
invalidated by the very experiment it exists to score. A golden question therefore stores short
distinctive **substrings** that must appear verbatim in the supporting text; a chunk is a hit if it
contains one. Chunking-invariant, and no judge required.

The edge case that makes this non-trivial: an anchor long enough to be distinctive can straddle a
chunk boundary at small `chunkSize` and then exist in *no* chunk, so every config scores zero and
you debug retrieval instead of the fixture. Hence a validation pass that runs first and reports such
a question as `INVALID` rather than as a miss.

**2. The corpus is our own writing, because contamination — not size — is what invalidates a RAG
eval.** If the model already knows the answer, it produces a correct-looking response whether
retrieval worked or not. Hit-rate can be zero and the answer still reads as right, which is the most
misleading result the harness could report. Text written for this repo cannot be in any training
set, which makes contamination structurally impossible rather than merely unlikely.

**3. hit-rate@k cannot choose `k` on its own.** It is monotonically non-decreasing in `k`, so
`k = 10` always "wins" — a metric that can only ever recommend the maximum is not deciding anything.
`k` is settled by hit-rate *plus* answer quality *plus* tokens per answer. The expected shape is a
plateau around 3–5 while cost keeps climbing.

#### What is built, and what is not

Built: a **42-test suite** that runs with no database, no network and no spend, and a **reproducible
corpus builder** that renders the source documents at two page densities. Not built: the golden set
and every metric above. **No accuracy figure is claimed anywhere in this repo, because none has been
measured.**

The corpus builder has already returned one result — see §2.3, where the page-boundary problem stops
being an argument and becomes a table.

"I have a working system and I know exactly which numbers I haven't yet justified" is a *senior*
answer. "It works great" is not.

---

### 2.7 Conversational RAG — why a follow-up breaks everything

Everything up to here assumed one self-contained question. The moment there are two turns, the
system breaks in a way that is worth understanding properly, because the *symptom* points at the
wrong component.

**The setup.** Retrieval works by turning the question into a vector and finding the nearest chunk
vectors (§2.2). That only works if the question carries its own meaning. Watch what happens when it
doesn't:

```
Turn 1  "What does the handbook say about parental leave?"
        → embeds near the parental-leave passage        ✅ correct chunk retrieved

Turn 2  "How long is it?"
        → embeds near… pronouns? duration? nothing.     ❌ retrieves noise
        → the prompt sees irrelevant context
        → the prompt correctly emits REFUSAL
        → user sees "I don't have enough information in your documents"
```

**Every component did its job.** The embedder embedded honestly. The index returned the true nearest
neighbours. The prompt refused because the context genuinely didn't contain the answer. And the
product is broken.

This is the most important debugging lesson in the whole system: **in RAG, the visible failure is
almost never where the bug is.** A confident wrong answer and an unnecessary refusal both usually
mean retrieval got the wrong chunks, and retrieval getting the wrong chunks usually means it was
handed the wrong query.

#### The fix: rewrite before you retrieve

Insert a step *before* embedding. Give a model the conversation plus the follow-up, and ask for a
standalone question:

```
history:  "What does the handbook say about parental leave?"
          "Zephyr grants 18 weeks of paid parental leave to any employee…"
input:    "How long is it?"
output:   "What is the duration of parental leave?"   ← THIS is what gets embedded
```

The industry name for this is a **condense** step, or a *history-aware retriever*. It costs one
extra model call, and it is skipped entirely on turn 1 — a first question is standalone by
definition, so rewriting it into itself would add latency and cost for nothing.

> **Frontend analogy:** it's a normalisation layer. The same reason you normalise a phone number
> before comparing it, rather than teaching every comparison about formatting. The embedder is not
> going to learn about pronouns; you fix the input instead.

#### The second problem: some follow-ups aren't questions

```
"Make that shorter."      "Explain it more simply."      "Put that in bullets."
```

There is no standalone question hiding in "make that shorter." Rewriting it produces nonsense.
Searching for it retrieves whatever the corpus's *least* relevant chunks happen to be — semantic
search always returns something (§2.4) — and the prompt then refuses. So the user asks for a shorter
answer and is told their documents don't cover it.

The fix is to let the rewriter say **"no search needed"** — here, by emitting a `NO_SEARCH` sentinel.
Those turns skip retrieval entirely and re-ground on the *previous* turn's sources, which are already
stored. No embedding call, no database query: it's the fastest path in the app.

That produces the split worth memorising:

| | drives |
|---|---|
| the **rewritten** query | what we look up |
| the **original** question | what we say |

Feed the rewrite to the generator instead and "make that shorter" becomes a re-answer of a question
nobody asked.

#### The third problem: citation numbers collide

Each turn retrieves its own chunks and numbers them `[1]`, `[2]`, `[3]` from scratch. So turn 1's
`[2]` and turn 3's `[2]` are *different passages*. Two consequences:

- **In the UI**, every answer must render against the source list it was built from — which is why
  citations are stored per-message rather than per-conversation.
- **In the prompt**, replaying old answers with their markers intact invites the model to reuse a
  numbering that no longer means anything. So markers are stripped from history first.

…except on a re-use turn, where the sources *are* the previous turn's, so the markers are still
valid. Getting this wrong caused a genuinely instructive bug: with markers stripped, the model was
shown its own previous answer containing no citations, asked to make it shorter, and dutifully
produced a shorter answer containing no citations. A system-prompt rule demanding citations was
added — and lost.

**A demonstration in the context window beats an instruction in the system prompt.** When a model
ignores a rule, check what the prompt is *showing* it before you write another rule.

#### What this costs, honestly

Every one of these is a real trade, not a free win:

- **One extra model call per follow-up**, on the critical path, before retrieval can even start.
- **A new failure mode**: a rewrite that drops the user's intent produces *confident retrieval of
  the wrong passage* — which looks exactly like a retrieval regression and isn't one. This is why
  the rewritten query is shown in the UI rather than hidden.
- **The eval story gets harder.** hit-rate@k on a multi-turn thread now measures rewrite *and*
  retrieval together, so a regression can't be attributed. §2.6's numbers are still clean for
  `/ask`, which is exactly why that endpoint was left untouched.

Every failure in the rewriter therefore falls back to searching the raw question — the behaviour the
app had before conversations existed. **A quality improvement should never be able to take down the
thing it improves.**

---

### 2.8 Speech — the part of the AI half that is not RAG

Voice is the easiest feature here to build badly, because the impressive version and the correct
version look nothing alike.

**The impressive version is speech-to-speech**: audio goes to a model, audio comes back, and the
model calls your retrieval as a tool when it decides it needs to. It is genuinely the better product
for some applications and it is wrong for this one, for three reasons that stack:

1. **The grounding stops being yours.** The whole system is a numbered context block, a prompt that
   forbids outside knowledge, `temperature: 0`, and a fixed refusal string. Hand the conversation to
   a model that calls retrieval as a tool and none of those four are what produces the answer any
   more. The thing being demonstrated is gone.
2. **The cost unit changes and no existing control covers it.** One realtime session is a *single*
   request billed per minute for as long as a tab stays open. Every rate limit in this codebase
   counts requests.
3. **Citations do not survive audio.** The `[n]` markers are the product. Spoken, they are either
   noise or nothing.

**The correct version treats speech as I/O around a pipeline that never learns it happened.**

```
mic → transcript → [the composer, editable] → the same POST a keyboard would send
                                                          ↓
                    speech ← spoken projection ← the same streamed answer
```

Two ideas in that diagram are worth taking away.

**Transcription is upstream of retrieval, which makes a mishearing invisible.** This is the same
shape as §2.7's pronoun problem, arriving from a different direction. "What does it say about
parental *leaf*" is a perfectly well-formed question. It embeds fine. It retrieves the nearest
passages to a question nobody asked, the grounded prompt correctly refuses, and the user watches a
working system deny something their document plainly says — with no error anywhere, because nothing
failed. The fix is not better transcription. It is putting the text where a human can see it before
it is sent, which converts a silent retrieval failure into an obvious typo.

The general lesson, and it is the same one §2.7 ends on: **when a component sits upstream of
retrieval, its failures are reported by retrieval.** Rewriting and transcription are both in that
position. Neither can be debugged by looking at the thing that complained.

**Speech is a different projection of the answer than display.** The answer on screen carries `[2]`
markers and markdown; read aloud those become "bracket two" and stray punctuation. So the same
string is derived twice, exactly as conversation history is derived twice in §2.7 — a transcript
shows an unanswered question, a *prompt* drops it, and neither is more true than the other.

The harder half is that the answer arrives as a token stream, and this is the second instance of the
bug in §1.13: **a token respects sentence boundaries no more than a network chunk respects line
boundaries.** So sentences get buffered and the trailing one is always held back, because a buffer
ending "…released in v1." looks like a finished sentence right up until the next token turns it into
"v1.5". Hold the tail, flush on completion — the same fix, one layer up.

Two smaller things that only appear once you try it:

- **Splitting sentences on `/[.!?]\s/` is wrong on this corpus specifically.** The documents are
  technical prose, so answers are full of `lib/answer.ts`, `0.33` and `e.g.` — `Intl.Segmenter`
  handles the first two correctly because no whitespace follows the dot, and gets the third wrong
  because a space and a capital letter is exactly what a sentence boundary looks like.
- **Silence is not free.** Transcription models in this family hallucinate fluent text on an empty
  clip — "Thank you.", subtitle credits — which then flows into retrieval as if it had been asked. A
  byte floor catches the *empty* case; only decoded samples distinguish a quiet room from speech,
  which is why the loudness check lives in the browser and not on the server.

**The asymmetry worth defending.** Input uses a paid transcription model; output uses the browser's
own `speechSynthesis`, which is free. That looks inconsistent and is not: a wrong transcript changes
*which passages get retrieved*, so input quality changes what the system does, while a robotic voice
reading a correct answer is still a correct answer. Money goes where an error changes the result.

📁 [`api/src/lib/audio.ts`](../api/src/lib/audio.ts) ·
[`api/src/lib/transcribe.ts`](../api/src/lib/transcribe.ts) ·
[`web/src/lib/speech.ts`](../web/src/lib/speech.ts) ·
[`web/src/lib/use-recorder.ts`](../web/src/lib/use-recorder.ts)

---

## Quick reference — every number in the system

| Thing | Value | Where |
|---|---|---|
| Embedding model | `text-embedding-3-small`, **hardcoded** | [`embed.ts`](../api/src/lib/embed.ts) |
| Embedding dimensions | 1536 | must match `vector(1536)` |
| Embedding batch size | 100 | [`embed.ts`](../api/src/lib/embed.ts) |
| Chat model | `gpt-4o-mini`, **env-configurable** | [`env.ts`](../api/src/lib/env.ts) |
| Temperature | 0 | [`answer.ts`](../api/src/lib/answer.ts) |
| Chunk size / overlap | 1000 / 200 chars | [`chunk.ts`](../api/src/lib/chunk.ts) |
| Retrieval `k` | default 5, capped 1–10 | [`query.schema.ts`](../api/src/modules/queries/query.schema.ts), [`conversation.schema.ts`](../api/src/modules/conversations/conversation.schema.ts) |
| Conversation history window | 6 messages (3 exchanges) | [`condense.ts`](../api/src/lib/condense.ts) |
| Assistant turn in history | truncated to 500 chars | [`condense.ts`](../api/src/lib/condense.ts) |
| Rewrite budget | 100 tokens generated, 400 chars accepted | [`condense.ts`](../api/src/lib/condense.ts) |
| Conversation title max | 80 chars, derived from the first question | [`conversation.schema.ts`](../api/src/modules/conversations/conversation.schema.ts) |
| HNSW build | `m=16`, `ef_construction=64` | [migration](../api/prisma/migrations/20260725120000_chunk_embedding_hnsw/migration.sql) |
| HNSW query | `ef_search=100`, `iterative_scan=strict_order` | [`retrieve.ts`](../api/src/lib/retrieve.ts) |
| JWT | HS256, 1 hour expiry | [`jwt.ts`](../api/src/lib/jwt.ts) |
| Password hash | argon2id (library defaults) | [`password.ts`](../api/src/modules/auth/password.ts) |
| Title / content / question max | 200 / 200,000 / 1,000 chars | `*.schema.ts` |
| JSON body limit | 1 mb — **does not apply to uploads** | [`app.ts`](../api/src/app.ts) |
| Upload file limit | 4 mb, 1 file (the only bound on a multipart body; sized under Vercel's hard 4.5 MB request cap) | [`upload.ts`](../api/src/lib/upload.ts) |
| Uploaded PDF page limit | 200 pages | [`pdf.ts`](../api/src/lib/pdf.ts) |
| Transcription model | `gpt-4o-mini-transcribe`, **hardcoded** | [`transcribe.ts`](../api/src/lib/transcribe.ts) |
| Speech synthesis | the browser's own; no server, no cost | [`use-speech.ts`](../web/src/lib/use-speech.ts) |
| Audio upload limits | 1 mb ceiling, 2 kb floor (a proxy for duration — the codec decides how many seconds fit) | [`audio.ts`](../api/src/lib/audio.ts) |
| Recording caps | 60s max, peak amplitude ≥ 0.02 — both enforced in the browser | [`use-recorder.ts`](../web/src/lib/use-recorder.ts) |
| Rate limits | signup 15/hr·IP · login 10/15min·IP (failures only) · ingest 10/hr·user · queries 10/min + 50/day·user · 2000/day global · audio 10/min + 100/day·user · 1500/day global | [`rate-limit.ts`](../api/src/middleware/rate-limit.ts) |
| Rate-limit store | Redis (`rl:<name>:` per limiter); memory only when `REDIS_URL` is unset, which production forbids | [`redis.ts`](../api/src/lib/redis.ts) |
| Concurrent streams | 2 per user, **one counter shared** across `/queries` and `/conversations` | [`concurrency.ts`](../api/src/middleware/concurrency.ts) |
| Ingest transaction timeout | 30s (`maxWait` 5s) | [`document.service.ts`](../api/src/modules/documents/document.service.ts#L179) |

---

**Next:** [`flows.md`](flows.md) — every request traced end to end through the code.
