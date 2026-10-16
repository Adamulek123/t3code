import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlReadContext from "@t3tools/source-control-core/server/SourceControlReadContext";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
  responseStream: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Stream.Stream<Uint8Array> | undefined = () => undefined,
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let tokens = ["first", "second"];
  let invalidations = 0;
  let credentialReads = 0;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.sync(() => {
          credentialReads++;
          return {
            host,
            token: Redacted.make(tokens[0]!),
            source: "gh" as const,
            fingerprint: `${host}:${tokens[0]}`,
          };
        }),
      invalidate: () =>
        Effect.sync(() => {
          invalidations++;
          tokens = tokens.slice(1);
        }),
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      const response = HttpClientResponse.fromWeb(request, respond(request));
      const stream = responseStream(request);
      if (stream !== undefined) Object.defineProperty(response, "stream", { value: stream });
      return Effect.succeed(response);
    }),
  );
  const layer = GitHubApi.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return {
    layer,
    requests,
    invalidations: () => invalidations,
    credentialReads: () => credentialReads,
  };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const gateHarness = Effect.gen(function* () {
  const requests: string[] = [];
  const pending = new Map<
    string,
    { readonly started: Deferred.Deferred<void>; readonly answer: Deferred.Deferred<Response> }
  >();
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
        const entry = pending.get(path)!;
        requests.push(path);
        yield* Deferred.succeed(entry.started, undefined);
        return HttpClientResponse.fromWeb(request, yield* Deferred.await(entry.answer));
      }),
    ),
  );
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("gate-test"),
          source: "gh" as const,
          fingerprint: `${host}:gate-test`,
        }),
      invalidate: () => Effect.void,
    }),
  );
  const layer = GitHubApi.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  const api = yield* GitHubApi.GitHubApi.pipe(Effect.provide(layer));
  const prepare = Effect.fnUntraced(function* (name: string) {
    const started = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<Response>();
    pending.set(`/${name}`, { started, answer });
    return {
      started,
      ordinaryRead: api.rest({ host: "github.com", operation: "gate-test", path: name }),
      read: api
        .rest({ host: "github.com", operation: "gate-test", path: name })
        .pipe(Effect.provideService(SourceControlReadContext.Background, true)),
      respond: (response = json({ ok: true })) => Deferred.succeed(answer, response),
    };
  });
  return { prepare, requests };
});

describe("gitHubApiUrls", () => {
  it("maps github.com, GHE.com and GitHub Enterprise Server", () => {
    expect(GitHubApi.gitHubApiUrls("GitHub.com")).toEqual({
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
    });
    expect(GitHubApi.gitHubApiUrls("acme.ghe.com").graphql).toBe(
      "https://api.acme.ghe.com/graphql",
    );
    expect(GitHubApi.gitHubApiUrls("git.acme.internal")).toEqual({
      rest: "https://git.acme.internal/api/v3",
      graphql: "https://git.acme.internal/api/graphql",
    });
  });
});

describe("environmentToken", () => {
  it("follows gh's precedence per kind of host", () => {
    const env = { GH_TOKEN: "gh", GITHUB_TOKEN: "github", GH_ENTERPRISE_TOKEN: "ghe" };
    expect(GitHubCredentials.environmentToken("github.com", env)).toBe("gh");
    expect(GitHubCredentials.environmentToken("acme.ghe.com", { GITHUB_TOKEN: "github" })).toBe(
      "github",
    );
    // An enterprise token only goes to the host GH_HOST names, never to whatever a remote says.
    expect(GitHubCredentials.environmentToken("git.acme.internal", env)).toBeNull();
    expect(
      GitHubCredentials.environmentToken("git.acme.internal", {
        ...env,
        GH_HOST: "git.acme.internal",
      }),
    ).toBe("ghe");
    expect(GitHubCredentials.environmentToken("git.acme.internal", { GH_TOKEN: "gh" })).toBeNull();
  });
});

