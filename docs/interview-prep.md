# Interview prep — defending this project

**Read [`concepts.md`](concepts.md) and [`flows.md`](flows.md) first.** This doc turns that knowledge
into answers.

**The one rule that governs everything below:** *claim only what exists.* This project's genuine
strength is that almost every decision has a reason and every gap is known. That reads as senior. A
padded claim that collapses under one follow-up question does more damage than the gap ever would.

---

## 1. The pitch

### 30 seconds

> It's a document Q&A app. You paste text or upload a PDF, ask questions in natural language, and
> get an answer that's generated **only** from your documents — streamed token by token, with inline
> citations you can click to see the exact passage it came from, down to the page. If your documents
> don't contain the answer, it refuses rather than guessing. And it's conversational: you can ask a
> follow-up like "how long is it?" and it works out what you meant before it searches.
>
> The interesting part isn't the AI call, it's everything around it: chunking and embedding on the
> write path, vector search with tenant isolation on the read path, and a streaming endpoint that
> still returns real HTTP status codes when things fail.

### 90 seconds — add the architecture

> Two apps in one repo. A Next.js frontend, and a **standalone Express + TypeScript API** — not
> Next.js API routes, deliberately, because I wanted to build a real backend rather than hide it
> behind a framework.
>
> Postgres with the **pgvector** extension is the only datastore. No separate vector database,
> because every retrieval joins chunks to documents anyway — both to get the citation title and to
> enforce that you only ever search your own documents. A separate vector DB would mean that join
> becomes a network hop plus a second consistency problem, for no gain at this scale.
>
> There are two paths and they're slow in different ways. **Ingestion** is slow because of N
> embedding round-trips, and nobody is waiting — so the right treatment is a queue. **Querying** is
> slow because one model is generating tokens, and a human *is* waiting — so the right treatment is
> to stream. Getting that asymmetry right is most of the architecture.

### If they ask "why did you build it?"

Be straightforward. *"I'm a frontend engineer with seven years of experience moving into full-stack
and AI work. I picked this project because it forces the parts I hadn't done — schema design, auth,
transactions, streaming, cost control — instead of just wiring an API key to a chat box."*

That's a strength, not a confession. It also explains why the docs and the code comments are so
thorough, which is itself a good signal.

---

## 2. The whiteboard version

If they hand you a marker, draw this and talk through it.

```
                 WRITE PATH (nobody is waiting → should be queued)
  paste text ─┐
  upload PDF ─┴→ validate → sha256 dedupe → chunk (1000/200, per page for PDFs)
             → embed (batches of 100)
             → ONE transaction: insert chunks, set vectors, mark READY

                 READ PATH (a human IS waiting → stream it)
  question → embed (SAME model) → vector search, scoped to userId, HNSW top-k
           → format numbered sources → LLM @ temperature 0 → stream NDJSON
           → tokens + citations render live

                 CONVERSATION (the read path, plus one step in front)
  follow-up ─→ rewrite against history ─┬→ "standalone query" → the read path above
                                        └→ NO_SEARCH → skip retrieval,
                                                       re-use last turn's sources
```

Then say the three sentences that carry the design:

1. **"The embedding model is hardcoded; the chat model is an env var."** Changing the chat model is a
   deploy decision. Changing the embedding model invalidates every vector in the database, so it must
   never be a flag anyone can flip.
2. **"`userId` only ever comes from a verified token, never a request body."** Both zod schemas omit
   the field entirely.
3. **"A response has one status code, committed on the first byte."** Everything about the streaming
   endpoint's error handling follows from that.
4. **"A follow-up is not a search query."** "How long is it?" embeds to nothing useful, so it gets
   rewritten into a standalone question *before* retrieval — and instructions like "make that
   shorter" skip retrieval entirely rather than searching for words that mean nothing to an
   embedder.

---

## 3. Question bank

### 3.1 RAG and AI

<details open>
<summary><b>What is RAG and why not just fine-tune?</b></summary>

Retrieval-Augmented Generation: retrieve the relevant passages from your own data first, then ask the
model to answer using only those.

Fine-tuning retrains weights. It's expensive, has to be redone for every new document, teaches
*style* far better than *facts*, and — decisively for this app — gives you **no citations**. There's
no way to point at where an answer came from.

The third option is long context: paste everything into every prompt. That costs corpus-size × every
query, hits the context window, and accuracy actually degrades as context grows.

RAG bounds cost per query, makes new documents live the instant they're ingested, and every claim is
traceable.
</details>

<details>
<summary><b>What is an embedding?</b></summary>

A list of numbers representing the meaning of text — 1,536 of them here. The model was trained so
text with similar meaning lands in nearby positions in that space. Retrieval is then just "which
stored points are closest to the question's point."

The practical consequence: it matches on meaning, not characters. "I forgot my login credentials"
retrieves a passage about resetting a password despite sharing zero words.

I'd volunteer the counterpoint too: embeddings are *worse* than keyword search for exact identifiers
— error codes, SKUs, proper nouns. Production systems often run both and merge, called hybrid
search. That's a known gap here.
</details>

<details>
<summary><b>Why chunk documents? Why 1000 characters with 200 overlap?</b></summary>

One vector for a whole document is the *average* of everything in it, so a document covering ten
topics is close to nothing in particular. Chunking keeps each vector about one thing — and it's what
makes citations meaningful, since you can point at the paragraph rather than the file.

Overlap means a sentence straddling a boundary is fully present in at least one chunk. Without it,
the passage that answers the question can be split across two chunks and complete in neither.

**Be honest about the numbers:** 1000/200 were chosen by judgement, not measurement. Smaller chunks
give precise matches but fragmentary context; larger give richer context but diluted vectors and a
more expensive prompt. Settling it empirically is exactly what the eval harness is for.

*Saying that is stronger than inventing a justification.* Interviewers can tell.
</details>

<details>
<summary><b>How does the vector search actually work?</b></summary>

pgvector's `<=>` operator returns cosine distance — the angle between two vectors, ignoring
magnitude, so a longer passage doesn't score differently just for being longer. 0 is identical, 1 is
unrelated. **Lower is better**, which is why the field is named `distance` and `similarity = 1 -
distance` is computed exactly once.

Comparing against every chunk is O(n). An **HNSW** index — a navigable graph where each node links to
near neighbours plus a few long-range highways — makes it roughly logarithmic.

It's approximate: it can miss a true nearest neighbour. That's the trade, and `hnsw.ef_search` is the
recall/latency dial. pgvector's default is 40; I set 100 because at this corpus size the extra work
is unmeasurable and it buys better recall on filtered searches.
</details>

<details>
<summary><b>Why HNSW and not IVFFlat?</b></summary>

IVFFlat must be built on data that already exists, to learn its cluster centroids. Build it on an
empty or tiny table and you get a permanently bad index. HNSW builds incrementally and stays correct
as rows arrive — the only sane option for a table that grows one upload at a time.
</details>

<details>
<summary><b>⭐ How do you stop one user retrieving another user's documents?</b></summary>

*This is the best question you can get. Have the long answer ready.*

The SQL has `WHERE d."userId" = $1`, joined through Document. But the real answer is **why that line
is dangerous**:

