export function text_editor_state_for({ setting_key, initial_text }) {
  return { setting_key, draft_text: initial_text, cursor_position: initial_text.length };
}

function printable_characters_of(typed_character) {
  if (!typed_character) return "";
  return [...typed_character].filter((single_character) => {
    const code_point = single_character.codePointAt(0);
    return code_point >= 0x20 && code_point !== 0x7f;
  }).join("");
}

function with_inserted_text(editor_state, inserted_text) {
  const { draft_text, cursor_position } = editor_state;
  return {
    ...editor_state,
    draft_text: draft_text.slice(0, cursor_position) + inserted_text + draft_text.slice(cursor_position),
    cursor_position: cursor_position + inserted_text.length,
  };
}

function with_deleted_character_before_cursor(editor_state) {
  const { draft_text, cursor_position } = editor_state;
  if (cursor_position === 0) return editor_state;
  return {
    ...editor_state,
    draft_text: draft_text.slice(0, cursor_position - 1) + draft_text.slice(cursor_position),
    cursor_position: cursor_position - 1,
  };
}

function with_cursor_position(editor_state, cursor_position) {
  const clamped_cursor_position = Math.min(editor_state.draft_text.length, Math.max(0, cursor_position));
  return { ...editor_state, cursor_position: clamped_cursor_position };
}

export function text_editor_state_after_key({ editor_state, typed_character, pressed_key }) {
  const key_name = pressed_key?.name;
  if (key_name === "escape") return { kind: "cancelled", editor_state };
  if (key_name === "return" || key_name === "enter") return { kind: "committed", editor_state };
  if (key_name === "backspace") return { kind: "editing", editor_state: with_deleted_character_before_cursor(editor_state) };
  if (key_name === "left") return { kind: "editing", editor_state: with_cursor_position(editor_state, editor_state.cursor_position - 1) };
  if (key_name === "right") return { kind: "editing", editor_state: with_cursor_position(editor_state, editor_state.cursor_position + 1) };
  if (key_name === "home" || (pressed_key?.ctrl && key_name === "a")) return { kind: "editing", editor_state: with_cursor_position(editor_state, 0) };
  if (key_name === "end" || (pressed_key?.ctrl && key_name === "e")) return { kind: "editing", editor_state: with_cursor_position(editor_state, editor_state.draft_text.length) };
  if (pressed_key?.ctrl && key_name === "u") return { kind: "editing", editor_state: { ...editor_state, draft_text: "", cursor_position: 0 } };
  if (pressed_key?.ctrl || pressed_key?.meta) return { kind: "editing", editor_state };

  const inserted_text = printable_characters_of(typed_character);
  if (!inserted_text) return { kind: "editing", editor_state };
  return { kind: "editing", editor_state: with_inserted_text(editor_state, inserted_text) };
}

export function windowed_draft_for_display({ draft_text, cursor_position, maximum_width }) {
  if (draft_text.length < maximum_width) {
    return { visible_text: draft_text, cursor_position_in_visible_text: cursor_position };
  }
  const window_start = Math.min(
    Math.max(0, cursor_position - Math.floor(maximum_width / 2)),
    draft_text.length - maximum_width + 1
  );
  return {
    visible_text: draft_text.slice(window_start, window_start + maximum_width - 1),
    cursor_position_in_visible_text: cursor_position - window_start,
  };
}
