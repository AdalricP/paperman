import { arxiv_category_catalog, display_name_for_arxiv_category_code } from "./arxiv_category_catalog.mjs";
import { default_settings } from "./paperman_home_files.mjs";
import { masked_api_key_text } from "./screen_row_models.mjs";
import { text_editor_state_after_key, text_editor_state_for } from "./single_line_text_editor.mjs";

export const setup_wizard_steps = [
  {
    step_key: "openrouter_api_key",
    label: "OpenRouter key",
    kind: "text",
    hint_text: "paste your key from openrouter.ai/keys · enter continues",
  },
  {
    step_key: "fireworks_api_key",
    label: "Fireworks key",
    kind: "text",
    hint_text: "powers the embedding recommender · enter to skip",
  },
  {
    step_key: "tracked_arxiv_category_codes",
    label: "Categories",
    kind: "category_checkboxes",
    hint_text: "↑↓ move · space or enter toggles · enter on → continue",
  },
  {
    step_key: "interests_blurb_text",
    label: "Interests",
    kind: "text",
    hint_text: "what you want to read about · guides the picks · enter to skip",
  },
  {
    step_key: "reading_intent_blurb_text",
    label: "Goal",
    kind: "text",
    hint_text: "why you read papers right now · enter to skip",
  },
  {
    step_key: "openrouter_chat_model_id",
    label: "Model",
    kind: "text",
    hint_text: "enter keeps DeepSeek V4 Flash",
  },
];

export const continue_option_cursor_position = arxiv_category_catalog.length;

const step_at_index = (step_index) => setup_wizard_steps[step_index];

function text_editor_for_step(step, draft_settings) {
  if (step.kind !== "text") return null;
  return text_editor_state_for({ setting_key: step.step_key, initial_text: draft_settings[step.step_key] ?? "" });
}

export function initial_setup_wizard_state({ environment_openrouter_api_key, environment_fireworks_api_key }) {
  const draft_settings = {
    openrouter_api_key: environment_openrouter_api_key ?? "",
    fireworks_api_key: environment_fireworks_api_key ?? "",
    tracked_arxiv_category_codes: [...default_settings.tracked_arxiv_category_codes],
    interests_blurb_text: "",
    reading_intent_blurb_text: "",
    openrouter_chat_model_id: default_settings.openrouter_chat_model_id,
  };
  return {
    active_step_index: 0,
    draft_settings,
    text_editor_state: text_editor_for_step(step_at_index(0), draft_settings),
    category_cursor_position: 0,
    validation_message: null,
  };
}

function wizard_state_at_step(wizard_state, step_index) {
  return {
    ...wizard_state,
    active_step_index: step_index,
    text_editor_state: text_editor_for_step(step_at_index(step_index), wizard_state.draft_settings),
    category_cursor_position: 0,
    validation_message: null,
  };
}

function advanced_outcome(wizard_state) {
  const next_step_index = wizard_state.active_step_index + 1;
  if (next_step_index >= setup_wizard_steps.length) {
    return { kind: "completed", draft_settings: wizard_state.draft_settings };
  }
  return { kind: "in_progress", wizard_state: wizard_state_at_step(wizard_state, next_step_index) };
}

function retreated_outcome(wizard_state) {
  const previous_step_index = Math.max(0, wizard_state.active_step_index - 1);
  return { kind: "in_progress", wizard_state: wizard_state_at_step(wizard_state, previous_step_index) };
}

function still_editing_outcome(wizard_state, changes) {
  return { kind: "in_progress", wizard_state: { ...wizard_state, ...changes } };
}

function committed_text_value(step, committed_text) {
  if (step.step_key === "openrouter_chat_model_id" && !committed_text) return default_settings.openrouter_chat_model_id;
  return committed_text;
}

function text_step_outcome({ wizard_state, typed_character, pressed_key }) {
  const editor_outcome = text_editor_state_after_key({
    editor_state: wizard_state.text_editor_state,
    typed_character,
    pressed_key,
  });
  if (editor_outcome.kind === "cancelled") return retreated_outcome(wizard_state);
  if (editor_outcome.kind === "editing") {
    return still_editing_outcome(wizard_state, { text_editor_state: editor_outcome.editor_state, validation_message: null });
  }

  const step = step_at_index(wizard_state.active_step_index);
  const committed_text = editor_outcome.editor_state.draft_text.trim();
  if (step.step_key === "openrouter_api_key" && !committed_text) {
    return still_editing_outcome(wizard_state, {
      validation_message: "an OpenRouter key is required — paperman picks papers with it",
    });
  }
  return advanced_outcome({
    ...wizard_state,
    draft_settings: { ...wizard_state.draft_settings, [step.step_key]: committed_text_value(step, committed_text) },
  });
}