Everywhere else, tenant isolation goes through Prisma's query builder, where `where: { userId }` is
type-checked and the API shape makes the rule hard to forget. Retrieval can't — Prisma has no model
of pgvector's operators, so it drops to raw SQL. The moment you write SQL by hand, the compiler stops
helping. **Deleting that line breaks no test, produces no type error, and turns the endpoint into a
full-corpus search across every user.**

So the file opens with a comment block saying exactly that. **And be straight about the follow-up:**
there is a test suite now, and it does *not* cover this line — proving tenant isolation needs two
real users with real rows, so it belongs in the integration tier, which isn't written. Naming that
is better than hoping they don't ask, because "deleting it breaks no test" is currently still
literally true.

Then, if they're still with you, the second-order problem: **the HNSW index knows nothing about
users.** Postgres walks it in distance order and *then* discards rows failing the filter —
post-filtering. Ask for the top 5 and the scan may surface 40 candidates all belonging to other
users, leaving you with two results or none. Still correct, but it silently under-returns, and it
gets worse as more users join — the emptiest results land on the newest customers. pgvector 0.8's
iterative scan (`strict_order`) fixes it by scanning deeper when the filter eats the candidate set.
</details>

<details>
<summary><b>How do you prevent hallucination?</b></summary>

Four layers, and I'd be clear that they *reduce* it rather than eliminate it:

1. **The system prompt** — six numbered rules, each defending a specific failure. Answer only from
   sources; never use training data; cite every claim; emit a fixed refusal string when the sources
   are insufficient; don't speculate; be concise.
2. **`temperature: 0`** — every degree of creativity is a degree of freedom to invent something the
   sources don't say.
3. **A fixed `REFUSAL` constant**, not "say you don't know." A verbatim string is UI-detectable and
   eval-assertable; a model left to its judgement writes a different apology every time, and a waffle
   is indistinguishable from a weak answer.
4. **Citations rendered and validated.** The UI checks each `[n]` against the real source list, so a
   hallucinated `[7]` renders as inert grey text, not a button. And the retrieved chunk text is shown
   on screen — grounding is only a real claim if the user can check it.

The layer that still isn't built is measurement. Groundedness scoring is part of the eval harness,
which is in progress — the runner and the corpus exist, the metrics don't. So: the *mechanisms* for
grounding are built and verifiable; the *evidence* that they work at a given rate is not.
</details>

<details>
<summary><b>What happens if retrieval returns nothing?</b></summary>

Short-circuit: yield the refusal constant with **no model call at all**. The model can't answer from
empty context, so asking is a guaranteed refusal that costs a round-trip and real money. Both paths
emit the identical string, so they're indistinguishable to the client.
</details>

<details>
<summary><b>How would you know if the system is any good?</b></summary>

*Don't bluff here — the honest answer is the strong one.*

Right now I can't measure quality, and several numbers — `k=5`, chunk size 1000, overlap 200,
`ef_search` 100 — are judgement calls. The eval harness is the milestone in progress:

- **A golden set** — questions with known answers over a fixed corpus.
- **Retrieval hit-rate@k** — does the chunk containing the answer appear in the top k? This measures
  the *retriever alone*, isolated from the model, which matters because most RAG failures are
  retrieval failures.
- **Groundedness** — is every claim supported by a cited chunk?
- **Refusal accuracy** — does it refuse when it should and *only* then? Refusing an answerable
  question is as broken as inventing an answer.

**Three design points worth raising unprompted here** — they're where the thinking shows:

1. **Ground truth can't be "the answer is in chunk 7."** The whole point is to vary `chunkSize`, and
   re-ingesting recreates every chunk with different boundaries — so chunk-ID ground truth is
   invalidated by the experiment it exists to score. Anchor on distinctive **substrings** instead:
   a chunk is a hit if it contains one. Chunking-invariant.
2. **The corpus is my own writing, because contamination is what silently invalidates a RAG eval.**
   If the model already knows the answer, hit-rate can be zero and the answer still looks correct —
   the most misleading result the harness could produce.
3. **hit-rate@k can't choose `k` by itself** — it's monotonically non-decreasing in `k`, so `k=10`
   always wins. A metric that can only recommend the maximum isn't deciding anything. `k` needs
   hit-rate *plus* answer quality *plus* tokens per answer.

What exists today: the test runner and a corpus builder that renders sources at two page densities.
What doesn't: the golden set and every metric above. So the honest answer stays "I can't measure
quality yet" — with the difference that the machinery to do it is half-built rather than sketched.

`temperature: 0` was chosen partly to make this possible — under a non-deterministic model you can't
tell a regression from noise.
</details>

<details>
<summary><b>"How do follow-up questions work? Doesn't retrieval break in a conversation?"</b></summary>

**It does break, and the way it breaks is the interesting part** — because the symptom points at the
wrong component.

Retrieval embeds the question and finds the nearest chunks. That works only if the question carries
its own meaning. Turn 2 of a real conversation usually doesn't:

> Q1 "What does the handbook say about parental leave?" → retrieves the right passage.
> Q2 "How long is it?" → embeds to a vector about pronouns and duration. Matches nothing.

Retrieval returns noise, the grounded prompt correctly refuses, and the user is told their documents
don't cover a question they can see was just answered. **Every component behaved exactly as
designed.** That's the lesson: in RAG the visible failure is almost never where the bug is — a
confident wrong answer and an unnecessary refusal usually both mean retrieval got handed the wrong
query.

So there's a **condense step** before retrieval: give a model the recent history plus the follow-up,
get back a standalone question, embed *that*. `"How long is it?"` becomes `"What is the duration of
parental leave?"`. Skipped entirely on turn 1 — a first question is standalone by definition, and
that's the most common request the app serves.

**The second problem is subtler.** Some follow-ups aren't questions:

> "Make that shorter." · "Put it in bullets."

There's no standalone question in those. Rewriting produces nonsense; searching returns the corpus's
*least* relevant chunks — semantic search always returns something — and the prompt refuses. So the
rewriter can emit a `NO_SEARCH` sentinel, and those turns skip retrieval entirely and re-ground on
the previous turn's stored sources. No embedding call, no SQL: it's the fastest path in the app.

**The split I'd put on the whiteboard:** the rewritten query drives *what we look up*; the original
question drives *what we say*. Send the rewrite to the generator and "make that shorter" becomes a
re-answer of a question nobody asked.

**What it costs**, because they'll ask: one extra model call on the critical path, and a new failure
mode where a rewrite that drops the user's intent produces confident retrieval of the *wrong*
passage — which looks exactly like a retrieval regression and isn't one. That's why the rewritten
query is shown in the UI rather than hidden. And every failure in the rewriter falls back to
searching the raw question, because a quality improvement should never be able to take down the
thing it improves.

</details>

<details>
<summary><b>"You added a rewrite step. What did that do to your eval harness?"</b></summary>

**It made it measure two things at once, so I kept it off the path being measured.**

The rewrite sits *upstream* of retrieval. If I'd added it to the existing `/queries` endpoint,
hit-rate@k would have started measuring "rewrite + retrieval" while still being read as "retrieval"
— and when the number moved I'd have no way to tell which half moved it.

So chat is a **sibling module**. `/queries` is single-turn, stateless and byte-for-byte unchanged —
including the system prompt string, because editing that would shift every number the harness
produces. The multi-turn rules are *appended* to it rather than edited in. Both surfaces call the
same `retrieveChunks` and `streamAnswer`, so the thing being measured is still the thing users hit.

