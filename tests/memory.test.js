const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
test("legacy profile converts to plain facts without changing source data or importing reminders", () => {
  let old = {
    "lyra:memory:v1": {
      names: { self: "Алина" },
      people: [
        {
          role: "friend",
          name: "Антон",
          tag: "из школы",
          facts: { pets: "кот Барсик" },
        },
      ],
    },
    "lyra:notebook:1": {
      city: "Москва",
      rows: [
        { text: "Люблю джаз", at: null },
        { text: "Напоминание", at: 100 },
      ],
    },
  };
  let original = JSON.stringify(old),
    code = fs
      .readFileSync(require.resolve("../memory.js"), "utf8")
      .split("// UI bindings")[0];
  let c = {
    load: (k, d) => old[k] ?? d,
    crypto: require("node:crypto").webcrypto,
    localStorage: { getItem: () => null, setItem() {} },
    prefs: { engine: "ollama" },
  };
  vm.runInNewContext(code, c);
  const facts = vm.runInNewContext("Facts.legacy()", c);
  assert.ok(facts.includes("Антон (из школы) — питомцы: кот Барсик."));
  assert.ok(facts.includes("Люблю джаз"));
  assert.ok(!facts.includes("Напоминание"));
  assert.equal(JSON.stringify(old), original);
});
