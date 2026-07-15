import assert from "node:assert/strict";
import { test } from "node:test";
import { arxiv_category_catalog } from "../source/arxiv_category_catalog.mjs";
import { default_settings } from "../source/paperman_home_files.mjs";
import {
  active_setup_wizard_step,
  build_setup_wizard_rows,
  continue_option_cursor_position,
  initial_setup_wizard_state,
  setup_wizard_state_after_key,
  setup_wizard_steps,
} from "../source/setup_wizard_flow.mjs";

const fresh_wizard_state = (environment_openrouter_api_key = undefined) =>
  initial_setup_wizard_state({ environment_openrouter_api_key, environment_fireworks_api_key: undefined });

const after_keys = (wizard_state, key_events) =>
  key_events.reduce(
    (current_outcome, [typed_character, pressed_key]) => {
      assert.equal(current_outcome.kind, "in_progress");
      return setup_wizard_state_after_key({ wizard_state: current_outcome.wizard_state, typed_character, pressed_key });
    },
    { kind: "in_progress", wizard_state }
  );

const typed_key_events = (text) => [...text].map((typed_character) => [typed_character, { name: typed_character }]);
const enter_key_event = [undefined, { name: "return" }];
const space_key_event = [" ", { name: "space" }];
const down_key_event = [undefined, { name: "down" }];
const escape_key_event = [undefined, { name: "escape" }];

test("wizard starts on the openrouter key step, prefilled from the environment", () => {
  const wizard_state = fresh_wizard_state("or_from_env");
  assert.equal(active_setup_wizard_step(wizard_state).step_key, "openrouter_api_key");
  assert.equal(wizard_state.text_editor_state.draft_text, "or_from_env");
});

test("an empty openrouter key is blocked with a validation message", () => {
  const outcome = after_keys(fresh_wizard_state(), [enter_key_event]);
  assert.equal(outcome.kind, "in_progress");
  assert.equal(outcome.wizard_state.active_step_index, 0);
  assert.match(outcome.wizard_state.validation_message, /OpenRouter key is required/);
});

test("the fireworks key step is optional and may be skipped with enter", () => {
  const outcome = after_keys(fresh_wizard_state("or_env"), [enter_key_event, enter_key_event]);
  assert.equal(outcome.wizard_state.draft_settings.fireworks_api_key, "");
  assert.equal(active_setup_wizard_step(outcome.wizard_state).step_key, "tracked_arxiv_category_codes");
});

const wizard_state_on_categories_step = () =>
  after_keys(fresh_wizard_state("or_env"), [enter_key_event, enter_key_event]).wizard_state;

test("arrows move the category cursor and space or enter toggles a checkbox", () => {
  const first_catalog_code = arxiv_category_catalog[0].arxiv_category_code;
  const starts_tracked = default_settings.tracked_arxiv_category_codes.includes(first_catalog_code);
  const toggled_outcome = after_keys(wizard_state_on_categories_step(), [space_key_event]);
  assert.equal(
    toggled_outcome.wizard_state.draft_settings.tracked_arxiv_category_codes.includes(first_catalog_code),
    !starts_tracked
  );
  const enter_toggled_outcome = after_keys(wizard_state_on_categories_step(), [down_key_event, enter_key_event]);
  assert.equal(enter_toggled_outcome.wizard_state.category_cursor_position, 1);
  assert.equal(active_setup_wizard_step(enter_toggled_outcome.wizard_state).step_key, "tracked_arxiv_category_codes");
});

test("enter on the continue option advances only with at least one tracked category", () => {
  const untrack_all_key_events = default_settings.tracked_arxiv_category_codes.flatMap((tracked_code) => {
    const catalog_position = arxiv_category_catalog.findIndex((entry) => entry.arxiv_category_code === tracked_code);
    return [
      ...Array.from({ length: catalog_position }, () => down_key_event),
      space_key_event,
      ...Array.from({ length: catalog_position }, () => [undefined, { name: "up" }]),
    ];
  });
  const to_continue_key_events = Array.from({ length: continue_option_cursor_position }, () => down_key_event);

  const blocked_outcome = after_keys(wizard_state_on_categories_step(), [
    ...untrack_all_key_events,
    ...to_continue_key_events,
    enter_key_event,
  ]);
  assert.match(blocked_outcome.wizard_state.validation_message, /at least one category/);

  const advanced_outcome = after_keys(wizard_state_on_categories_step(), [...to_continue_key_events, enter_key_event]);
  assert.equal(active_setup_wizard_step(advanced_outcome.wizard_state).step_key, "interests_blurb_text");
});

test("escape retreats to the previous step", () => {
  const outcome = after_keys(wizard_state_on_categories_step(), [escape_key_event]);
  assert.equal(outcome.wizard_state.active_step_index, 1);
});

test("completing every step returns the draft settings with the model defaulted", () => {
  const to_continue_key_events = Array.from({ length: continue_option_cursor_position }, () => down_key_event);
  const outcome = after_keys(fresh_wizard_state("or_env"), [
    enter_key_event,
    ...typed_key_events("fw_abc"),
    enter_key_event,
    ...to_continue_key_events,
    enter_key_event,
    ...typed_key_events("robots"),
    enter_key_event,
    ...typed_key_events("thesis"),
    enter_key_event,
    [undefined, { name: "u", ctrl: true }],
    enter_key_event,
  ]);
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.draft_settings.openrouter_api_key, "or_env");
  assert.equal(outcome.draft_settings.fireworks_api_key, "fw_abc");
  assert.equal(outcome.draft_settings.interests_blurb_text, "robots");
  assert.equal(outcome.draft_settings.reading_intent_blurb_text, "thesis");
  assert.equal(outcome.draft_settings.openrouter_chat_model_id, default_settings.openrouter_chat_model_id);
});

test("rows show step states, an expanded active step, and summaries for completed steps", () => {
  const rows_at_start = build_setup_wizard_rows(fresh_wizard_state("or_env"));
  assert.equal(rows_at_start[0].type, "wizard_title");
  const step_rows = rows_at_start.filter((row) => row.type === "wizard_step");
  assert.equal(step_rows.length, setup_wizard_steps.length);
  assert.equal(step_rows[0].step_state, "active");
  assert.equal(step_rows.at(-1).step_state, "pending");
  assert.equal(rows_at_start.filter((row) => row.type === "wizard_text_input").length, 1);

  const rows_on_categories = build_setup_wizard_rows(wizard_state_on_categories_step());
  const category_option_rows = rows_on_categories.filter((row) => row.type === "wizard_category_option");
  assert.equal(category_option_rows.length, arxiv_category_catalog.length);
  assert.equal(category_option_rows[0].is_under_cursor, true);
  assert.equal(rows_on_categories.filter((row) => row.type === "wizard_continue_option").length, 1);
  const completed_step_rows = rows_on_categories.filter((row) => row.type === "wizard_step" && row.step_state === "completed");
  assert.equal(completed_step_rows[0].summary_text, "or_env…");
  assert.equal(completed_step_rows[1].summary_text, "(skipped)");
});
