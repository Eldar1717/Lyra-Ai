const test = require("node:test"),
  assert = require("node:assert/strict"),
  L = require("../modules/vakhta/logic.js");

const resident = (name = "Иван Петров", flat = "42") => ({
  status: "resident",
  match: { name, flat },
  distance: 0.31,
});
const unknown = () => ({ status: "unknown", match: null, distance: 0.78 });

function feed(machine, frames, obs, step = 700) {
  let out = [];
  for (let i = 0; i < frames; i++) {
    const now = (obs.start || 0) + i * step;
    out = machine.tick({ now, faces: 1, ident: obs.ident });
  }
  return out;
}
const said = (actions) => actions.filter((a) => a.type === "say").map((a) => a.text);

test("свой жилец слышит «проходите», дверь открывается один раз", () => {
  const m = L.create();
  let actions = feed(m, 3, { ident: resident() });
  assert.deepEqual(said(actions), ["Здравствуйте, Иван Петров! Проходите, пожалуйста."]);
  assert.equal(actions.filter((a) => a.type === "unlock").length, 1);
  assert.equal(actions.filter((a) => a.type === "log")[0].decision, "passed");
  actions = feed(m, 20, { ident: resident(), start: 2100 });
  assert.equal(said(actions).length, 0);
  assert.equal(actions.filter((a) => a.type === "unlock").length, 0);
});

test("свой жилец узнаётся снова после ухода и паузы", () => {
  const m = L.create();
  feed(m, 3, { ident: resident() });
  for (let i = 0; i < 6; i++) m.tick({ now: 3000 + i * 700, faces: 0, ident: null });
  const actions = feed(m, 3, { ident: resident(), start: 60000 });
  assert.equal(said(actions)[0], "Здравствуйте, Иван Петров! Проходите, пожалуйста.");
});

test("чужой: сначала «зачем пришли», потом квартира → ждём жильца", () => {
  const m = L.create();
  const actions = feed(m, 3, { ident: unknown() });
  assert.deepEqual(said(actions), ["Здравствуйте! Вы не из нашего дома. Зачем пришли?"]);
  assert.equal(actions.some((a) => a.type === "unlock"), false);

  const reply = m.answer("Я к Ивановым в квартиру 42", 4000);
  assert.match(said(reply)[0], /^Понятно, вы в квартиру 42\./);
  assert.equal(reply.some((a) => a.type === "notify" && a.flat === "42"), true);
  assert.equal(m.snapshot().state, "pending");
  assert.equal(reply.some((a) => a.type === "unlock"), false);
});

test("курьер называет квартиру — проходит сразу, жильцам всё равно сообщаем", () => {
  const m = L.create();
  feed(m, 3, { ident: unknown() });
  const reply = m.answer("Я курьер, доставка в квартиру 118б", 4000);
  assert.equal(said(reply)[0], "Курьер в квартиру 118б. Проходите, пожалуйста.");
  assert.equal(reply.some((a) => a.type === "unlock"), true);
  assert.equal(m.snapshot().state, "cooldown");
});

test("курьеров можно тоже держать до подтверждения жильца", () => {
  const m = L.create({ config: { passDelivery: false } });
  feed(m, 3, { ident: unknown() });
  const reply = m.answer("курьер, в сто восемнадцать б", 4000);
  assert.match(said(reply)[0], /^Понятно, вы в квартиру 118б\./);
  assert.equal(reply.some((a) => a.type === "unlock"), false);
  assert.equal(m.snapshot().state, "pending");
});

test("числа словами, порядковые и буква корпуса", () => {
  const cases = [
    ["я в сорок два", "42"],
    ["квартира сто двадцать три", "123"],
    ["в сто восемнадцать б", "118б"],
    ["квартира двести тридцать четвертая", "234"],
    ["сорок второй", "42"],
    ["в двенадцатую", "12"],
    ["сто восемнадцать бэ", "118б"],
    ["квартира 118 в", "118в"],
    ["девяносто девятая", "99"],
    ["я в 42 и всё", "42"],
  ];
  for (const [text, flat] of cases) assert.equal(L.parseAnswer(text).flat, flat, text);
});

test("гость называет только фамилию жильца — вахтёр находит квартиру по реестру", () => {
  const m = L.create({ people: [{ name: "Пётр Иванов", flat: "17", role: "resident" }] });
  feed(m, 3, { ident: unknown() });
  const reply = m.answer("я к Ивановым", 4000);
  assert.match(said(reply)[0], /квартиру 17/);
  assert.equal(reply.some((a) => a.type === "notify" && a.flat === "17"), true);
});

test("режим «пропускать гостей»: назвал квартиру — дверь открывается", () => {
  const m = L.create({ config: { passGuests: true } });
  feed(m, 3, { ident: unknown() });
  const reply = m.answer("я курьер, в 42", 4000);
  assert.deepEqual(said(reply), ["Курьер в квартиру 42. Проходите, пожалуйста."]);
  assert.equal(reply.some((a) => a.type === "unlock"), true);
  assert.equal(m.snapshot().state, "cooldown");
});

test("курьер без квартиры: переспрашивают именно квартиру", () => {
  const m = L.create();
  feed(m, 3, { ident: unknown() });
  const reply = m.answer("доставка, курьер", 4000);
  assert.deepEqual(said(reply), ["Курьер, здравствуйте! В какую квартиру доставка?"]);
  assert.equal(m.snapshot().state, "intern");
});

