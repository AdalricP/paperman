import assert from "node:assert/strict";
import { test } from "node:test";
import {
  text_editor_state_after_key,
  text_editor_state_for,
  windowed_draft_for_display,
} from "../source/single_line_text_editor.mjs";

const fresh_editor_state = (initial_text) => text_editor_state_for({ setting_key: "interests_blurb_text", initial_text });

const after_keys = (editor_state, key_events) =>
  key_events.reduce(
    (current_outcome, [typed_character, pressed_key]) =>
      text_editor_state_after_key({ editor_state: current_outcome.editor_state, typed_character, pressed_key }),
    { kind: "editing", editor_state }
  );

test("typing inserts at the cursor including pasted chunks", () => {
  const outcome = after_keys(fresh_editor_state(""), [
    ["a", { name: "a" }],
    ["b", { name: "b" }],
    ["pasted text", {}],
  ]);
  assert.equal(outcome.editor_state.draft_text, "abpasted text");
});

test("backspace, arrows, home and end edit around the cursor", () => {
  const outcome = after_keys(fresh_editor_state("abc"), [
    [undefined, { name: "left" }],
    [undefined, { name: "backspace" }],
    ["X", { name: "x", shift: true }],
    [undefined, { name: "home" }],
    ["Y", { name: "y", shift: true }],
    [undefined, { name: "end" }],
    ["Z", { name: "z", shift: true }],
  ]);
  assert.equal(outcome.editor_state.draft_text, "YaXcZ");
});

test("control characters are ignored and ctrl+u clears the draft", () => {
  const ignored_outcome = after_keys(fresh_editor_state("abc"), [["\x03", { name: "c", ctrl: true }]]);
  assert.equal(ignored_outcome.editor_state.draft_text, "abc");
  const cleared_outcome = after_keys(fresh_editor_state("abc"), [[undefined, { name: "u", ctrl: true }]]);
  assert.equal(cleared_outcome.editor_state.draft_text, "");
});

test("enter commits and escape cancels", () => {
  const committed_outcome = after_keys(fresh_editor_state("abc"), [[undefined, { name: "return" }]]);
  assert.equal(committed_outcome.kind, "committed");
  const cancelled_outcome = after_keys(fresh_editor_state("abc"), [[undefined, { name: "escape" }]]);
  assert.equal(cancelled_outcome.kind, "cancelled");
});

test("windowing keeps the cursor visible inside long drafts", () => {
  const long_draft_text = "x".repeat(100);
  const window_at_end = windowed_draft_for_display({ draft_text: long_draft_text, cursor_position: 100, maximum_width: 20 });
  assert.ok(window_at_end.cursor_position_in_visible_text <= 19);
  const window_at_start = windowed_draft_for_display({ draft_text: long_draft_text, cursor_position: 0, maximum_width: 20 });
  assert.equal(window_at_start.cursor_position_in_visible_text, 0);
  const short_window = windowed_draft_for_display({ draft_text: "short", cursor_position: 5, maximum_width: 20 });
  assert.equal(short_window.visible_text, "short");
});
