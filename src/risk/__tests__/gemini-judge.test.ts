import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@google/genai";

import { GeminiIntentJudge, type GeminiContentClient } from "../geminiJudge.js";
import { ClassifiedJudgeError } from "../types.js";

/**
 * Offline tests for GeminiIntentJudge's own parsing/validation logic — no network
 * call, no API key, included in the default `npm test` run. These inject a fake
 * GeminiContentClient (see geminiJudge.ts's doc comment on why that's a safe seam)
 * so they prove response-handling correctness without depending on the real
 * @google/genai SDK actually reaching Google's servers. The real, network-calling
 * behavior is proven separately by gemini-judge.live.test.ts, opt-in only.
 */

const SAMPLE_INPUT = {
  delegatedGoal: "Book the cheapest flights and hotels for our Q3 conferences. Do not spend on anything else.",
  transaction: {
    amountMinorUnits: 38_000,
    currency: "USD",
    category: "flights",
    rail: "mock_x402",
    purpose: "Round-trip economy flight for the Q3 vendor conference",
  },
};

function fakeClientReturning(text: string | undefined): GeminiContentClient {
  return {
    models: {
      async generateContent() {
        return { text };
      },
    },
  };
}

describe("GeminiIntentJudge — construction", () => {
  test("throws when constructed with no apiKey, no client, and no GEMINI_API_KEY in the environment", () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      assert.throws(() => new GeminiIntentJudge(), /GeminiIntentJudge requires a Gemini API key/);
    } finally {
      if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test("construction succeeds with an injected client and no key at all — the offline test seam", () => {
    assert.doesNotThrow(() => new GeminiIntentJudge({ client: fakeClientReturning('{"verdict":"consistent","rationale":"ok"}') }));
  });
});

describe("GeminiIntentJudge — response parsing (fake client, no network)", () => {
  test("a well-formed structured response is parsed into the correct judgment", async () => {
    const judge = new GeminiIntentJudge({
      client: fakeClientReturning(JSON.stringify({ verdict: "consistent", rationale: "Matches the delegated goal." })),
    });
    const result = await judge.judge(SAMPLE_INPUT);
    assert.equal(result.verdict, "consistent");
    assert.equal(result.rationale, "Matches the delegated goal.");
  });

  test("each of the three valid verdicts round-trips correctly", async () => {
    for (const verdict of ["consistent", "inconsistent", "ambiguous"] as const) {
      const judge = new GeminiIntentJudge({
        client: fakeClientReturning(JSON.stringify({ verdict, rationale: "r" })),
      });
      const result = await judge.judge(SAMPLE_INPUT);
      assert.equal(result.verdict, verdict);
    }
  });

  test("no text in the response throws (never guesses a default verdict)", async () => {
    const judge = new GeminiIntentJudge({ client: fakeClientReturning(undefined) });
    await assert.rejects(judge.judge(SAMPLE_INPUT), /contained no text output/);
  });

  test("non-JSON text throws", async () => {
    const judge = new GeminiIntentJudge({ client: fakeClientReturning("not json at all") });
    await assert.rejects(judge.judge(SAMPLE_INPUT), /was not valid JSON/);
  });

  test("a verdict outside the three defined values throws, even though it parsed as valid JSON", async () => {
    const judge = new GeminiIntentJudge({
      client: fakeClientReturning(JSON.stringify({ verdict: "definitely_fine", rationale: "r" })),
    });
    await assert.rejects(judge.judge(SAMPLE_INPUT), /unrecognized verdict/);
  });

  test("a missing verdict field throws", async () => {
    const judge = new GeminiIntentJudge({ client: fakeClientReturning(JSON.stringify({ rationale: "r" })) });
    await assert.rejects(judge.judge(SAMPLE_INPUT), /unrecognized verdict/);
  });

  test("a missing or empty rationale throws, even with a valid verdict", async () => {
    const judgeNoRationale = new GeminiIntentJudge({ client: fakeClientReturning(JSON.stringify({ verdict: "consistent" })) });
    await assert.rejects(judgeNoRationale.judge(SAMPLE_INPUT), /no rationale/);

    const judgeEmptyRationale = new GeminiIntentJudge({
      client: fakeClientReturning(JSON.stringify({ verdict: "consistent", rationale: "" })),
    });
    await assert.rejects(judgeEmptyRationale.judge(SAMPLE_INPUT), /no rationale/);
  });

  test("a client that throws (network/timeout error) propagates the error rather than being swallowed", async () => {
    const throwingClient: GeminiContentClient = {
      models: {
        async generateContent() {
          throw new Error("simulated network failure");
        },
      },
    };
    const judge = new GeminiIntentJudge({ client: throwingClient });
    await assert.rejects(judge.judge(SAMPLE_INPUT), /simulated network failure/);
  });
});

describe("GeminiIntentJudge — classifies authentication failures separately from other API failures (never leaks the key either way)", () => {
  test("a real invalid-key-shaped ApiError is classified as an authentication failure", async () => {
    const client: GeminiContentClient = {
      models: {
        async generateContent() {
          throw new ApiError({ status: 400, message: "API key not valid. Please pass a valid API key." });
        },
      },
    };
    const judge = new GeminiIntentJudge({ client });
    await assert.rejects(judge.judge(SAMPLE_INPUT), (error: unknown) => {
      assert.ok(error instanceof ClassifiedJudgeError);
      assert.equal(error.category, "authentication");
      assert.match(error.message, /Gemini authentication failed/);
      assert.match(error.message, /API key not valid/);
      return true;
    });
  });

  test("a 429 ApiError is classified as a quota/rate-limit failure, not an authentication failure", async () => {
    const client: GeminiContentClient = {
      models: {
        async generateContent() {
          throw new ApiError({ status: 429, message: "RESOURCE_EXHAUSTED: quota exceeded for this project." });
        },
      },
    };
    const judge = new GeminiIntentJudge({ client });
    await assert.rejects(judge.judge(SAMPLE_INPUT), (error: unknown) => {
      assert.ok(error instanceof ClassifiedJudgeError);
      assert.equal(error.category, "quota");
      assert.match(error.message, /Gemini quota\/rate limit exceeded/);
      assert.doesNotMatch(error.message, /authentication/i);
      return true;
    });
  });

  test("a non-auth, non-429 ApiError (e.g. a 503 server error) is classified as provider_unavailable, not an authentication failure", async () => {
    const client: GeminiContentClient = {
      models: {
        async generateContent() {
          throw new ApiError({ status: 503, message: "The model is overloaded. Please try again later." });
        },
      },
    };
    const judge = new GeminiIntentJudge({ client });
    await assert.rejects(judge.judge(SAMPLE_INPUT), (error: unknown) => {
      assert.ok(error instanceof ClassifiedJudgeError);
      assert.equal(error.category, "provider_unavailable");
      assert.match(error.message, /Gemini is unavailable/);
      assert.doesNotMatch(error.message, /authentication/i);
      return true;
    });
  });

  test("a network-level failure (never reached a response) is classified as provider_unavailable", async () => {
    const client: GeminiContentClient = {
      models: {
        async generateContent() {
          throw new Error("ECONNRESET");
        },
      },
    };
    const judge = new GeminiIntentJudge({ client });
    await assert.rejects(judge.judge(SAMPLE_INPUT), (error: unknown) => {
      assert.ok(error instanceof ClassifiedJudgeError);
      assert.equal(error.category, "provider_unavailable");
      return true;
    });
  });

  test("a malformed response (unparseable JSON) is classified as malformed_response", async () => {
    const judge = new GeminiIntentJudge({ client: fakeClientReturning("not json at all") });
    await assert.rejects(judge.judge(SAMPLE_INPUT), (error: unknown) => {
      assert.ok(error instanceof ClassifiedJudgeError);
      assert.equal(error.category, "malformed_response");
      return true;
    });
  });

  test("no thrown error message ever contains the word 'apiKey' or resembles a key value, across every failure path", async () => {
    const scenarios: GeminiContentClient[] = [
      { models: { async generateContent() { throw new ApiError({ status: 401, message: "API key not valid." }); } } },
      { models: { async generateContent() { throw new ApiError({ status: 500, message: "internal error" }); } } },
      { models: { async generateContent() { throw new Error("plain network error"); } } },
    ];
    for (const client of scenarios) {
      const judge = new GeminiIntentJudge({ client, apiKey: undefined });
      await assert.rejects(judge.judge(SAMPLE_INPUT), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(/AQ\.[A-Za-z0-9_-]{15,}/.test(error.message), false, "must never contain a key-shaped token");
        return true;
      });
    }
  });
});

describe("GeminiIntentJudge — request shape sent to the client", () => {
  test("requests structured JSON output constrained to the three-verdict schema, and never leaks the API key into the request payload itself", async () => {
    let capturedParams: unknown;
    const client: GeminiContentClient = {
      models: {
        async generateContent(params) {
          capturedParams = params;
          return { text: JSON.stringify({ verdict: "consistent", rationale: "r" }) };
        },
      },
    };
    const judge = new GeminiIntentJudge({ client });
    await judge.judge(SAMPLE_INPUT);

    const params = capturedParams as { config?: { responseMimeType?: string; responseSchema?: unknown } };
    assert.equal(params.config?.responseMimeType, "application/json");
    assert.ok(params.config?.responseSchema, "expected a responseSchema constraining the model's output");
    // The API key never appears anywhere in the per-request params (it's used only
    // once, at client construction, to build the SDK's own internal auth headers).
    assert.equal(JSON.stringify(params).includes("apiKey"), false);
  });
});