test("чужой грубит → «не пропущу», потом пауза", () => {
  const m = L.create();
  feed(m, 3, { ident: unknown() });
  const reply = m.answer("Открой, я тут живу, не твоё дело", 4000);
  assert.match(said(reply)[0], /Я не могу вас пропустить без подтверждения жильца/);
  assert.equal(m.snapshot().state, "cooldown");
  assert.equal(reply.some((a) => a.type === "alert"), true);
  const again = feed(m, 5, { ident: unknown(), start: 5000 });
  assert.equal(said(again).length, 0);
});

test("чужой молчит: два переспроса, затем отказ", () => {
  const m = L.create();
  feed(m, 3, { ident: unknown() }); // спрашивает в 1400, дедлайн 21400
  let out = m.tick({ now: 22000, faces: 1, ident: unknown() });
  assert.deepEqual(said(out), [L.PHRASES.retry]);
  out = m.tick({ now: 43000, faces: 1, ident: unknown() });
  assert.deepEqual(said(out), [L.PHRASES.retry]);
  out = m.tick({ now: 64000, faces: 1, ident: unknown() });
  assert.deepEqual(said(out), ["Вы не ответили, поэтому я вас не пропускаю. Уходите, пожалуйста."]);
  assert.equal(m.snapshot().state, "cooldown");
});

test("неоднозначное совпадение не пускает, а уточняет", () => {
  const m = L.create();
  const actions = feed(m, 3, { ident: { status: "ambiguous", match: null, distance: 0.44 } });
  assert.match(said(actions)[0], /Назовите, пожалуйста, номер квартиры/);
  assert.equal(actions.some((a) => a.type === "unlock"), false);
});

test("гость из списка жданных и нежелательный посетитель", () => {
  const guest = L.create();
  const g = feed(guest, 3, { ident: { status: "guest", match: { name: "Анна Смирнова", flat: "8" } } });
  assert.deepEqual(said(g), ["Здравствуйте, Анна Смирнова. Вас ждут в квартире 8. Проходите, пожалуйста."]);
  assert.equal(g.some((a) => a.type === "unlock"), false);

  const denied = L.create();
  const d = feed(denied, 3, { ident: { status: "denied", match: { name: "Пётр", flat: "" } } });
  assert.deepEqual(said(d), ["Вы в списке нежелательных посетителей. Уходите, пожалуйста."]);
  assert.equal(d.some((a) => a.type === "unlock"), false);
  assert.equal(d.some((a) => a.type === "alert"), true);
});

test("одно лицо вместо трёх кадров не запускает сценарий", () => {
  const m = L.create();
  assert.equal(said(m.tick({ now: 0, faces: 1, ident: resident() })).length, 0);
  assert.equal(said(m.tick({ now: 700, faces: 0, ident: null })).length, 0);
  assert.equal(said(m.tick({ now: 1400, faces: 1, ident: resident() })).length, 0);
});

test("числа словами: Vosk пишет «сорок два», а не 42", () => {
  assert.equal(L.wordsToNumber("я в сорок два"), 42);
  assert.equal(L.wordsToNumber("квартира сто двадцать три"), 123);
  assert.equal(L.wordsToNumber("в пятнадцать"), 15);
  assert.equal(L.wordsToNumber("курьер"), null);
  assert.equal(L.parseAnswer("я в сорок два").flat, "42");
  assert.equal(L.parseAnswer("квартира сто двадцать три").flat, "123");
});

test("разбор ответа: квартира, имя, доставка, отказ, падежи фамилий", () => {
  assert.equal(L.parseAnswer("я к 42").flat, "42");
  assert.equal(L.parseAnswer("в квартиру 118б").flat, "118б");
  assert.equal(L.parseAnswer("к Смирнову").name, "Смирнову");
  assert.equal(L.parseAnswer("доставка в 15").delivery, true);
  assert.equal(L.parseAnswer("открывай, я тут живу").refusal, true);
  assert.equal(L.parseAnswer("мне к Смирнову в 42").refusal, false);
  assert.equal(L.parseAnswer("").empty, true);
  const people = [{ name: "Анна Смирнова", flat: "8" }];
  assert.equal(L.matchPerson("Смирновой", people).flat, "8");
  assert.equal(L.matchPerson("Ивановым", people), null);
});

test("шаблоны фраз подставляются без мусора", () => {
  assert.equal(L.fill(L.PHRASES.resident, { name: "Анна" }), "Здравствуйте, Анна! Проходите, пожалуйста.");
  assert.equal(L.fill("Проходите, {name}.", { name: "" }), "Проходите.");
  assert.equal(L.shortName("Иван Петрович Сидоров"), "Иван Петрович");
  assert.equal(L.statusOf(null), "unknown");
  assert.equal(L.statusOf({ status: "vahta" }), "unknown");
});

test("реестр жильцов можно обновить на ходу", () => {
  const m = L.create();
  feed(m, 3, { ident: unknown() });
  m.setPeople([{ name: "Пётр Иванов", flat: "17" }]);
  const reply = m.answer("к Иванову", 4000);
  assert.match(said(reply)[0], /квартиру 17/);
  assert.equal(m.snapshot().people, 1);
});
