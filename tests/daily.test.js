const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  D = require("../daily.js");
const now = new Date(2026, 10, 21, 10, 30),
  mem = () => {
    const m = new Map();
    return { setItem: (k, v) => m.set(k, v), getItem: (k) => m.get(k) };
  };
test("spoken evening time, reload, missed reminder and durable acknowledgement", () => {
  const disk = mem(),
    book = D.create(disk, () => now);
  assert.match(
    book.handle("Запомни, что сегодня нужно попить воды в девять часов вечера"),
    /21:00/,
  );
  const a = book.view().rows[0];
  assert.equal(a.text, "попить воды");
  assert.equal(a.at, +new Date(2026, 10, 21, 21));
  assert.equal(book.due().length, 0);
  const later = () => new Date(2026, 10, 22);
  const next = D.create(disk, later);
  assert.equal(next.due().length, 1);
  next.ack(a.id);
  assert.equal(D.create(disk, later).due().length, 0);
});
test("past, unsupported recurrence and bad dates are not scheduled", () => {
  const a = D.create(mem(), () => now);
  for (const s of [
    "Напомни сегодня в 09:00 пить воду",
    "Напомни 31.02.2027 в 12:00 проверить почту",
    "Напомни каждый день в девять пить воду",
    "Напомни завтра в 26:00 проверить чай",
  ])
    a.handle(s);
  assert.equal(a.view().rows.length, 0);
});
test("notes, city, work, clock, deletion and paused memory", () => {
  const a = D.create(mem(), () => now);
  a.handle("запомни, что я живу в Москве");
  a.handle("запомни: моё место работы — библиотека");
  assert.equal(a.view().city, "Москва");
  assert.equal(a.view().work, "библиотека");
  a.handle("запомни что ключ в синей коробке");
  assert.match(a.handle("мои заметки"), /ключ/);
  assert.equal(a.handle("запомни что новый ключ у соседа", false), null);
  assert.match(a.handle("Какой сегодня месяц?", false), /ноября/);
  a.remove(a.view().rows[0].id);
  assert.equal(a.handle("мои заметки"), "Список пуст.");
});
test("explicit date and relative time", () => {
  assert.equal(D.timeOf("через 15 минут проверить чай", now).at, +now + 900000);
  assert.equal(
    D.timeOf("25.12.2026 в 18:30 купить хлеб", now).at,
    +new Date(2026, 11, 25, 18, 30),
  );
});