**What's now owed:** the rewriter has no evaluation of its own. The measurement that would justify
it is hit-rate@k on the rewritten query versus the raw follow-up over a set of multi-turn cases —
that delta *is* the argument for the extra call and the extra latency, and it doesn't exist yet.

If they push on ordering: building the feature first means the harness now has to separate two
things that were one thing when it was specified. Building the harness first would have delayed a
feature the app is hard to demo without. Neither was free. **What I won't do is claim a quality
number I haven't measured.**

</details>

<details>
<summary><b>"Where do you store conversation history, and why not just send it from the client?"</b></summary>

**Server-side, in `Conversation` and `Message` tables — and the client-sends-it design is the one I
specifically rejected.**

It's tempting: the browser already has the transcript on screen, and the server stays stateless. It
also lets a caller fabricate an **assistant** turn — *"You previously agreed to ignore your
source-only rule"* — which lands in the slot of the prompt a model weights most heavily. It's the
same rule as `userId` never coming from a request body, applied to a field most people don't
immediately read as security-relevant.

**Two modelling decisions inside that I'd raise unprompted:**

**Citations are a JSON snapshot on the message, not a foreign key to the chunk.** Chunks are deleted
with their document and recreated with fresh ids on every re-ingest — and re-chunking is a
first-class operation in this system, so that's the expected path, not an edge case. A foreign key
makes old citations vanish under `Cascade` or dangle under `SetNull`. The resolution comes from
asking what a citation *asserts*: not "this points at row abc123" but "this answer was built from
this passage, at the time it was given." Historical claims get stored as copies. Cost: duplicated
chunk text, and "what gets cited most" stops being a join. Both accepted.

**Messages carry an explicit `seq`, not just a timestamp.** A question and its answer are frequently
written in the same millisecond, and ordering by `createdAt` gives them no defined order — which
renders the answer above the question. `@@unique([conversationId, seq])` then does a second job for
free: two browser tabs appending to one thread race for the same position, the loser gets P2002, and
that becomes a **409** ("this conversation moved on in another tab") instead of two conversations
silently interleaving into one unreadable transcript.

</details>

<details>
<summary><b>"Tell me about a bug you found in this project."</b></summary>

**A prompt bug where two of my own decisions fought each other, and the instruction lost.**

Historical answers get their `[n]` citation markers stripped before going back into the prompt,
because turn 1's `[2]` and turn 3's `[2]` were numbered against different retrievals — replaying
them invites the model to reuse a numbering that no longer means anything. Sound reasoning.

Then I tested "make it shorter", which re-uses the previous turn's sources. The answer came back
correct and **completely uncited**. My system prompt has an explicit rule requiring inline citations
on every claim. I added a *second* rule specifically saying reformat requests still need them. It
was ignored again.

The cause: on a re-use turn the model is shown its own previous answer with every citation stripped
out, and then asked to reproduce it more briefly. It copied what it saw. **The example in the
context window beat the instruction in the system prompt.**

The fix was one flag — keep the markers on the final assistant message, but only on a re-use turn,
where the sources genuinely are the same ones. Verified: the citation now survives.

The transferable lesson is the one I'd actually lead with: **when a model ignores a rule, look at
what the prompt is *showing* it before you write another rule.** Prompt engineering failures are
frequently demonstration failures, not instruction failures.

</details>

### 3.2 Backend and API design

<details>
<summary><b>⭐ You added PDF upload. Why is that more than "accept a file"?</b></summary>

Because the file format was never the point — the **page structure** was.

`Chunk.page` had been in the schema since the first migration and sat `NULL` for as long as pasted
text was the only input, because a string has no pages. A PDF is the only source that can fill it.
So the feature is *page-aware chunking*: each page is split independently and every chunk carries
its page number, which moves a citation from "chunk 12" — an internal ordinal the reader cannot look
up — to "page 7", which they can open the file and check.

That distinction matters for the product's core claim. The whole system is built on the idea that a
grounded answer beats a confident one, and grounding is only worth anything if the user can *verify*
it. A citation nobody can check is a claim with a number next to it.

And I can state the cost, which is the part that makes it a real decision rather than a feature:
chunking per page makes the page a **hard** chunk boundary. Overlap can't bridge a paragraph that
spans a page break, and `chunkSize` picks up a second maximum that isn't in any config — the length
of a page. A 300-page PDF of short pages gives ~300 tiny chunks instead of ~45 good ones, and small
chunks embed into vague vectors. I shipped it anyway and wrote the limitation into the code, because
whether it bites depends entirely on the corpus, and the eval harness can answer that where I'd only
be guessing.

**And I've now reproduced it deliberately.** The eval corpus renders each source at two page
densities — same text, different amount per page. Dense: 19 pages, 56 chunks, median 956 characters.
Sparse: 122 pages, **122 chunks**, median 336. The proof isn't the chunk count, it's that in the
sparse case the chars-per-page and chars-per-chunk distributions come out *identical* — same
minimum, median, p90 and maximum. That can only happen if every page yielded exactly one chunk,
i.e. the page boundary decided every split before `chunkSize` was ever consulted.

If they push, know where that stops: it demonstrates the **mechanism**, not the **cost**. "Vague
vectors retrieve worse" is still a story, not a measurement. Running the same golden set against
both renderings makes page density the only variable, and *that* delta is what justifies a schema
change. Being able to draw that line is the actual answer to this question.
</details>

<details>
<summary><b>⭐ Why a separate `/documents/upload` route rather than one route handling both?</b></summary>

Two body parsers, two validation schemas, two error taxonomies. Branching on `Content-Type` inside
one handler couples three sets of failure modes that have nothing to do with each other, and the
JSON route — which was working — would have had to be reopened to add it.

They converge one line later: the upload route parses the PDF, then calls **the same
`ingestDocument`** with one extra argument. Both answer the identical `{ document, deduped }` body,
so the client keeps one type, one renderer and one polling loop.

The general principle: **share the domain logic, not the transport handler.** The pipeline never
learns that PDFs exist, so the next format is a new parser rather than a new branch through
chunking, embedding and persistence.
</details>

<details>
<summary><b>⭐ How do you validate that an uploaded file is actually a PDF?</b></summary>

Magic bytes — the actual leading bytes of the content. A PDF starts with `%PDF-`.

Specifically **not** `file.mimetype`, which is what most people reach for. That value isn't an
inspection of anything: multer copies it from the `Content-Type` header the *client* wrote into that
part of the multipart body. `curl -F "file=@evil.html;type=application/pdf"` claims whatever it
likes and multer reports it with complete confidence. The filename is client-controlled too — it can
legally contain `../` and NUL bytes, so I sanitise it before it becomes a document title.

Then the honest limit, because this is where people overclaim: magic bytes are **necessary, not
sufficient**. They prove the file *starts* like a PDF, not that it's valid or benign. The real
guarantee is that pdf.js either parses it or throws — plus the fact that I never store the bytes and
never serve them back, which is what forecloses the classic upload-HTML → served-back →
browser-sniffs-it → stored-XSS chain. In this app the byte check is defence-in-depth and a much
better error message. It isn't stopping a live exploit, and I wouldn't claim it is.
</details>

<details>
<summary><b>⭐ Your JSON body limit is 1 MB. How does a 4 MB upload get through?</b></summary>

