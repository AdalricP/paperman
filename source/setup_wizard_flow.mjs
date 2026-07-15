import {
  category_tree_rows,
  expanded_category_group_codes_after_toggle,
  initial_expanded_category_group_codes,
} from "./category_tree_model.mjs";
import { default_settings } from "./paperman_home_files.mjs";
import { masked_api_key_text } from "./screen_row_models.mjs";
import { text_editor_state_after_key, text_editor_state_for } from "./single_line_text_editor.mjs";

export const setup_wizard_steps = [
  { step_key: "openrouter_api_key", label: "OpenRouter key", kind: "text", hint_text: "paste your key from openrouter.ai/keys · enter continues" },
  { step_key: "tracked_arxiv_category_codes", label: "Categories", kind: "category_tree", hint_text: "↑↓ move · space or enter toggles or expands · enter on → continue" },
  { step_key: "interests_blurb_text", label: "Interests", kind: "text", hint_text: "what you want to read about · guides the picks · enter to skip" },
  { step_key: "reading_intent_blurb_text", label: "Goal", kind: "text", hint_text: "why you read papers right now · enter to skip" },
];

const step_at_index = (step_index) => setup_wizard_steps[step_index];

function text_editor_for_step(step, draft_settings) {
  if (step.kind !== "text") return null;
  return text_editor_state_for({ setting_key: step.step_key, initial_text: draft_settings[step.step_key] ?? "" });
}

function category_rows_for_wizard_state(wizard_state) {
  return category_tree_rows({
    tracked_arxiv_category_codes: wizard_state.draft_settings.tracked_arxiv_category_codes,
    expanded_category_group_codes: wizard_state.expanded_category_group_codes,
  });
}

export function continue_option_cursor_position(wizard_state) {
  return category_rows_for_wizard_state(wizard_state).length;
}

export function initial_setup_wizard_state({ environment_openrouter_api_key }) {
  const draft_settings = {
    openrouter_api_key: environment_openrouter_api_key ?? "",
    tracked_arxiv_category_codes: [...default_settings.tracked_arxiv_category_codes],
    interests_blurb_text: "",
    reading_intent_blurb_text: "",
  };
  return {
    active_step_index: 0,
    draft_settings,
    text_editor_state: text_editor_for_step(step_at_index(0), draft_settings),
    expanded_category_group_codes: initial_expanded_category_group_codes(draft_settings.tracked_arxiv_category_codes),
    category_cursor_position: 0,
    validation_message: null,
  };
}

function wizard_state_at_step(wizard_state, step_index) {
  return { ...wizard_state, active_step_index: step_index, text_editor_state: text_editor_for_step(step_at_index(step_index), wizard_state.draft_settings), category_cursor_position: 0, validation_message: null };
}

function advanced_outcome(wizard_state) {
  const next_step_index = wizard_state.active_step_index + 1;
  if (next_step_index >= setup_wizard_steps.length) return { kind: "completed", draft_settings: wizard_state.draft_settings };
  return { kind: "in_progress", wizard_state: wizard_state_at_step(wizard_state, next_step_index) };
}

function retreated_outcome(wizard_state) {
  return { kind: "in_progress", wizard_state: wizard_state_at_step(wizard_state, Math.max(0, wizard_state.active_step_index - 1)) };
}

function still_editing_outcome(wizard_state, changes) {
  return { kind: "in_progress", wizard_state: { ...wizard_state, ...changes } };
}

function text_step_outcome({ wizard_state, typed_character, pressed_key }) {
  const editor_outcome = text_editor_state_after_key({ editor_state: wizard_state.text_editor_state, typed_character, pressed_key });
  if (editor_outcome.kind === "cancelled") return retreated_outcome(wizard_state);
  if (editor_outcome.kind === "editing") return still_editing_outcome(wizard_state, { text_editor_state: editor_outcome.editor_state, validation_message: null });
  const step = step_at_index(wizard_state.active_step_index);
  const committed_text = editor_outcome.editor_state.draft_text.trim();
  if (step.step_key === "openrouter_api_key" && !committed_text) {
    return still_editing_outcome(wizard_state, { validation_message: "an OpenRouter key is required — paperman picks papers with it" });
  }
  return advanced_outcome({ ...wizard_state, draft_settings: { ...wizard_state.draft_settings, [step.step_key]: committed_text } });
}