describe("GitHubApi", () => {
  it.effect("repeating ordinary reads allow queued background HTTP to make progress", () =>
    Effect.gen(function* () {
      // GLOBAL_SLOTS mirrors GitHubApi's global gate width. Ordinary readers share that gate with
      // the single background caller admitted at a time, so a fair hand-off lets them run for at
      // most two rounds of slots between background reads. Changing the width is a deliberate
      // concurrency decision and should move these expectations with it.
      const GLOBAL_SLOTS = 8;
      const BACKGROUND_READS = 32;
      const ORDINARY_WORKERS = 8;
      const ORDINARY_READS_PER_WORKER = 10;
      const h = yield* gateHarness;
      const background = yield* Effect.forEach(
        Array.from({ length: BACKGROUND_READS }, (_, index) => `background-${index}`),
        h.prepare,
      );
      const backgroundFibers = yield* Effect.forEach(background, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(background.slice(0, GLOBAL_SLOTS), (entry) =>
        Deferred.await(entry.started),
      );
      yield* Effect.forEach(background.slice(GLOBAL_SLOTS), (entry) => entry.respond());
      const ordinary = yield* Effect.forEach(
        Array.from({ length: ORDINARY_WORKERS }, (_, worker) => worker),
        (worker) =>
          Effect.forEach(
            Array.from(
              { length: ORDINARY_READS_PER_WORKER },
              (_, index) => `ordinary-${worker}-${index}`,
            ),
            (name) => h.prepare(name).pipe(Effect.tap((entry) => entry.respond())),
          ),
      );
      const ordinaryFibers = yield* Effect.forEach(ordinary, (entries) =>
        Effect.forEach(entries, (entry) => entry.ordinaryRead).pipe(
          Effect.forkChild({ startImmediately: true }),
        ),
      );
      yield* Effect.forEach(background.slice(0, GLOBAL_SLOTS), (entry) => entry.respond());
      yield* Effect.forEach(backgroundFibers, Fiber.join);
      yield* Effect.forEach(ordinaryFibers, Fiber.join);
      let remaining = background.length;
      let ordinaryStreak = 0;
      let longestOrdinaryStreak = 0;
      for (const path of h.requests) {
        if (path.startsWith("/background-")) {
          remaining--;
          ordinaryStreak = 0;
        } else if (remaining > 0) {
          ordinaryStreak++;
          longestOrdinaryStreak = Math.max(longestOrdinaryStreak, ordinaryStreak);
        }
      }
      const expectedRequests = BACKGROUND_READS + ORDINARY_WORKERS * ORDINARY_READS_PER_WORKER;
      expect(h.requests).toHaveLength(expectedRequests);
      expect(new Set(h.requests).size).toBe(expectedRequests);
      expect(longestOrdinaryStreak).toBeLessThanOrEqual(GLOBAL_SLOTS * 2);
    }),
  );

  it.effect("parks all but one queued background read outside the gate queue", () =>
    Effect.gen(function* () {
      // Eight held reads occupy the gate. The background reads beyond the first park on the single
      // background admission slot instead of joining the gate queue, so an ordinary read that
      // arrives after them is admitted within a slot turn or two. If every background read camped
      // the gate instead, it would queue behind all eight.
      const GLOBAL_SLOTS = 8;
      const QUEUED_BACKGROUND = 8;
      const h = yield* gateHarness;
      const held = yield* Effect.forEach(
        Array.from({ length: GLOBAL_SLOTS }, (_, index) => `held-${index}`),
        h.prepare,
      );
      const holding = yield* Effect.forEach(held, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(held, (entry) => Deferred.await(entry.started));
      const background = yield* Effect.forEach(
        Array.from({ length: QUEUED_BACKGROUND }, (_, index) => `background-${index}`),
        h.prepare,
      );
      const backgroundFibers = yield* Effect.forEach(background, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      const ordinary = yield* h.prepare("ordinary");
      const ordinaryFiber = yield* ordinary.ordinaryRead.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      // Answer everything, then let the gate drain: admissions keep gate-queue order.
      yield* Effect.forEach([...held, ...background, ordinary], (entry) => entry.respond());
      yield* Effect.forEach([...holding, ...backgroundFibers, ordinaryFiber], Fiber.join);
      const ordinaryIndex = h.requests.indexOf("/ordinary");
      expect(ordinaryIndex).toBeGreaterThanOrEqual(0);
      expect(ordinaryIndex).toBeLessThanOrEqual(GLOBAL_SLOTS + 2);
      expect(h.requests).toHaveLength(GLOBAL_SLOTS + QUEUED_BACKGROUND + 1);
    }),
  );

  it.effect("background admission releases before HTTP and fills all eight global slots", () =>
    Effect.gen(function* () {
      const h = yield* gateHarness;
      const reads = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => `read-${index}`),
        h.prepare,
      );
      const fibers = yield* Effect.forEach(reads, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(reads, (entry) => Deferred.await(entry.started));
      expect(h.requests).toHaveLength(8);
      yield* Effect.forEach(reads, (entry) => entry.respond());
      yield* Effect.forEach(fibers, Fiber.join);
    }),
  );

  it.effect(
    "canceling background admission waiters leaves no request and permits later reads",
    () =>
      Effect.gen(function* () {
        const h = yield* gateHarness;
        const active = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => `active-${index}`),
          h.prepare,
        );
        const activeFibers = yield* Effect.forEach(active, (entry) =>
          entry.read.pipe(Effect.forkChild({ startImmediately: true })),
        );
        yield* Effect.forEach(active, (entry) => Deferred.await(entry.started));
        const globalWaiter = yield* h.prepare("canceled-global-waiter");
        const admissionWaiter = yield* h.prepare("canceled-admission-waiter");
        const globalFiber = yield* globalWaiter.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const admissionFiber = yield* admissionWaiter.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(admissionFiber);
        yield* Fiber.interrupt(globalFiber);
        const replacement = yield* h.prepare("replacement");
        const replacementFiber = yield* replacement.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.forEach(active, (entry) => entry.respond());
        yield* Deferred.await(replacement.started);
        yield* replacement.respond();
        yield* Effect.forEach(activeFibers, Fiber.join);
        yield* Fiber.join(replacementFiber);
        expect(h.requests).toEqual([
          ...Array.from({ length: 8 }, (_, index) => `/active-${index}`),
          "/replacement",
        ]);
      }),
  );

  it.effect(
    "interrupting active background HTTP returns the global permit and keeps admission usable",
    () =>
      Effect.gen(function* () {
        const h = yield* gateHarness;
        const interrupted = yield* h.prepare("interrupted");
        const interruptedFiber = yield* interrupted.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(interrupted.started);
        yield* Fiber.interrupt(interruptedFiber);
        const reads = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => `replacement-${index}`),
          h.prepare,
        );
        const fibers = yield* Effect.forEach(reads, (entry) =>
          entry.read.pipe(Effect.forkChild({ startImmediately: true })),
        );
        yield* Effect.forEach(reads, (entry) => Deferred.await(entry.started));
        expect(h.requests).toHaveLength(9);
        yield* Effect.forEach(reads, (entry) => entry.respond());
        yield* Effect.forEach(fibers, Fiber.join);
      }),
  );

  it.effect("a failed background response returns its permits before the next eight reads", () =>
    Effect.gen(function* () {
      const h = yield* gateHarness;
      const failed = yield* h.prepare("failed");
      const failureFiber = yield* Effect.flip(failed.read).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(failed.started);
      yield* failed.respond(json({ message: "Unavailable" }, { status: 503 }));
      expect((yield* Fiber.join(failureFiber))._tag).toBe("GitHubApiResponseError");
      const reads = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => `after-failure-${index}`),
        h.prepare,
      );
      const fibers = yield* Effect.forEach(reads, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(reads, (entry) => Deferred.await(entry.started));
      expect(h.requests).toHaveLength(9);
      yield* Effect.forEach(reads, (entry) => entry.respond());
      yield* Effect.forEach(fibers, Fiber.join);
    }),
  );

  it.effect("sends GraphQL with the token, and the document as written", () => {
    const { layer, requests } = harness(() => json({ data: { viewer: { login: "julius" } } }));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const body = yield* api.graphql({
        host: "github.com",
        operation: "viewer",
        query: "query { viewer { login } }",
      });
      expect(body).toContain('"login":"julius"');
      expect(requests[0]!.url).toBe("https://api.github.com/graphql");
      expect(requests[0]!.headers.authorization).toBe("Bearer first");
      // No `rateLimit` selection is added: the quota is read off the response headers.
      const sent = requests[0]!.body;
      expect(sent._tag === "Uint8Array" ? new TextDecoder().decode(sent.body) : "").toContain(
        '"query":"query { viewer { login } }"',
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves GraphQL credentials once per request and refreshes after refusal", () => {
    const { layer, requests, invalidations, credentialReads } = harness((request) =>
      request.headers.authorization === "Bearer first"
        ? new Response(null, { status: 401 })
        : json({ data: { viewer: { login: "julius" } } }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const input = {
        host: "github.com",
        operation: "viewer",
        query: "query { viewer { login } }",
      };
      const refused = yield* Effect.flip(api.graphql(input));
      expect(refused._tag).toBe("GitHubApiAuthenticationError");
      expect(credentialReads()).toBe(1);
      expect(invalidations()).toBe(1);

      const body = yield* api.graphql(input);
      expect(body).toContain('"login":"julius"');
      expect(credentialReads()).toBe(2);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "traces the operation, path, query and quota, never the query string or variables",
    () => {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const { layer } = harness((request) =>
        request.url.endsWith("/graphql")
          ? json(
              { data: { viewer: { login: "julius" } } },
              { headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-resource": "graphql" } },
            )
          : json({ ok: true }, { headers: { "x-ratelimit-remaining": "4800" } }),
      );
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const api = yield* GitHubApi.GitHubApi;
        yield* api.graphql({
          host: "github.com",
          operation: "getPullRequestDetail",
          query: "query($body: String!) { viewer { login } }",
          variables: { body: "secret user text" },
        });
        yield* api.rest({
          host: "github.com",
          operation: "listWorkflowRuns",
          path: "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fx",
        });
        const byName = (name: string) => spans.filter((span) => span.name === name);
        // Select send spans by kind, so an added span or a retry cannot shift these assertions.
        const sendOfKind = (kind: string) =>
          byName("GitHubApi.send").find((span) => span.attributes.get("github.kind") === kind)!;
        const graphql = Object.fromEntries(byName("GitHubApi.graphql")[0]!.attributes);
        expect(graphql).toMatchObject({
          "github.operation": "getPullRequestDetail",
          "github.graphql.query": "query($body: String!) { viewer { login } }",
        });
        expect(Object.fromEntries(sendOfKind("graphql").attributes)).toMatchObject({
          "github.ratelimit.remaining": 4990,
          "github.ratelimit.resource": "graphql",
        });
        expect(String(graphql["github.graphql.query_hash"])).toMatch(/^[0-9a-f]{8}$/);
        const rest = Object.fromEntries(sendOfKind("rest").attributes);
        expect(rest).toMatchObject({
          "github.operation": "listWorkflowRuns",
          "github.kind": "rest",
          "url.path": "/repos/acme/web/actions/runs",
          "http.response.status_code": 200,
          "github.ratelimit.remaining": 4800,
        });
        // Nothing recorded carries the query string, the variables, or the token.
        const everything = spans
          .flatMap((span) => [...span.attributes].map(([key, value]) => `${key}=${String(value)}`))
          .join("\n");
        expect(everything).not.toContain("head_sha");
        expect(everything).not.toContain("secret user text");
        expect(everything).not.toContain("first");
        expect(spans.some((span) => span.attributes.has("url.full"))).toBe(false);
      }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
    },
  );

  it.effect("fails a GraphQL answer that carries errors, naming GitHub's reason", () => {
    const { layer } = harness(() =>
      json({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "detail", query: "query { viewer { id } }" }),
      );
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(error.message).toContain("Resource not accessible");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["plain data", '{"data":{"viewer":{"login":"julius"}}}'],
    // A `data` payload may carry the word "errors" without being an error list.
    ["data shaped like an error list", '{"data":{"description":"errors","errors":[]}}'],
  ] as const)("returns healthy GraphQL %s unchanged", ([_name, raw]) => {
    const { layer, requests, invalidations } = harness(() => new Response(raw));
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const body = yield* api.graphql({
        host: "github.com",
        operation: "viewer",
        query: "query { viewer { login } }",
      });
      expect(body).toBe(raw);
      expect(requests).toHaveLength(1);
      expect(invalidations()).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("masks a whole opted summary alias while retaining unrelated rows", () => {
    const good = { pullRequest: { number: 7, title: "Complete" } };
    const { layer, requests } = harness(() =>
      json({
        data: { s0: good, s1: { pullRequest: { number: 8, title: null } } },
        errors: [
          { type: "NOT_FOUND", path: ["s1", "pullRequest", "title"] },
          { type: "NOT_FOUND", path: ["s1", "pullRequest", "reviews", 0] },
        ],
      }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const input = {
        host: "github.com",
        operation: "getPullRequestSummary",
        query: "query { s0: repository { id } s1: repository { id } }",
      };
      const strict = yield* Effect.flip(api.graphql(input));
      expect(strict._tag).toBe("GitHubApiNotFoundError");
      const retained = yield* api.graphql({ ...input, partialNotFoundAliases: ["s0", "s1"] });
      expect(JSON.parse(retained)).toEqual({ data: { s0: good, s1: null } });
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["an array", { data: [{ pullRequest: { number: 7 } }] }],
    ["a string", { data: "partial" }],
    ["null", { data: null }],
  ] as const)("keeps an opted NOT_FOUND response strict when data is %s", ([_name, payload]) => {
    const { layer } = harness(() =>
      json({ ...payload, errors: [{ type: "NOT_FOUND", path: ["s1"] }] }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({
          host: "github.com",
          operation: "getPullRequestSummary",
          query: "query { s0: repository { id } }",
          partialNotFoundAliases: ["s0", "s1"],
        }),
      );
      expect(error._tag).toBe("GitHubApiNotFoundError");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["missing", undefined],
    ["empty", []],
    ["unknown alias", ["s2"]],
    ["numeric root", [1]],
    ["malformed", { alias: "s1" }],
    ["negative descendant", ["s1", -1]],
    ["fractional descendant", ["s1", 0.5]],
    ["null descendant", ["s1", null]],
  ] as const)("keeps an opted NOT_FOUND response strict for a %s path", ([_name, path]) => {
    const { layer } = harness(() =>
      json({
        data: { s0: { pullRequest: { number: 7 } }, s1: null },
        errors: [{ type: "NOT_FOUND", path }],
      }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({
          host: "github.com",
          operation: "getPullRequestSummary",
          query: "query { s0: repository { id } s1: repository { id } }",
          partialNotFoundAliases: ["s0", "s1"],
        }),
      );
      expect(error._tag).toBe("GitHubApiNotFoundError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not retain opted rows when another error is forbidden or rate limited", () => {
    return Effect.forEach(
      [true, false],
      (forbidden) => {
        const { layer, requests } = harness(() =>
          json({
            data: { s0: { pullRequest: { number: 7 } }, s1: null },
            errors: [
              { type: "NOT_FOUND", path: ["s1"] },
              { type: forbidden ? "FORBIDDEN" : "RATE_LIMITED", path: { malformed: true } },
            ],
          }),
        );
        return Effect.gen(function* () {
          const api = yield* GitHubApi.GitHubApi;
          const input = {
            host: "github.com",
            operation: "getPullRequestSummary",
            query: "query { s0: repository { id } s1: repository { id } }",
            partialNotFoundAliases: ["s0", "s1"],
          };
          const error = yield* Effect.flip(api.graphql(input));
          expect(error._tag).toBe(forbidden ? "GitHubApiResponseError" : "GitHubApiRateLimitError");
          if (!forbidden) {
            const paused = yield* Effect.flip(api.graphql(input));
            expect(paused._tag).toBe("SourceControlRateLimitPausedError");
            expect(requests).toHaveLength(1);
          }
        }).pipe(Effect.provide(layer));
      },
      { concurrency: 1, discard: true },
    );
  });

  it.effect("invalidates a refused credential before considering opted partial rows", () => {
    const { layer, requests, invalidations, credentialReads } = harness(() =>
      json(
        {
          data: { s0: { pullRequest: { number: 7 } } },
          errors: [{ type: "NOT_FOUND", path: ["s0"] }],
        },
        { status: 401 },
      ),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({
          host: "github.com",
          operation: "getPullRequestSummary",
          query: "query { s0: repository { id } }",
          partialNotFoundAliases: ["s0"],
        }),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(1);
      expect(invalidations()).toBe(1);
      expect(credentialReads()).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reads a NOT_FOUND answer with another error as a failure, not a missing resource",
    () => {
      const { layer } = harness(() =>
        json({
          data: null,
          errors: [
            { type: "NOT_FOUND", message: "Could not resolve" },
            { message: "Something went wrong" },
          ],
        }),
      );
      return Effect.gen(function* () {
        const api = yield* GitHubApi.GitHubApi;
        const error = yield* Effect.flip(
          api.graphql({
            host: "github.com",
            operation: "detail",
            query: "query { viewer { id } }",
          }),
        );
        expect(error._tag).toBe("GitHubApiResponseError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("pauses the host after a GraphQL RATE_LIMITED answer until the reset", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { layer, requests } = harness(() =>
      json(
        { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const first = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "summary", query: "query { viewer { id } }" }),
      );
      expect(first).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: reset * 1000 });
      const second = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "stack", path: "repos/acme/web/stacks" }),
      );
      expect(second).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: reset * 1000,
      });
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the last tenth of a quota for interactive requests until it resets", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const quota = (remaining: number) => ({
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(reset),
    });
    let remaining = 499;
    const { layer, requests } = harness((request) =>
      request.url.endsWith("/graphql")
        ? json({ data: { viewer: { id: "1" } } })
        : json({ ok: true }, { headers: quota(remaining--) }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const read = { host: "github.com", operation: "sweep", path: "repos/acme/web/pulls" };
      // The first answer leaves 499 of 5000, under the last tenth; the next background read waits.
      yield* api.rest(read);
      const refused = yield* Effect.flip(api.rest(read));
      expect(refused).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: reset * 1000,
      });
      // A user's own request may spend the reserve, and GraphQL has a quota of its own.
      yield* api.rest(read).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      yield* api.graphql({ host: "github.com", operation: "x", query: "query { viewer { id } }" });
      expect(requests).toHaveLength(3);
      // The reset gives the background its quota back.
      yield* TestClock.setTime(reset * 1000);
      yield* api.rest(read);
      expect(requests).toHaveLength(4);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reserves quota as soon as headers arrive while the body is still pending", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const bodyEntered = yield* Deferred.make<void>();
      const bodyAllowed = yield* Deferred.make<void>();
      const reset = Math.floor(NOW / 1000) + 600;
      const { layer, requests } = harness(
        (request) =>
          json(
            { ok: true },
            request.url.endsWith("/held")
              ? {
                  headers: {
                    "x-ratelimit-resource": "core",
                    "x-ratelimit-limit": "5000",
                    "x-ratelimit-remaining": "499",
                    "x-ratelimit-reset": String(reset),
                  },
                }
              : undefined,
          ),
        (request) =>
          request.url.endsWith("/held")
            ? Stream.fromEffect(Deferred.succeed(bodyEntered, undefined)).pipe(
                Stream.flatMap(() => Stream.fromEffect(Deferred.await(bodyAllowed))),
                Stream.flatMap(() => Stream.make(new TextEncoder().encode('{"ok":true}'))),
              )
            : undefined,
      );
      yield* Effect.gen(function* () {
        const api = yield* GitHubApi.GitHubApi;
        const held = yield* api
          .rest({ host: "github.com", operation: "held", path: "held" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(bodyEntered);
        const refused = yield* Effect.flip(
          api.rest({ host: "github.com", operation: "sweep", path: "user" }),
        );
        expect(refused).toMatchObject({
          _tag: "SourceControlRateLimitPausedError",
          retryAt: reset * 1000,
        });
        expect(requests).toHaveLength(1);
        const interactive = yield* api.rest({
          host: "github.com",
          operation: "user",
          path: "user",
          allowReserve: true,
        });
        expect(interactive.status).toBe(200);
        expect(requests).toHaveLength(2);
        yield* Deferred.succeed(bodyAllowed, undefined);
        expect((yield* Fiber.join(held)).body).toBe('{"ok":true}');
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps quota headers when an outstanding body is interrupted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const bodyEntered = yield* Deferred.make<void>();
      const reset = Math.floor(NOW / 1000) + 600;
      const { layer, requests } = harness(
        () =>
          json(
            { ok: true },
            {
              headers: {
                "x-ratelimit-resource": "core",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(reset),
              },
            },
          ),
        () =>
          Stream.fromEffect(Deferred.succeed(bodyEntered, undefined)).pipe(
            Stream.flatMap(() => Stream.fromEffect(Effect.never)),
          ),
      );
      yield* Effect.gen(function* () {
        const api = yield* GitHubApi.GitHubApi;
        const held = yield* api
          .rest({ host: "github.com", operation: "held", path: "held" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(bodyEntered);
        yield* Fiber.interrupt(held);
        const interrupted = yield* Fiber.await(held);
        expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
        const refused = yield* Effect.flip(
          api.rest({
            host: "github.com",
            operation: "user",
            path: "user",
            allowReserve: true,
          }),
        );
        expect(refused).toMatchObject({
          _tag: "SourceControlRateLimitPausedError",
          retryAt: reset * 1000,
        });
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("exhausted headers refuse an opted partial document before any follow-up HTTP", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const bodyEntered = yield* Deferred.make<void>();
      const bodyAllowed = yield* Deferred.make<void>();
      const reset = Math.floor(NOW / 1000) + 600;
      const body = JSON.stringify({
        data: { s0: { pullRequest: { number: 7 } }, s1: null },
        errors: [{ type: "NOT_FOUND", path: ["s1", "pullRequest"] }],
      });
      const { layer, requests } = harness(
        () =>
          new Response(body, {
            headers: {
              "x-ratelimit-resource": "graphql",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset),
            },
          }),
        () =>
          Stream.fromEffect(Deferred.succeed(bodyEntered, undefined)).pipe(
            Stream.flatMap(() => Stream.fromEffect(Deferred.await(bodyAllowed))),
            Stream.flatMap(() => Stream.make(new TextEncoder().encode(body))),
          ),
      );
      yield* Effect.gen(function* () {
        const api = yield* GitHubApi.GitHubApi;
        const input = {
          host: "github.com",
          operation: "getPullRequestSummary",
          query: "query { s0: repository { id } s1: repository { id } }",
          partialNotFoundAliases: ["s0", "s1"],
        };
        const held = yield* api.graphql(input).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(bodyEntered);
        expect(yield* Effect.flip(api.graphql(input))).toMatchObject({
          _tag: "SourceControlRateLimitPausedError",
          retryAt: reset * 1000,
        });
        expect(requests).toHaveLength(1);
        yield* Deferred.succeed(bodyAllowed, undefined);
        const result = yield* Fiber.join(held);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.findErrorOption(result.cause)).toMatchObject({
            _tag: "Some",
            value: { _tag: "GitHubApiRateLimitError" },
          });
        expect(yield* Effect.flip(api.graphql({ ...input, allowReserve: true }))).toMatchObject({
          _tag: "SourceControlRateLimitPausedError",
          retryAt: reset * 1000,
        });
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("carries GitHub's own reason for a refused REST request", () => {
    const { layer } = harness(() =>
      json(
        {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: "A pull request already exists for acme:feature.",
            },
          ],
        },
        { status: 422 },
      ),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.rest({
          host: "github.com",
          operation: "createPullRequest",
          method: "POST",
          path: "repos/acme/web/pulls",
        }),
      );
      expect(error.message).toBe(
        "GitHub returned an error: Validation Failed; A pull request already exists for acme:feature.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an interactive request through a pause a background read recorded", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    let call = 0;
    const { layer, requests } = harness(() =>
      ++call === 1
        ? json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          )
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const read = { host: "github.com", operation: "sweep", path: "repos/acme/web/pulls" };
      yield* Effect.flip(api.rest(read));
      expect((yield* Effect.flip(api.rest(read)))._tag).toBe("SourceControlRateLimitPausedError");
      const merged = yield* api
        .rest({
          host: "github.com",
          operation: "merge",
          method: "PUT",
          path: "repos/acme/web/pulls/7/merge",
        })
        .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(merged.status).toBe(200);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an untyped GraphQL quota error as a rate limit", () => {
    const reset = Math.floor(NOW / 1000) + 900;
    const { layer } = harness(() =>
      json(
        { errors: [{ message: "API rate limit already exceeded for user ID 1." }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "lookup", query: "query { viewer { id } }" }),
      );
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: reset * 1000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps REST 403 with an exhausted quota to a rate limit, and 304 to an answer", () => {
    let call = 0;
    const { layer } = harness(() =>
      ++call === 1
        ? new Response(null, { status: 304 })
        : json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "retry-after": "60" },
            },
          ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const notModified = yield* api.rest({
        host: "github.com",
        operation: "checks",
        path: "repos/acme/web/pulls/7",
        ifNoneMatch: '"abc"',
      });
      expect(notModified.status).toBe(304);
      const error = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "checks", path: "repos/acme/web/pulls/7" }),
      );
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: NOW + 60_000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a refused token so the next request asks the source again", () => {
    const { layer, requests, invalidations } = harness((request) =>
      request.headers.authorization === "Bearer first"
        ? new Response(null, { status: 401 })
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const refused = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "user", path: "user" }),
      );
      expect(refused._tag).toBe("GitHubApiAuthenticationError");
      expect(invalidations()).toBe(1);
      const answered = yield* api.rest({ host: "github.com", operation: "user", path: "user" });
      expect(answered.status).toBe(200);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to send a pinned credential to another host", () => {
    const { layer, requests } = harness(() => json({}));
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.rest({ host: "git.acme.internal", operation: "user", path: "user" }),
      ).pipe(
        Effect.provideService(GitHubApi.PinnedGitHubCredential, {
          host: "github.com",
          token: Redacted.make("pinned"),
          credentialFingerprint: "github.com:pinned",
        }),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCredentials", () => {
  const credentialsWith = (run: SourceControlHost.SourceControlHost["Service"]["process"]["run"]) =>
    GitHubCredentials.layer.pipe(
      Layer.provide(TestSourceControlHost.layer({ process: { run } })),
      Layer.provide(NodeCrypto.layer),
    );

  it.effect("fails with GitHubCliMissingError when gh is not on PATH", () =>
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("git.acme.internal"));
      expect(error._tag).toBe("GitHubCliMissingError");
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          Effect.fail(
            new VcsProcessSpawnError({
              operation: "GitHubCredentials.get",
              command: "gh",
              cwd: "/",
              cause: PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              }),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("does not cache a gh failure that is not about signing in", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const first = yield* Effect.flip(credentials.get("github.com"));
      expect(first._tag).toBe("GitHubCliFailedError");
      expect((yield* credentials.get("github.com")).source).toBe("gh");
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          ++calls === 1
            ? Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "GitHubCredentials.get",
                  command: "gh",
                  cwd: "/",
                  timeoutMs: 10_000,
                }),
              )
            : Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "token\n",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
        ),
      ),
    );
  });

  it.effect("fails with GitHubNotSignedInError when gh prints no token", () =>
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("git.acme.internal"));
      expect(error._tag).toBe("GitHubNotSignedInError");
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
      ),
    ),
  );
});