It never touches that limit. **Body parsers are content-type-gated.** `express.json()` checks
`Content-Type` first, sees `multipart/form-data`, and calls `next()` having read zero bytes — its
limit is never consulted. Multer's `limits.fileSize` is the *only* bound on an upload.

That's worth knowing precisely because getting it wrong is silent: you'd have configured a limit,
believed uploads were capped, and shipped an unbounded one.

It also caused a real bug I had to fix. Multer rejects an oversized file by throwing a
`MulterError`, which carries a `code` but not the `type`/`status` pair my error middleware's
body-parser branch checks for. So it matched nothing and fell through to the generic 500 — a 12 MB
upload returned "Internal Server Error" for something entirely the client's side and entirely
fixable. It needed its own branch mapping `LIMIT_FILE_SIZE` to 413. The generalisable lesson: any
middleware that can reject a request before your route runs will have its own error type, and a
catch-all that only knows your errors will mislabel every one of them as a server fault.
</details>

<details>
<summary><b>⭐ Two different PDF files produce the same dedupe hash. Bug?</b></summary>

No — that's the design working, and the reasoning is the interesting part.

I hash the **extracted text**, not the file bytes. Two PDFs whose text is identical produce identical
chunks and identical embeddings; storing both means the retriever holds two copies of everything and
`k=5` fills with duplicates, crowding out other documents. So the dedupe isn't only saving money,
it's protecting retrieval quality.

Hashing the bytes instead would be *worse*, which is the non-obvious bit. Re-export the same document
tomorrow and the bytes differ — embedded timestamps, a different producer string, different
compression — so a user re-uploading what is plainly the same document pays the full embedding cost
again. Byte-hashing dedupes *less* than you want, precisely because PDFs are full of non-semantic
noise.

The wrinkle I did have to handle is UX. Upload `handbook-v2.pdf` where only the diagrams changed and
it dedupes against v1 — so a bare "already ingested" leaves the user staring at a list that doesn't
contain the filename they just picked. The message names the existing document instead.
</details>

<details>
<summary><b>Why a separate Express API instead of Next.js API routes?</b></summary>

Partly deliberate learning — I wanted to build a real backend, not one hidden behind a framework.

But there's a technical case too: the API and the frontend have completely different scaling and
deployment profiles. The API needs a real middleware stack — auth, rate limiting, concurrency
control, one error boundary — and will need a background worker for ingestion. Split, each deploys
and scales on its own terms.

The cost is CORS configuration and two deployments. Worth it.

**Volunteer the tension before they find it.** The API *is* deployed to Vercel Functions today, so
"not serverless" isn't the distinction — it's a separate service, separate domain, separate deploy,
with middleware that runs in a defined order, which Next.js route handlers don't give you. And the
deployment model made the design *harder* in an instructive way: single-instance assumptions stopped
holding, which is what pushed the rate limiters onto Redis. "I moved to Redis because the deployment
model made in-memory limits dishonest" is a better story than "my limits work because I pinned
max-instances to 1."
</details>

<details>
<summary><b>Explain your layering.</b></summary>

Routes → services → lib.

- **Routes** know HTTP: `req`, `res`, status codes, validation. No business logic.
- **Services** know business rules and the database. **They never import Express.**
- **Lib** modules each do one technical thing: chunk, embed, retrieve, answer.

The frontend analogy is keeping logic out of components — a route is the component, a service is the
hook or store.

And it's not decorative. Three things it actually buys: `answerQuestion()` can be called from a test
or a CLI with no server; the transport can change from NDJSON to WebSocket without touching answer
logic; and `ingestDocument()` will become a queue worker's handler **with its exact current
signature.**
</details>

<details>
<summary><b>Why is the app built in a `createApp()` function?</b></summary>

So wiring is separate from "start listening." Only `index.ts` calls `.listen()`. A test can import
`createApp` and hit routes in memory with supertest — no port, no teardown, no flakiness. It costs
one function and it's the difference between testable and not.
</details>

<details>
<summary><b>⭐ Walk me through your streaming endpoint.</b></summary>

*The centrepiece. Structure it in three beats.*

**The constraint:** a response has exactly one status code, committed the instant the first byte
leaves. Before that an error can be a clean 500 or 429. After it, the client has been told `200 OK`
and is parsing a body — a thrown error just truncates the stream, which looks identical to a network
drop.

**The design:** headers are deferred until the first event actually arrives. Then the error path
forks on one question — have headers been sent? Not yet, rethrow and let the normal error middleware
produce a real status. Already sent, and the failure has to travel in-band as an `{type:"error"}`
event.

**What makes it work:** the service is an **async generator**, and generator bodies are lazy. Calling
`answerQuestion(...)` executes not one line. Retrieval only runs when the route pulls the first value
— inside the try block, before headers. So a DB outage or an OpenAI 429 while embedding the question
still throws while a real status code is available. If the service fetched eagerly, *every* failure
would be a truncated 200.
</details>

<details>
<summary><b>Why NDJSON instead of Server-Sent Events?</b></summary>

*A constraint, not a preference — say so.*

SSE's browser client is `EventSource`, and `EventSource` **cannot set request headers**. Auth here is
a Bearer token in an `Authorization` header. SSE would force the token into a query string — where it
lands in server access logs, browser history, and `Referer` headers — or force an immediate move to
cookies. `fetch` + `ReadableStream` reads a stream just as well and sends headers normally.

NDJSON rather than raw text because every event needs structure — sources, tokens and errors are
different shapes — and `JSON.parse` per line is the entire client parser. The one rule it imposes, no
literal newline inside an event, is already guaranteed by `JSON.stringify`.

*If they push on WebSockets:* full duplex for a one-way stream, plus connection state and a separate
auth handshake. More machinery for no benefit here.
</details>

<details>
<summary><b>What happens if the user closes the tab mid-answer?</b></summary>

`res.on("close")` fires, which aborts an `AbortController` whose signal was passed into the OpenAI
SDK call. Generation stops.

Without it you pay, in full, for tokens streaming into a socket nobody is reading, and the request
occupies a connection until the model finishes talking to itself.

The chain is worth tracing: browser `AbortController` → fetch aborted → socket closes → server's
`res` `close` event → server `AbortController` → OpenAI request cancelled. The client side has the
mirror image — abort on unmount, and abort is caught and *ignored* rather than shown as an error,
because a user clicking Stop isn't a failure.
</details>

<details>
<summary><b>Why validate with zod when you already have TypeScript?</b></summary>

TypeScript is erased at compile time. It describes what you *hope* arrives; it checks nothing at
runtime. A request body is `any` in practice.

zod validates at runtime **and** produces the type via `z.infer`, so there's one source of truth.

The detail I'd add: `.trim()` must come before `.min(1)`. Refinements run left to right, so
`.min(1).trim()` measures `"   "` as three characters, passes, then trims to empty — you store a
blank title with no error.
</details>

### 3.3 Database

<details>
<summary><b>Walk me through your schema.</b></summary>

Three tables. `User` — id, email, argon2 hash. `Document` — owner, title, **the raw text**, a content
hash, a status enum, and a denormalised chunk count. `Chunk` — the text, an ordinal index, and a
`vector(1536)`.

Two decisions worth calling out:

**Why keep the raw text** when only chunks are ever queried: re-chunking is a first-class operation.
Settling chunk size empirically means re-processing the whole corpus repeatedly, and that must not
require the user to re-upload anything.

