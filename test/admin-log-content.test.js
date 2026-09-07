import assert from "node:assert/strict";
import test from "node:test";
import { fireEvent, renderWorkspace, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";

setupWorkspaceFormTests();

const contentPaths = ["observability.logs.messageContentMode", "observability.logAnalytics.contentMode"];
const confirmation = "Full mode records redacted prompts and model output. Secrets and binary payloads remain omitted. Continue?";

test("log content control preserves its placement, default and wire option values", () => {
  const view = renderWorkspace({}, "workspace-logging");
  const select = view.fields.getByLabelText("Message Content Mode");
  assert.equal(select.value, "summary");
  assert.deepEqual([...select.options].map(option => [option.value, option.textContent]), [
    ["summary", "Partial"], ["full", "Full"]
  ]);
  assert.equal(select.closest("label").previousElementSibling.textContent, "Log Buffer Max Bytes");
  assert.equal(select.closest("label").nextElementSibling.textContent, "Max Payload Log Bytes");
  assert.deepEqual(view.changes, []);
});

test("canceling full content confirmation preserves both stored modes", context => {
  const config = { observability: { logs: { messageContentMode: "summary" }, logAnalytics: { contentMode: "full" } } };
  const original = structuredClone(config);
  const confirm = context.mock.method(window, "confirm", () => false);
  const view = renderWorkspace(config, "workspace-logging");
  const select = view.fields.getByLabelText("Message Content Mode");
  fireEvent.change(select, { target: { value: "full" } });
  assert.equal(confirm.mock.callCount(), 1);
  assert.deepEqual(confirm.mock.calls[0].arguments, [confirmation]);
  assert.equal(select.value, "summary");
  assert.deepEqual(view.changes, []);
  assert.deepEqual(config, original);
});

test("confirmed full content updates both paths even when the remote sink is disabled", context => {
  const confirm = context.mock.method(window, "confirm", () => true);
  const config = { observability: { logs: { messageContentMode: "summary" }, logAnalytics: { enabled: false, contentMode: "summary" } } };
  const original = structuredClone(config);
  const view = renderWorkspace(config, "workspace-logging");
  const select = view.fields.getByLabelText("Message Content Mode");
  fireEvent.change(select, { target: { value: "full" } });
  assert.equal(confirm.mock.callCount(), 1);
  assert.deepEqual(confirm.mock.calls[0].arguments, [confirmation]);
  assert.deepEqual(view.changes, contentPaths.map(path => [path, "full"]));
  assert.equal(select.value, "full");
  assert.deepEqual(config, original);
});

test("leaving full content needs no confirmation and synchronizes both modes", context => {
  const confirm = context.mock.method(window, "confirm", () => { throw new Error("Unexpected confirmation"); });
  const view = renderWorkspace({ observability: { logs: { messageContentMode: "full" }, logAnalytics: { contentMode: "full" } } }, "workspace-logging");
  const select = view.fields.getByLabelText("Message Content Mode");
  fireEvent.change(select, { target: { value: "summary" } });
  assert.equal(confirm.mock.callCount(), 0);
  assert.deepEqual(view.changes, contentPaths.map(path => [path, "summary"]));
  assert.equal(select.value, "summary");
});

test("already enabled full content does not reconfirm, but reentry after summary does", context => {
  const confirm = context.mock.method(window, "confirm", () => true);
  const view = renderWorkspace({ observability: { logs: { messageContentMode: "full" } } }, "workspace-logging");
  const select = view.fields.getByLabelText("Message Content Mode");
  fireEvent.change(select, { target: { value: "full" } });
  assert.equal(confirm.mock.callCount(), 0);
  assert.deepEqual(view.changes, contentPaths.map(path => [path, "full"]));
  fireEvent.change(select, { target: { value: "summary" } });
  fireEvent.change(select, { target: { value: "full" } });
  assert.equal(confirm.mock.callCount(), 1);
  assert.deepEqual(view.changes.slice(-2), contentPaths.map(path => [path, "full"]));
});