function wizard_state_after_toggling_category(wizard_state, arxiv_category_code) {
  const tracked_arxiv_category_codes = wizard_state.draft_settings.tracked_arxiv_category_codes;
  const next_tracked_arxiv_category_codes = tracked_arxiv_category_codes.includes(arxiv_category_code)
    ? tracked_arxiv_category_codes.filter((tracked_category_code) => tracked_category_code !== arxiv_category_code)
    : [...tracked_arxiv_category_codes, arxiv_category_code];
  return { ...wizard_state, validation_message: null, draft_settings: { ...wizard_state.draft_settings, tracked_arxiv_category_codes: next_tracked_arxiv_category_codes } };
}

function category_step_outcome({ wizard_state, pressed_key }) {
  const key_name = pressed_key?.name;
  const visible_category_rows = category_rows_for_wizard_state(wizard_state);
  const continuation_cursor_position = visible_category_rows.length;
  const cursor_position = wizard_state.category_cursor_position;
  if (key_name === "up" || key_name === "k") return still_editing_outcome(wizard_state, { category_cursor_position: Math.max(0, cursor_position - 1) });
  if (key_name === "down" || key_name === "j") return still_editing_outcome(wizard_state, { category_cursor_position: Math.min(continuation_cursor_position, cursor_position + 1) });
  if (key_name === "escape") return retreated_outcome(wizard_state);
  if (key_name !== "space" && key_name !== "return") return still_editing_outcome(wizard_state, {});
  if (cursor_position === continuation_cursor_position) {
    if (key_name === "space") return still_editing_outcome(wizard_state, {});
    if (wizard_state.draft_settings.tracked_arxiv_category_codes.length === 0) return still_editing_outcome(wizard_state, { validation_message: "track at least one category" });
    return advanced_outcome(wizard_state);
  }
  const cursor_row = visible_category_rows[cursor_position];
  if (cursor_row.type === "category_group") {
    return still_editing_outcome(wizard_state, {
      expanded_category_group_codes: expanded_category_group_codes_after_toggle(wizard_state.expanded_category_group_codes, cursor_row.archive_code),
      category_cursor_position: cursor_position,
    });
  }
  return still_editing_outcome(wizard_state_after_toggling_category(wizard_state, cursor_row.arxiv_category_code), {});
}

export function setup_wizard_state_after_key({ wizard_state, typed_character, pressed_key }) {
  if (step_at_index(wizard_state.active_step_index).kind === "category_tree") return category_step_outcome({ wizard_state, pressed_key });
  return text_step_outcome({ wizard_state, typed_character, pressed_key });
}

export function active_setup_wizard_step(wizard_state) {
  return step_at_index(wizard_state.active_step_index);
}

function completed_step_summary_text(step, draft_settings) {
  if (step.step_key === "openrouter_api_key") return masked_api_key_text(draft_settings.openrouter_api_key);
  if (step.step_key === "tracked_arxiv_category_codes") return `${draft_settings.tracked_arxiv_category_codes.length} tracked`;
  return draft_settings[step.step_key] || "(skipped)";
}

function active_step_child_rows(wizard_state, is_under_last_step) {
  const active_step = step_at_index(wizard_state.active_step_index);
  if (active_step.kind !== "category_tree") return [{ type: "wizard_text_input", text_editor_state: wizard_state.text_editor_state, is_under_last_step }];
  const category_option_rows = category_rows_for_wizard_state(wizard_state).map((category_row, option_index) => ({
    ...category_row,
    type: category_row.type === "category_group" ? "wizard_category_group" : "wizard_category_option",
    is_tracked: category_row.type === "category_checkbox" && wizard_state.draft_settings.tracked_arxiv_category_codes.includes(category_row.arxiv_category_code),
    is_under_cursor: wizard_state.category_cursor_position === option_index,
    is_under_last_step,
  }));
  return [...category_option_rows, { type: "wizard_continue_option", is_under_cursor: wizard_state.category_cursor_position === category_option_rows.length, is_under_last_step }];
}

export function build_setup_wizard_rows(wizard_state) {
  const rows = [{ type: "wizard_title", text: "📮 paperman · first delivery" }, { type: "spine" }];
  for (const [step_index, step] of setup_wizard_steps.entries()) {
    const is_last_step = step_index === setup_wizard_steps.length - 1;
    const step_state = step_index < wizard_state.active_step_index ? "completed" : step_index === wizard_state.active_step_index ? "active" : "pending";
    rows.push({ type: "wizard_step", label: step.label, step_state, summary_text: step_state === "completed" ? completed_step_summary_text(step, wizard_state.draft_settings) : "", is_last_step });
    if (step_state === "active") rows.push(...active_step_child_rows(wizard_state, is_last_step));
  }
  return rows;
}