**Why `chunkCount` is denormalised:** listing documents shouldn't need a `COUNT(*)` join. It's
written inside the same transaction as the rows it counts, so it can't drift.
</details>

<details>
<summary><b>What indexes do you have and why?</b></summary>

Three, each serving a specific query:

- `@@unique([userId, contentHash])` — enforces dedupe **in the database**, which is the only place it
  can be enforced under concurrency.
- `@@index([userId, createdAt(sort: Desc)])` — a composite matching `listDocuments` exactly: Postgres
  seeks to the user's slice and walks it **already ordered**, with no sort step.
- The **HNSW** index on `embedding` — vector similarity.

The HNSW one has a footgun worth mentioning: the operator class `vector_cosine_ops` pairs with `<=>`.
Query with `<->` instead and Postgres doesn't error — it **silently** ignores the index and
sequential-scans. A slow correct answer, which is the failure mode that survives to production.
</details>

<details>
<summary><b>⭐ Two users upload the same document simultaneously. What happens?</b></summary>

Both pass the `findByHash` check — it's a **check, not a guarantee**. Both attempt the insert. One
wins; the other gets Prisma error P2002 from the unique constraint, catches it, re-reads the winner's
row, and returns it with `deduped: true`. Both callers get a correct answer, one document exists.

The generalisable point: **application-level checks cannot enforce uniqueness under concurrency —
only the database can.** Check first for the common path, catch the constraint for correctness.
</details>

<details>
<summary><b>Where do you use transactions, and why?</b></summary>

*Two places, for completely different reasons — this is a good differentiator.*

**Ingestion — the classic reason, atomicity.** Insert chunks, set vectors, mark `READY`, all or
nothing. Without it, a crash mid-write leaves half the chunks saved and the document marked ready — a
document that looks searchable and silently isn't.

Note what's deliberately *outside* it: chunking and embedding. Holding a transaction open across a
multi-second call to OpenAI pins a connection from a small pool for the whole round-trip. That's how
a slow dependency becomes a database outage.

**Retrieval — an unusual reason.** There's nothing to make atomic; it's a read. The transaction exists
purely to scope `SET LOCAL`, which reverts on commit. Plain `SET` would mutate the *pooled
connection's session*, and that connection goes to the next request — one query's tuning silently
becomes global config for whoever gets it next. Non-deterministic, load-dependent, invisible in dev.
</details>

<details>
<summary><b>Why not a dedicated vector database?</b></summary>

Every retrieval joins Chunk to Document — both to get the citation title and to enforce the tenant
scope. With a separate vector store that join becomes a network hop plus a second consistency problem
(two systems that can disagree about what exists).

pgvector is one datastore, one connection string, one transaction boundary, one backup. At the corpus
sizes this system is designed for, the performance argument for a dedicated store doesn't outweigh
that. I'd revisit it in the tens of millions of chunks — and I'd expect the first move before that to
be per-tenant partial indexes, not a new database.
</details>

<details>
<summary><b>Why is `prisma migrate dev` unsafe here?</b></summary>

*A great question to be asked, because the answer shows you understand the tooling's limits.*

Prisma models the vector column as `Unsupported("vector(1536)")` — it knows the column exists and
understands nothing about it, so it can't represent the HNSW index in the schema file. `migrate dev`
diffs the database against the schema, sees an index it can't account for, calls it drift, and
generates a `DROP INDEX` to "fix" it.

Vector search then silently falls back to a sequential scan. Still correct, quietly slow, no error.
`migrate deploy` does no drift detection — it only applies pending migrations — so that's the correct
command, and the index migration is hand-written SQL.
</details>

### 3.4 Security

<details>
<summary><b>How does auth work?</b></summary>

Email plus argon2id-hashed password. On success the server signs a JWT (HS256, 1-hour expiry) with
the user id as `sub`. The client stores it and sends `Authorization: Bearer <token>`. `requireAuth`
verifies the signature and attaches `req.user`; every failure mode — expired, tampered, garbage —
collapses to the same 401, because a client has no legitimate use for the difference.

It's mounted at the **mount point**, not per route:

```ts
app.use("/documents", requireAuth, documentRouter);
```

Forgetting the middleware on a newly added route is a classic way to ship an unauthenticated
endpoint. This makes it structurally impossible.
</details>

<details>
<summary><b>Is a JWT encrypted?</b></summary>

**No — signed, not encrypted.** Anyone holding it can base64-decode the payload and read the claims.
What they can't do is change a value and produce a matching signature without the secret. So: never
put secrets in the payload, and always set a short expiry.
</details>

<details>
<summary><b>Why argon2 and not bcrypt or SHA-256?</b></summary>

SHA-256 is fast, which is exactly wrong for passwords — a GPU tries billions of guesses per second.
Argon2id is deliberately slow **and memory-hard**, so each guess needs a large chunk of RAM, which
neuters GPU parallelism. It's the current OWASP recommendation; bcrypt is acceptable but has a
password-length cap and no memory hardness.

The library salts automatically and embeds the salt and cost parameters in the digest, so `verify`
re-derives correctly and raising the cost later doesn't invalidate old hashes.

The nice contrast in this codebase: content dedupe uses plain unsalted SHA-256, because there we
*want* identical input to collide. Same primitive family, opposite requirement.
</details>

<details>
<summary><b>⭐ What's wrong with your auth? (or: what would you fix first?)</b></summary>

*Volunteer these. Naming your own gaps is the strongest possible signal.*

1. **No refresh tokens, so no revocation.** Logout deletes the client's copy; the token stays valid
   until it expires. The fix is short-lived access tokens plus a refresh token with a server-side
   revocation list.
2. **A login timing side-channel.** The error message is identical for unknown email and wrong
   password — that's deliberate, to prevent user enumeration. But the *timing* isn't: unknown email
   returns after one DB lookup, known email pays for a deliberately slow argon2 verify. The standard
   fix is verifying against a dummy hash when the user isn't found, so both paths cost the same.
3. **The token is in `localStorage`**, so a successful XSS steals it. The hardening step is an
   `httpOnly` cookie — invisible to JS — which needs an API change and CSRF protection.
4. **No `helmet`** for security headers.

All four are known and deliberately deferred; none of them are discoveries I'd be making in the
interview.
</details>

<details>
<summary><b>Could a user access another user's document by guessing the id?</b></summary>

No. `userId` is in the `WHERE` clause, not checked afterwards:

```ts
const document = await prisma.document.findFirst({ where: { id, userId } });
if (!document) throw new HttpError(404, "Document not found");
```

The tempting alternative — fetch by id, then `if (doc.userId !== userId) throw 403` — is one
forgotten `if` away from an IDOR. Putting ownership in the query makes it structural.

And the status is **404, not 403**, on purpose: a 403 confirms the id is real, letting an attacker
enumerate ids to map another user's library. The response itself becomes an oracle.
</details>

<details>
<summary><b>Are you vulnerable to SQL injection? You write raw SQL.</b></summary>

No. Prisma's tagged template turns `${userId}` into a **bind parameter** — Postgres treats it as
data, never as SQL.

There *are* two `$executeRawUnsafe` calls, and the name is honest. They're for `SET LOCAL`, and
Postgres doesn't accept bind parameters in `SET` — it parses as configuration, not a query — so
string interpolation is the only option. It's safe for one specific reason: **both interpolated
values are module-level constants**, never request-derived. If either ever became caller-controlled,
that's SQL injection immediately, and there's a comment saying exactly that.
</details>

