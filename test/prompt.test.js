"use strict";
const test = require("node:test");
const assert = require("node:assert");
const prompt = require("../lib/prompt");
const { fakeTty, drive, KEY, PASSWORD } = require("./helpers");

const choices = [{ label: "Yes", value: "yes" }, { label: "Cancel", value: "cancel", cancel: true }];

test("select: Enter picks the highlighted choice, arrows move", async () => {
  const t = fakeTty();
  const p = prompt.select({ message: "Sign in?", choices, input: t.input, output: t.output });
  await drive(t, [{ waitFor: "Cancel", send: KEY.enter }]);
  assert.strictEqual(await p, "yes");
  const t2 = fakeTty();
  const p2 = prompt.select({ message: "Sign in?", choices, input: t2.input, output: t2.output });
  await drive(t2, [{ waitFor: "Cancel", send: [KEY.down, KEY.enter] }]);
  assert.strictEqual(await p2, "cancel");
});

test("select: Ctrl+C and q choose Cancel", async () => {
  for (const key of [KEY.ctrlC, "q"]) {
    const t = fakeTty();
    const p = prompt.select({ message: "Sign in?", choices, input: t.input, output: t.output });
    await drive(t, [{ waitFor: "Cancel", send: key }]);
    assert.strictEqual(await p, "cancel");
  }
});

test("password: nothing typed is echoed, backspace works, raw mode is restored", async () => {
  const t = fakeTty();
  const p = prompt.password({ message: "Password:", input: t.input, output: t.output });
  await drive(t, [{ waitFor: "Password:", send: [PASSWORD + "x", "\x7f", KEY.enter] }]);
  assert.strictEqual(await p, PASSWORD);
  assert.ok(!t.text().includes(PASSWORD) && !t.text().includes("*"));
  assert.strictEqual(t.input.isRaw, false);
});

test("password: Ctrl+C cancels without returning anything", async () => {
  const t = fakeTty();
  const p = prompt.password({ message: "Password:", input: t.input, output: t.output });
  const rejected = assert.rejects(p, prompt.Cancelled);
  await drive(t, [{ waitFor: "Password:", send: ["abc", KEY.ctrlC] }]);
  await rejected;
});

test("prompts refuse a non-interactive input", async () => {
  const { PassThrough } = require("stream");
  await assert.rejects(prompt.text({ message: "x", input: new PassThrough(), output: new PassThrough() }), prompt.NotInteractive);
});