function with_toggled_category_at_cursor(wizard_state) {
  const { arxiv_category_code } = arxiv_category_catalog[wizard_state.category_cursor_position];
  const tracked_codes = wizard_state.draft_settings.tracked_arxiv_category_codes;
  const toggled_tracked_codes = tracked_codes.includes(arxiv_category_code)
    ? tracked_codes.filter((tracked_code) => tracked_code !== arxiv_category_code)
    : [...tracked_codes, arxiv_category_code];
  return {
    ...wizard_state,
    validation_message: null,
    draft_settings: { ...wizard_state.draft_settings, tracked_arxiv_category_codes: toggled_tracked_codes },
  };
}

function category_step_outcome({ wizard_state, pressed_key }) {
  const key_name = pressed_key?.name;
  const cursor_position = wizard_state.category_cursor_position;
  const is_cursor_on_continue = cursor_position === continue_option_cursor_position;

  if (key_name === "up" || key_name === "k") {
    return still_editing_outcome(wizard_state, { category_cursor_position: Math.max(0, cursor_position - 1) });
  }
  if (key_name === "down" || key_name === "j") {
    return still_editing_outcome(wizard_state, {
      category_cursor_position: Math.min(continue_option_cursor_position, cursor_position + 1),
    });
  }
  if (key_name === "escape") return retreated_outcome(wizard_state);
  if (key_name === "space" && !is_cursor_on_continue) {
    return still_editing_outcome(with_toggled_category_at_cursor(wizard_state), {});
  }
  if (key_name !== "return") return still_editing_outcome(wizard_state, {});
  if (!is_cursor_on_continue) return still_editing_outcome(with_toggled_category_at_cursor(wizard_state), {});
  if (wizard_state.draft_settings.tracked_arxiv_category_codes.length === 0) {
    return still_editing_outcome(wizard_state, { validation_message: "track at least one category" });
  }
  return advanced_outcome(wizard_state);
}

export function setup_wizard_state_after_key({ wizard_state, typed_character, pressed_key }) {
  const active_step = step_at_index(wizard_state.active_step_index);
  if (active_step.kind === "category_checkboxes") return category_step_outcome({ wizard_state, pressed_key });
  return text_step_outcome({ wizard_state, typed_character, pressed_key });
}

export function active_setup_wizard_step(wizard_state) {
  return step_at_index(wizard_state.active_step_index);
}

function completed_step_summary_text(step, draft_settings) {
  if (step.step_key === "openrouter_api_key") return masked_api_key_text(draft_settings.openrouter_api_key);
  if (step.step_key === "fireworks_api_key") {
    return draft_settings.fireworks_api_key ? masked_api_key_text(draft_settings.fireworks_api_key) : "(skipped)";
  }
  if (step.step_key === "tracked_arxiv_category_codes") {
    return `${draft_settings.tracked_arxiv_category_codes.length} tracked`;
  }
  return draft_settings[step.step_key] || "(skipped)";
}

function active_step_child_rows(wizard_state, is_under_last_step) {
  const active_step = step_at_index(wizard_state.active_step_index);
  if (active_step.kind === "category_checkboxes") {
    const tracked_codes = wizard_state.draft_settings.tracked_arxiv_category_codes;
    const option_rows = arxiv_category_catalog.map((catalog_entry, option_index) => ({
      type: "wizard_category_option",
      option_label: `${catalog_entry.arxiv_category_code} — ${display_name_for_arxiv_category_code(catalog_entry.arxiv_category_code)}`,
      is_tracked: tracked_codes.includes(catalog_entry.arxiv_category_code),
      is_under_cursor: wizard_state.category_cursor_position === option_index,
      is_under_last_step,
    }));
    return [
      ...option_rows,
      {
        type: "wizard_continue_option",
        is_under_cursor: wizard_state.category_cursor_position === continue_option_cursor_position,
        is_under_last_step,
      },
    ];
  }
  return [{ type: "wizard_text_input", text_editor_state: wizard_state.text_editor_state, is_under_last_step }];
}

export function build_setup_wizard_rows(wizard_state) {
  const rows = [
    { type: "wizard_title", text: "📮 paperman · first delivery" },
    { type: "spine" },
  ];

  for (const [step_index, step] of setup_wizard_steps.entries()) {
    const is_last_step = step_index === setup_wizard_steps.length - 1;
    const step_state =
      step_index < wizard_state.active_step_index ? "completed" : step_index === wizard_state.active_step_index ? "active" : "pending";
    rows.push({
      type: "wizard_step",
      label: step.label,
      step_state,
      summary_text: step_state === "completed" ? completed_step_summary_text(step, wizard_state.draft_settings) : "",
      is_last_step,
    });
    if (step_state === "active") rows.push(...active_step_child_rows(wizard_state, is_last_step));
  }
  return rows;
}