<details>
<summary><b>What does CORS protect you from?</b></summary>

Less than people assume. It stops *other websites* from reading your API on a logged-in user's
behalf. It is **not authentication** — it's enforced by the browser, so `curl` and Postman ignore it
entirely. The token is what authenticates.

I set an explicit origin rather than `*` because with `credentials: true` a wildcard is illegal, and
it'd have to be fixed the moment auth moves to cookies.
</details>

### 3.5 Cost, abuse and scale

<details>
<summary><b>⭐ You're posting this publicly. How do you stop it costing you money?</b></summary>

*Strong question, and the answer is genuinely layered.*

**Five layers:**

1. **Burst limit** — 10 queries/minute per user.
2. **Budget limit** — 50/day per user. Both exist because one window can't express both: 10/min alone
   permits 14,400/day, and 50/day alone permits all 50 in one second. Burst is mounted first so a
   flood is rejected by the cheap window and never drains the daily budget.
3. **Global cap** — 2,000/day shared, sized from unit cost: at roughly $0.0004 an answer that's well
   under a dollar a day at full draw, and it takes 40 accounts at their full budget to reach.
4. **Concurrency cap** — 2 simultaneous streams per user, because a rate limiter can't express it.
   Ten requests arriving in the same millisecond all pass a 10/min limit, and on a streaming route
   that's ten concurrent generations from one account.
5. **A spend cap on the OpenAI key itself** — the only backstop that still works when this code has a
   bug.

**Keying matters as much as the numbers.** Unauthenticated routes key on IP **subnet** (an IPv6
client typically gets a whole /64 and could otherwise rotate endlessly). Authenticated routes key on
`user.id`, because an IP is shared behind corporate NAT and changed at will on mobile data —
simultaneously too coarse and too easy to escape. **The account is what costs money, so the account
gets the budget.**

**And the setting that makes it real or fake:** `trust proxy` must be an exact hop count. In
production the socket belongs to the platform's edge (Vercel's), not the user, so `req.ip` is the
proxy unless Express is told otherwise. Unset, everyone on Earth shares one bucket. Set to `true`, an attacker forges
`X-Forwarded-For` and mints a fresh unlimited bucket per request — the limiter is still there, still
reporting, and enforcing nothing.

**And where the counters live, which the deployment forced:** the rate limiters are backed by Redis.
In memory they're exact on one instance and meaningless on many — the effective limit becomes
`limit × instances` and the global cap becomes per-instance, while every `RateLimit` header keeps
reporting correctly. On a platform that autoscales, that's a limiter that enforces nothing, so
`REDIS_URL` is required at boot in production rather than falling back.

**The detail worth volunteering, because it's the part that isn't obvious:** `rate-limit-redis`
prefixes every store with `rl:` by default, and the 1-minute and 1-day query limiters both key on
`user.id` — so out of the box both `INCR` the *same* key with different expiries and the burst window
silently resets the daily budget. Nothing errors; the limits just look flaky. The fix is a required
`name` per limiter, required rather than defaulted so the type checker makes it impossible to forget.

**The concurrency cap deliberately stayed in memory.** It counts open sockets, which this process
owns; a shared Redis counter would need a lease with a timeout to survive an instance dying
mid-stream. It's not broken, it's scoped — and the per-user *cost* bound it used to double as is now
the Redis limiters' job.
</details>

<details>
<summary><b>What breaks first at 100× the data?</b></summary>

Not the vector search — HNSW is roughly logarithmic. Three things go first:

1. **Ingestion latency.** It's synchronous today, inside the HTTP request. Long documents already
   have no headroom under the platform's function timeout. This is the first thing I'd fix, and
   it's designed: `pg-boss` on the same Postgres, `ingestDocument` unchanged as the job handler.
   Note the deployment made this *harder*, not easier — an in-process worker is a container move;
   on functions it needs a queue or cron service. That's a door the deploy closed knowingly.
2. **Filtered-search recall.** Post-filtering degrades as tenants multiply; iterative scan buys time,
   and the next move is per-tenant partial indexes — genuinely faster, but it multiplies index count
   by tenant count and needs a backfill.
3. **Index build memory.** HNSW builds are memory-hungry, and at tens of millions of vectors that's a
   real operational concern.

**And what I'd measure before changing anything:** I currently have no latency numbers. The targets
in the design doc are targets, not measurements, and I'd rather say that than quote a figure I made
up.
</details>

<details>
<summary><b>Why is ingestion synchronous if you know it should be queued?</b></summary>

*Don't be defensive. This is a scoping decision, and scoping decisions are senior work.*

Deliberate sequencing. The queue adds a second always-on service, and no serverless platform will
host it as a side effect of the API: work started outside a request either gets its CPU throttled or
is killed when the invocation returns. On the current Vercel deployment that means a queue consumer
cannot simply live inside the API process at all — it needs a separate worker, or a cron/queue
service. That's a real second component with its own cost and failure modes, not a library import.

I chose to finish the read path end to end first, because that's where the product value and the
harder engineering are. The write path's seam is already in place — `ingestDocument` takes a plain
object and returns a plain object, imports no Express, and becomes the job handler unchanged.

I'd also name the concrete consequence rather than leaving it abstract: a single transient OpenAI 429
fails the whole document, and the user can't retry because the dedupe hash will reject the
re-upload — a `FAILED` row still satisfies the unique constraint. That's a real dead end, and the
queue's retry-with-backoff is what fixes it.
</details>

### 3.6 Frontend

<details>
<summary><b>How do you render a streaming answer in React?</b></summary>

An async generator over `fetch`'s `ReadableStream`, consumed with `for await`, and a `switch` on a
discriminated union of event types — so adding an event server-side surfaces as a TypeScript error
rather than a silently ignored message.

Three details that matter:

- **`setAnswer(prev => prev + value)`** — functional update. Tokens land faster than React commits;
  `setAnswer(answer + value)` reads a stale value from the render's closure and drops characters.
  Only shows up under speed.
- **The `AbortController` lives in a ref, not state.** Aborting must not trigger a render, and the
  handler needs the *current* controller — a state value is captured by the closure at the render
  that created it, so Stop could abort a request that already finished.
- **Sources render before the first token**, because the server emits them first. Retrieval is fast,
  generation is slow, so filling the screen during the wait is free.
</details>

<details>
<summary><b>What bugs did you hit with the stream parsing?</b></summary>

*Excellent thing to have a real answer for.*

Two, and both have the same character — work in dev, fail in production:

1. **`TextDecoder` needs `{ stream: true }`.** A UTF-8 character is up to 4 bytes and a network chunk
   can split one down the middle. Without the flag you get replacement characters. **It only breaks
   on non-ASCII output**, which is why it reliably survives to production.
2. **A network chunk has nothing to do with a line boundary.** One read can deliver two and a half
   events. So I buffer and only consume up to the last complete newline. `JSON.parse(chunk)` without
   that works perfectly on short answers and fails on long ones — the worst possible failure
   schedule, because it passes every quick manual test.
</details>

<details>
<summary><b>Isn't your route guard a security hole?</b></summary>

`useRequireAuth` is a **UX guard, not a security boundary.** It hides UI; it protects nothing —
anyone can open devtools. What actually keeps one user's documents from another is that every API
route independently verifies the token. The frontend guard just avoids showing a logged-out user a
broken page.
</details>

