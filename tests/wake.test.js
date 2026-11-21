const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
// Exercise the actual gate with final segments, a fake clock and no microphone.
test("wake prefix, bounded follow-up, pause, stale callbacks and manual off", () => {
  const gate = fs
    .readFileSync(require.resolve("../voice.js"), "utf8")
    .split("// Only final Vosk segments")[1]
    .split("\n")
    .slice(1)
    .join("\n");
  let now = 0,
    rec,
    sent = [],
    hiddenListener;
  const btn = { setAttribute() {} },
    hint = {},
    input = { value: "", addEventListener() {} };
  const c = {
    window: { addEventListener() {} },
    document: {
      hidden: false,
      querySelector: () => null,
      addEventListener: (k, fn) => (hiddenListener = fn),
    },
    MutationObserver: class {
      observe() {}
    },
    mode: "idle",
    utter: null,
    $: (k) => ({ wakeToggle: btn, wakeHint: hint, input })[k],
    performance: { now: () => now },
    setTimeout: () => 1,
    clearTimeout() {},
    OfflineRecognizer: class {
      start() {
        rec = this;
        this.onReady();
      }
      abort() {
        this.closed = true;
      }
    },
    deliverVoice: (t, u) => sent.push([t, u]),
  };
  vm.runInNewContext(gate, c);
  assert.equal(rec, undefined);
  btn.onclick();
  rec.onSegment("мы говорили про лиру", false);
  rec.onSegment("лирания", false);
  rec.onSegment("который час", false);
  assert.deepEqual(sent, []);
  rec.onSegment("лира", false);
  now = 8100;
  rec.onSegment("поздно", false);
  assert.deepEqual(sent, []);
  rec.onSegment("лира", false);
  rec.onSegment("как дела", true);
  assert.deepEqual(sent, [["как дела", true]]);
  assert.ok(rec.closed);
  rec.onSegment("лира слушай", false);
  assert.equal(sent.length, 1);
  btn.onclick();
  btn.onclick();
  c.mode = "talk";
  c.window.wakeStateChanged();
  assert.ok(rec.closed);
  c.mode = "idle";
  btn.onclick();
  btn.onclick();
  c.document.hidden = true;
  hiddenListener();
  assert.ok(rec.closed);
  assert.match(btn.textContent, /Включить/);
});
