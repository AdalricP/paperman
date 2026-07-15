import assert from "node:assert/strict";
import { test } from "node:test";
import { active_setup_wizard_step, build_setup_wizard_rows, continue_option_cursor_position, initial_setup_wizard_state, setup_wizard_state_after_key, setup_wizard_steps } from "../source/setup_wizard_flow.mjs";

const fresh_wizard_state = (environment_openrouter_api_key = undefined) => initial_setup_wizard_state({ environment_openrouter_api_key });
const enter_key_event = [undefined, { name: "return" }];
const space_key_event = [" ", { name: "space" }];
const down_key_event = [undefined, { name: "down" }];
const escape_key_event = [undefined, { name: "escape" }];
const typed_key_events = (text) => [...text].map((typed_character) => [typed_character, { name: typed_character }]);

const after_keys = (wizard_state, key_events) => key_events.reduce(
  (current_outcome, [typed_character, pressed_key]) => {
    assert.equal(current_outcome.kind, "in_progress");
    return setup_wizard_state_after_key({ wizard_state: current_outcome.wizard_state, typed_character, pressed_key });
  },
  { kind: "in_progress", wizard_state }
);

const wizard_state_on_categories_step = () => after_keys(fresh_wizard_state("or_env"), [enter_key_event]).wizard_state;
const category_rows_on = (wizard_state) => build_setup_wizard_rows(wizard_state).filter((row) => row.type === "wizard_category_option" || row.type === "wizard_category_group");

test("wizard starts with the required OpenRouter key and only four steps", () => {
  const wizard_state = fresh_wizard_state("or_from_env");
  assert.equal(active_setup_wizard_step(wizard_state).step_key, "openrouter_api_key");
  assert.equal(wizard_state.text_editor_state.draft_text, "or_from_env");
  assert.deepEqual(setup_wizard_steps.map((step) => step.step_key), ["openrouter_api_key", "tracked_arxiv_category_codes", "interests_blurb_text", "reading_intent_blurb_text"]);
});

test("an empty OpenRouter key is blocked", () => {
  const outcome = after_keys(fresh_wizard_state(), [enter_key_event]);
  assert.match(outcome.wizard_state.validation_message, /OpenRouter key is required/);
});

test("category groups expand and leaves toggle", () => {
  const categories_wizard_state = wizard_state_on_categories_step();
  const initial_category_rows = category_rows_on(categories_wizard_state);
  assert.equal(initial_category_rows[0].type, "wizard_category_group");
  const collapsed_outcome = after_keys(categories_wizard_state, [space_key_event]);
  const collapsed_category_rows = category_rows_on(collapsed_outcome.wizard_state);
  assert.ok(collapsed_category_rows.length < initial_category_rows.length);
  const reopened_outcome = after_keys(collapsed_outcome.wizard_state, [space_key_event]);
  const reopened_category_rows = category_rows_on(reopened_outcome.wizard_state);
  assert.ok(reopened_category_rows.length > collapsed_category_rows.length);
  const first_leaf_row = reopened_category_rows[1];
  const toggled_outcome = after_keys(reopened_outcome.wizard_state, [down_key_event, space_key_event]);
  assert.equal(toggled_outcome.wizard_state.draft_settings.tracked_arxiv_category_codes.includes(first_leaf_row.arxiv_category_code), true);
});

test("continue requires a tracked category and escape returns to the key step", () => {
  const categories_wizard_state = wizard_state_on_categories_step();
  const state_without_categories = { ...categories_wizard_state, draft_settings: { ...categories_wizard_state.draft_settings, tracked_arxiv_category_codes: [] } };
  const continuation_key_events = Array.from({ length: continue_option_cursor_position(state_without_categories) }, () => down_key_event);
  const blocked_outcome = after_keys(state_without_categories, [...continuation_key_events, enter_key_event]);
  assert.match(blocked_outcome.wizard_state.validation_message, /at least one category/);
  const retreated_outcome = after_keys(categories_wizard_state, [escape_key_event]);
  assert.equal(retreated_outcome.wizard_state.active_step_index, 0);
});

test("completing the wizard returns API key, categories, interests, and goal", () => {
  const categories_wizard_state = wizard_state_on_categories_step();
  const continuation_key_events = Array.from({ length: continue_option_cursor_position(categories_wizard_state) }, () => down_key_event);
  const outcome = after_keys(fresh_wizard_state("or_env"), [
    enter_key_event,
    ...continuation_key_events,
    enter_key_event,
    ...typed_key_events("robots"),
    enter_key_event,
    ...typed_key_events("thesis"),
    enter_key_event,
  ]);
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.draft_settings.openrouter_api_key, "or_env");
  assert.equal(outcome.draft_settings.interests_blurb_text, "robots");
  assert.equal(outcome.draft_settings.reading_intent_blurb_text, "thesis");
});

test("rows include the active tree and completed summaries", () => {
  const start_rows = build_setup_wizard_rows(fresh_wizard_state("or_env"));
  assert.equal(start_rows.filter((row) => row.type === "wizard_step").length, 4);
  const category_rows = build_setup_wizard_rows(wizard_state_on_categories_step());
  assert.ok(category_rows.some((row) => row.type === "wizard_category_group"));
  assert.equal(category_rows.filter((row) => row.type === "wizard_continue_option").length, 1);
  assert.equal(category_rows.find((row) => row.type === "wizard_step" && row.step_state === "completed").summary_text, "or_env…");
});