---

## 4. Known gaps — say these before they find them

Have this list ready. Volunteering it converts every one of them from a weakness into evidence of
judgement.

| Gap | The honest framing |
|---|---|
| **Tests cover the boundary, not the database path** | 53 unit + HTTP tests run with no database and no network: validation schemas, chunking, and everything that resolves before the first query — auth rejections, body-parser failures, routing. What's *not* covered is anything needing a real row, which includes the three highest-value targets: the tenant-scope predicate in retrieval, the P2002 dedupe race, and the stream line-buffering. Those need an integration tier against a real Postgres with a stub embedder. The seams are all in place (`embedFn`, `createApp()`); the tier isn't written. |
| **The conversations module has no tests at all** | It's the newest code in the repo and it was verified by hand against a real database and a real model — which is not the same thing, and I'd say so before being asked. Three pure functions belong in the unit tier today: the rewriter's fallback guards, the orphan-dropping in history construction, and title derivation. The persistence path, the `seq` race and "an abort still writes the partial answer" all need the integration tier above. |
| **Rewrite quality is unmeasured** | The rewrite step sits upstream of retrieval, so it has its own failure mode: a rewrite that loses the user's intent produces *confident retrieval of the wrong passage*, which reads exactly like a retrieval regression. The measurement that would justify the step is hit-rate@k on the rewritten query versus the raw follow-up over a multi-turn set. It doesn't exist yet, which is why the single-turn endpoint was deliberately left untouched — the existing golden set still scores something clean. |
| **The rewritten query isn't persisted** | It's streamed to the UI so you can see what was actually searched for, but it's a property of the turn rather than the stored message, so it's gone on reload. One nullable column would fix it; deferred as a second migration for what is essentially a debugging affordance. |
| **No eval harness *yet*** | Which means `k=5`, chunk 1000/200 and `ef_search=100` are still judgement calls, not measurements. In progress: the corpus builder and the test runner are done, the golden set and the metrics are not. Nothing about answer quality has been measured, so nothing about it is claimed. |
| **Synchronous ingestion** | Should be queued. The seam is in place; the concrete dead-end it causes (transient 429 → `FAILED` → dedupe blocks retry) is known. |
| **No refresh tokens / revocation** | Logout is client-side only. Token stays valid up to an hour. |
| **Login timing side-channel** | Messages match, timings don't. Fix is a dummy-hash verify. |
| **Token in `localStorage`** | XSS-stealable. `httpOnly` cookie is the hardening step, and it needs CSRF protection with it. |
| **Concurrency cap is per-instance** | The rate limiters moved to Redis; the concurrency `Map` deliberately didn't, because it counts sockets this process owns. So "2 streams per user" is really "2 per instance" behind an autoscaler. The per-user cost bound it used to double as is now the Redis limiters' job — what's left is event-loop protection, which is exactly what a per-process count should protect. |
| **No hybrid search** | Embeddings underperform on exact identifiers — error codes, SKUs, names. BM25 + vector with fusion is the standard answer. I've seen this concretely: a test corpus of near-identical paragraphs distinguished only by a marker token retrieved at a flat ~0.52 similarity across all of them and correctly refused, because there was no *semantic* difference to find. |
| **Per-page chunking makes the page a hard chunk boundary** | Overlap can't bridge a page break, and a PDF of short pages produces many small, weakly-retrievable chunks — measured: the same document at two page densities gives 64 chunks (median 953 chars) versus 137 chunks (median 335), where the chars-per-page and chars-per-chunk distributions come out identical — the page boundary decided every split and `chunkSize` was never consulted. The fix is a merge pass, which needs a page *range* on the chunk table — a schema change. Still gated on the eval harness, because what's measured is the *mechanism*, not the retrieval cost. |
| **Uploaded files aren't stored** | Only the extracted text is kept. It means re-processing can't recover text a better parser would have found — the user would have to upload again. Fine while extraction is a solved problem for text-bearing PDFs; not fine if OCR were in scope. |
| **No OCR** | Scanned PDFs are detected (every page extracts empty) and rejected with a specific 422 rather than silently ingested as an empty document. Supporting them is a different capability, not a bigger version of this one. |
| **No re-ranking** | Top-k by cosine distance only. A cross-encoder re-ranker over ~20 candidates is the usual next quality win. |
| **Answer rendered as plain text** | It's markdown; rendering it properly means sanitising, since the text originates from a model reading user-supplied documents. Deliberate stopping point. |
| **No observability** | No structured logs, no tracing, no cost metering per query. Dollar metering needs `stream_options: { include_usage: true }` and somewhere to put it. |

**The sentence that ties it together:** *"I'd rather have a system where I can name every gap than
one where I can't."*

---

## 5. Résumé and portfolio

### Ground rules

- 🟡 **"Tested" is now partly true — say the true part and stop.** There are 42 unit and HTTP tests
  running with no database and no network. ✅ You can say "unit and HTTP-level test suite". ❌ You
  cannot say "test coverage", quote a coverage percentage, or imply the data layer is covered — the
  tenant-scope predicate, the dedupe race and the stream buffering are exactly what isn't tested
  yet, and they're the first thing a sharp interviewer will ask about. Volunteering that boundary is
  stronger than being caught at it.
- ✅ "Deployed to production" is now true and verifiable — `rag.abhisheksatyam.com`, live, with
  streaming and refusal behaviour confirmed against the deployed API. ❌ "Serving N users" is still
  not; don't write it.
- ❌ Don't quote latency or accuracy numbers. You haven't measured them. **One "what was your p95?"
  and a fabricated number ends the interview.** The eval harness is in progress and has produced
  exactly one measurement so far — a *chunking* statistic, not a quality one. See the next rule.
- 🟡 **The one measured number you may quote**, because it came from running the code: rendering the
  same document at two page densities gives 19 pages → 56 chunks (median 956 chars) versus 122 pages
  → 122 chunks (median 336 chars). Frame it as what it is — evidence that page boundaries override
  `chunkSize`, **not** evidence that retrieval got worse. That second claim needs hit-rate, which
  doesn't exist yet. Quoting it correctly is a demonstration of exactly the discipline this whole
  section is about.
  **Re-run `pnpm eval:inspect` before an interview.** These figures drift whenever the docs are
  edited, because the docs *are* the corpus — which is itself a decent thing to be able to explain.
- ✅ Do quantify what's actually verifiable: dimensions, limits, chunk sizes, rate limits, model names.

### Résumé bullets

Pick 3–4. Each is defensible from the code.

