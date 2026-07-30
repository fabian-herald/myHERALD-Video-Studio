import assert from "node:assert/strict";
import {test} from "node:test";
import {
  NO_PROVIDER_MESSAGE,
  SEARCH_PREFERENCE,
  configuredSearchProviders,
  defaultSearchProvider,
  listSearchProviders,
  registerSearchProvider,
  searchProviderFor,
  type SearchProvider,
} from "./provider.ts";
import "./brave.ts";
import "./exa.ts";

/** Set env for the body of a test and put it back, whatever happened. */
function withEnv(values: Record<string, string | undefined>, body: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NO_KEYS = {EXA_API_KEY: undefined, BRAVE_SEARCH_API_KEY: undefined};

test("both adapters register themselves by importing them", () => {
  const ids = listSearchProviders().map((provider) => provider.id).sort();
  assert.deepEqual(ids, ["brave", "exa"]);
});

test("an unknown id throws an error that lists what is registered", () => {
  // The message is the discoverability mechanism, exactly as in composer.ts and
  // tts/provider.ts — a bare "unknown provider" leaves the caller guessing at spelling.
  assert.throws(() => searchProviderFor("goggle"), (error: Error) => {
    assert.match(error.message, /Unknown search provider "goggle"/);
    assert.match(error.message, /brave/);
    assert.match(error.message, /exa/);
    return true;
  });
});

test("the default follows the preference order and skips an unconfigured provider", () => {
  withEnv({...NO_KEYS, EXA_API_KEY: "x", BRAVE_SEARCH_API_KEY: "y"}, () => {
    assert.equal(defaultSearchProvider().id, SEARCH_PREFERENCE[0]);
  });

  // Only Brave configured: preference is a preference, not a requirement. Falling through
  // to the second choice is the whole point of having an order rather than a default.
  withEnv({...NO_KEYS, BRAVE_SEARCH_API_KEY: "y"}, () => {
    assert.equal(defaultSearchProvider().id, "brave");
    assert.deepEqual(configuredSearchProviders().map((provider) => provider.id), ["brave"]);
  });

  withEnv({...NO_KEYS, EXA_API_KEY: "x"}, () => {
    assert.equal(defaultSearchProvider().id, "exa");
  });
});

test("a whitespace-only key does not count as configured", () => {
  // `.env.local` files acquire `EXA_API_KEY=` lines. Treating that as configured produces a
  // 401 from the vendor instead of the message that tells the owner what to add.
  withEnv({...NO_KEYS, EXA_API_KEY: "   "}, () => {
    assert.deepEqual(configuredSearchProviders(), []);
  });
});

test("with neither key set the error names both variables and both sites", () => {
  // Load-bearing: this string is the only place the owner learns what to add, so it has to
  // carry the variable names AND enough about each provider to choose between them.
  withEnv(NO_KEYS, () => {
    assert.throws(() => defaultSearchProvider(), (error: Error) => {
      for (const expected of ["EXA_API_KEY", "BRAVE_SEARCH_API_KEY", "exa.ai", "brave.com"]) {
        assert.ok(error.message.includes(expected), `message is missing ${expected}`);
      }
      return true;
    });
  });
  assert.equal(NO_PROVIDER_MESSAGE.includes("URLs you name yourself"), true,
    "must say what still works without a key, or a missing key reads as a broken studio");
});

test("no provider object exposes a field holding a key's value", () => {
  // A provider is handed to `read_context`'s payload and its id reaches a thread transcript.
  // `configured()` returns a boolean for exactly this reason; a `key` or `apiKey` field
  // would put a secret one JSON.stringify away from a saved conversation.
  withEnv({EXA_API_KEY: "exa-secret-value", BRAVE_SEARCH_API_KEY: "brave-secret-value"}, () => {
    for (const provider of listSearchProviders()) {
      const serialised = JSON.stringify(provider);
      assert.ok(!serialised.includes("secret-value"), `${provider.id} serialises a key`);
      for (const field of Object.keys(provider) as (keyof SearchProvider)[]) {
        assert.notEqual(provider[field], process.env.EXA_API_KEY, `${provider.id}.${field} holds the key`);
        assert.notEqual(provider[field], process.env.BRAVE_SEARCH_API_KEY, `${provider.id}.${field} holds the key`);
      }
      assert.equal(provider.configured(), true);
    }
  });
});

test("only Exa claims to index page text", () => {
  // The flag is what stops a caller treating a Brave snippet as a page excerpt. If Brave
  // ever reports true, `excerpt` becomes a field nobody can judge the weight of.
  assert.equal(searchProviderFor("exa").indexesPageText, true);
  assert.equal(searchProviderFor("brave").indexesPageText, false);
});

test("a provider registered twice replaces rather than duplicates", () => {
  // The registry is a Map keyed by id, so a module imported twice under different
  // specifiers cannot produce two entries and a nondeterministic default.
  const before = listSearchProviders().length;
  const fake: SearchProvider = {
    id: "exa", label: "replacement", keyEnvVar: "EXA_API_KEY", indexesPageText: true,
    configured: () => false,
    search: async () => ({hits: [], costUsd: 0}),
  };
  const original = searchProviderFor("exa");
  try {
    registerSearchProvider(fake);
    assert.equal(listSearchProviders().length, before);
    assert.equal(searchProviderFor("exa").label, "replacement");
  } finally {
    registerSearchProvider(original);
  }
});