> **RAG Knowledge Assistant** — TypeScript · Express 5 · Next.js 16 · Postgres/pgvector · OpenAI
>
> - Built a document Q&A system with a full RAG pipeline: recursive chunking (1000/200 overlap),
>   batched OpenAI embeddings, and pgvector similarity search over an HNSW index with tuned
>   `ef_search` and iterative scan for filtered-search recall.
> - Designed a token-streaming endpoint over NDJSON with deferred response headers, so failures
>   before the first byte return real HTTP status codes while mid-stream failures are reported
>   in-band — plus client-disconnect propagation that aborts the upstream LLM call.
> - Enforced multi-tenant isolation across both the ORM and hand-written vector SQL, including
>   query-level ownership scoping (`WHERE userId`) and 404-over-403 responses to prevent ID
>   enumeration.
> - Implemented layered abuse and cost controls for a publicly-shared demo: per-user burst and daily
>   budgets, a global spend ceiling, and a per-user concurrent-stream cap, keyed on identity rather
>   than IP.
> - Modelled ingestion as a `PENDING → PROCESSING → READY | FAILED` state machine with SHA-256
>   content dedupe made race-safe by a database unique constraint and P2002 recovery.
> - Added multipart PDF ingestion with page-aware chunking, so citations resolve to a source page
>   rather than an internal chunk ordinal; file type is validated by magic bytes rather than the
>   client-supplied content type, and dedupe hashes extracted text so re-exports of the same
>   document don't re-embed.
> - Added multi-turn conversations with a history-aware query-rewriting step, so pronoun follow-ups
>   retrieve correctly, plus a sentinel path that skips retrieval entirely for reformat instructions;
>   citations are snapshotted per message so answers stay verifiable after the underlying chunks are
>   re-ingested.
> - Authored HLD and LLD design docs covering topology, failure modes, capacity, and a scaling
>   ladder.

**One-line version** for a skills-dense résumé:

> Full-stack RAG document Q&A app (TypeScript, Express, Next.js, Postgres/pgvector, OpenAI) —
> streaming grounded answers with clickable citations, multi-turn conversations with query
> rewriting, multi-tenant vector search, and layered rate-limiting and cost controls.

### Skills this legitimately adds

**Backend:** Node.js · Express 5 · REST API design · layered architecture · middleware · JWT auth ·
argon2 password hashing · runtime validation (zod) · error handling · rate limiting · streaming HTTP
· multipart file upload · content-type validation by magic bytes · PDF text extraction (pdf.js)

**Database:** PostgreSQL · Prisma ORM · schema design · migrations · indexing (composite, unique,
HNSW) · transactions · connection pooling · raw SQL · multi-tenant data isolation

**AI:** RAG architecture · embeddings · vector search · cosine similarity · chunking strategy ·
prompt engineering · grounding and hallucination mitigation · LLM streaming · token-cost management

**Frontend:** Next.js 16 · React 19 · streaming UI · async generators · `ReadableStream` parsing ·
auth context and route guards · TypeScript

### Portfolio blurb

> **RAG Knowledge Assistant**
> Ask questions about your own documents and get answers grounded in your text — streamed live, with
> clickable citations that jump to the exact passage, and an explicit refusal when your documents
> don't contain the answer.
>
> Built as a full-stack system rather than a demo: a standalone Express + TypeScript API, Postgres
> with pgvector for similarity search, multi-tenant isolation enforced in every query including
> hand-written vector SQL, and layered rate-limiting sized from real per-request cost.
>
> The repo includes HLD and LLD documents covering topology, failure modes, and the scaling ladder —
> including what I'd fix first and why.

**Pin the design docs in your README.** For a senior/lead role they are worth more than another
feature. Very few portfolio projects come with an honest failure-modes table.

---

## 6. Self-quiz

Cover the answers. If you hesitate, reread the linked section.

**Concepts**
1. What are the three parts of a JWT, and which one can a client forge? → [§1.6](concepts.md#16-jwt--how-the-server-knows-who-you-are)
2. Why is `<=>` distance and not similarity, and which direction is better?
3. What breaks if you swap the embedding model? Why isn't it an env var? → [§2.2](concepts.md#22-embeddings--the-one-idea-to-actually-understand)
4. Why is `SET LOCAL` inside a transaction on a read path? → [§1.9](concepts.md#19-transactions-and-why-they-appear-twice-here-for-different-reasons)
5. Why 404 and not 403 for someone else's document? → [§1.10](concepts.md#110-raw-sql-and-the-one-place-the-compiler-stops-helping)
6. Why is `trust proxy: 1` and not `true`? → [§1.11](concepts.md#111-rate-limiting-and-concurrency--two-different-problems)
7. What's the difference between the dedupe hash and the password hash? → [§1.5](concepts.md#15-passwords-hashing-is-not-encryption)

**Flows**
8. Where exactly does `userId` come from on `POST /documents`? → [Flow 4](flows.md#flow-4--ingest-a-document-the-write-path)
9. Which line makes the query endpoint able to return a 429 at all? → [Flow 6](flows.md#part-b--the-header-deferral-design-the-interview-centrepiece)
10. Why are there two try/catch blocks in `ingestDocument`?
11. What happens to the second of two simultaneous identical uploads?
12. Why does `POST /documents` re-read the row before responding?
13. Trace the abort chain from tab-close to OpenAI.
14. Why does the documents page poll the list rather than each document?
15. Why doesn't `express.json({ limit: "1mb" })` bound a 4 MB upload? → [§1.14](concepts.md#114-file-uploads--multipart-and-the-limit-that-doesnt-apply)
16. Why is `file.mimetype` worthless as a security control, and what replaces it?
17. Why must you *not* set `Content-Type` when sending a `FormData` body?
18. Dedupe hashes extracted text, not file bytes. Give the argument for that, then the cost.
19. What does per-page chunking do to a 300-page PDF of one-paragraph pages? → [§2.3](concepts.md#23-chunking--why-documents-get-cut-up)

**Conversations**
20. Why does "How long is it?" retrieve nothing, and which component is at fault? → [§2.7](concepts.md#27-conversational-rag--why-a-follow-up-breaks-everything)
21. The rewrite drives one thing and the original question drives another. Which is which, and what
    breaks if you swap them?
22. Why does "make that shorter" skip retrieval entirely instead of just searching for it?
23. Turn 1 and turn 3 both have a source `[2]`. Name the two separate places that collision has to
    be handled — one in the prompt, one in the UI.
24. Why is history loaded from the database rather than posted by the client? → [Flow 9](flows.md#flow-9--ask-a-follow-up-the-conversation-path)
25. Why is the assistant message written in a `finally`, and why is that write `.catch`-wrapped?
26. Two tabs append to the same thread at the same moment. What stops the transcript interleaving,
    and what status code does the loser get?
27. Why do the rate limiters sit on the chat POSTs rather than at the router's mount point?
28. Why wasn't the rewrite step just added to the existing `/queries` endpoint?

**Judgement**
29. What's the first thing you'd fix, and why that one?
30. What can't you currently measure?
31. What would break first at 100× scale?
32. Which decision in this project are you least sure about? *(Good honest answer: chunk size — and
    now per-page vs. whole-document chunking, which is the same kind of question. The eval harness
    exists to settle both. A close second: shipping two question-answering surfaces, `/ask` and
    `/chat`, and whether that's a defensible split or one I should collapse.)*
33. You added a feature you'd previously listed as "deferred until evals prove it helps." Defend
    that. *(Honest answer: multi-turn is unusable without it, so the sequencing changed — but it
    shipped on a product argument, not a measured one, and nothing in the repo claims otherwise.)*

---

## 7. When you don't know

You will get a question you can't answer. The move that separates senior from mid-level:

> "I haven't worked with that. My instinct would be X, because [reasoning from something you do
> know] — but I'd want to verify that before relying on it."

Never bluff a number. Never invent a benchmark. **"I don't know, here's how I'd find out"** is a
complete and respected answer; a confidently wrong one is disqualifying.

And note the pleasing symmetry, which is worth saying out loud if it fits: *that's exactly what this
system does when it doesn't have the answer.*
