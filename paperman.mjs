#!/usr/bin/env node
// αριανός

import { spawn } from "node:child_process";
import readline from "node:readline";
import { arxiv_category_catalog } from "./source/arxiv_category_catalog.mjs";
import { fetch_arxiv_papers_for_category } from "./source/arxiv_paper_feed.mjs";
import { embed_paper_texts, request_daily_pick } from "./source/fireworks_api.mjs";
import { daily_paper_selection_for_date } from "./source/daily_paper_selection_pipeline.mjs";
import { google_calendar_event_link, next_full_hour_at_least_minutes_away } from "./source/google_calendar_event_link.mjs";
import { default_settings, open_paperman_home_files, paperman_home_directory_path } from "./source/paperman_home_files.mjs";
import {
  arxiv_id_after_selection_move,
  build_paper_list_rows,
  build_settings_rows,
  fit_text_to_width,
  masked_api_key_text,
  nearest_interactive_settings_row_index,
  selected_paper_row_index,
  settings_cursor_index_after_move,
} from "./source/screen_row_models.mjs";
import {
  text_editor_state_after_key,
  text_editor_state_for,
  windowed_draft_for_display,
} from "./source/single_line_text_editor.mjs";

const maximum_rendered_line_width = 400;
const reading_session_duration_in_minutes = 60;
const minimum_minutes_before_reading_session = 60;
const abstract_characters_shown_in_calendar_details = 400;
const add_custom_category_setting_key = "add_custom_category";

const ansi_reset = "\x1b[0m";
const ansi_bold = "\x1b[1m";
const ansi_dim = "\x1b[2m";
const ansi_inverse = "\x1b[7m";
const ansi_strikethrough = "\x1b[9m";
const application_title_style = "\x1b[1;38;2;186;148;255m";
const section_heading_style = "\x1b[1;38;2;97;175;255m";
const tree_spine_style = "\x1b[38;2;95;95;115m";
const arxiv_id_style = "\x1b[38;2;140;140;165m";
const category_code_style = "\x1b[38;2;229;192;123m";
const completed_glyph_style = "\x1b[38;2;120;220;120m";
const crossed_out_glyph_style = "\x1b[38;2;255;110;110m";
const warning_style = "\x1b[38;2;255;110;110m";

const home_files = open_paperman_home_files(paperman_home_directory_path());

const user_interface_state = {
  active_screen: "paper_list",
  settings: home_files.read_settings(),
  daily_selection: null,
  warnings: [],
  paper_list_rows: [],
  selected_arxiv_id: null,
  paper_list_scroll_offset: 0,
  settings_rows: [],
  settings_cursor_index: 0,
  settings_scroll_offset: 0,
  text_input: null,
  status_message: null,
  is_regenerating: false,
  have_tracked_categories_changed: false,
  is_inside_alternate_screen: false,
};

function current_date_iso() {
  const fake_today_iso = process.env.PAPERMAN_FAKE_TODAY?.trim();
  if (fake_today_iso) return fake_today_iso;
  return new Date().toLocaleDateString("en-CA");
}

function fireworks_api_key_in_use() {
  return process.env.FIREWORKS_API_KEY?.trim() || user_interface_state.settings.fireworks_api_key;
}

function report_progress(progress_message) {
  if (!user_interface_state.is_inside_alternate_screen) {
    console.log(`  ${progress_message}`);
    return;
  }
  user_interface_state.status_message = progress_message;
  render();
}

async function generate_daily_selection({ force_regeneration }) {
  const settings = user_interface_state.settings;
  return daily_paper_selection_for_date({
    current_date_iso: current_date_iso(),
    force_regeneration,
    settings,
    read_daily_selection: home_files.read_daily_selection,
    write_daily_selection: home_files.write_daily_selection,
    read_mark_history: home_files.read_mark_history,
    fetch_papers_for_category: fetch_arxiv_papers_for_category,
    embed_texts: (paper_texts) =>
      embed_paper_texts({
        fireworks_api_key: fireworks_api_key_in_use(),
        fireworks_embedding_model_id: settings.fireworks_embedding_model_id,
        paper_texts,
      }),
    request_pick: (prompt_text) =>
      request_daily_pick({
        fireworks_api_key: fireworks_api_key_in_use(),
        fireworks_chat_model_id: settings.fireworks_chat_model_id,
        prompt_text,
      }),
    report_progress,
  });
}

function apply_daily_selection_result({ daily_selection, warnings }) {
  user_interface_state.daily_selection = daily_selection;
  user_interface_state.warnings = warnings;
  user_interface_state.paper_list_rows = build_paper_list_rows(daily_selection);
  const still_selected_row_index = selected_paper_row_index(
    user_interface_state.paper_list_rows,
    user_interface_state.selected_arxiv_id
  );
  if (still_selected_row_index === -1) {
    user_interface_state.selected_arxiv_id = null;
    return;
  }
  user_interface_state.selected_arxiv_id = user_interface_state.paper_list_rows[still_selected_row_index].paper.arxiv_id;
}

function save_settings_changes(settings_changes) {
  home_files.write_settings(settings_changes);
  user_interface_state.settings = home_files.read_settings();
  user_interface_state.settings_rows = build_settings_rows(user_interface_state.settings);
}

async function run_first_run_setup_wizard() {
  const wizard_prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question_text) => new Promise((resolve_with_answer) => wizard_prompt.question(question_text, resolve_with_answer));

  console.log(`\n📮 paperman setup — saved to ${paperman_home_directory_path()}\n`);

  const api_key_from_environment = process.env.FIREWORKS_API_KEY?.trim();
  let fireworks_api_key = api_key_from_environment ?? "";
  if (api_key_from_environment) console.log("Fireworks API key: using FIREWORKS_API_KEY from the environment.\n");
  while (!fireworks_api_key) {
    fireworks_api_key = (await ask("Fireworks API key (fireworks.ai → API Keys): ")).trim();
    if (!fireworks_api_key) console.log("  Required — paperman filters papers with GLM on Fireworks.");
  }

  console.log("\nCommon arXiv categories:");
  for (const [catalog_index, catalog_entry] of arxiv_category_catalog.entries()) {
    console.log(`  ${String(catalog_index + 1).padStart(2)}. ${catalog_entry.arxiv_category_code} — ${catalog_entry.display_name}`);
  }
  const default_category_codes = default_settings.tracked_arxiv_category_codes.join(",");
  const categories_answer = (await ask(`Track (numbers and/or codes, comma-separated) [${default_category_codes}]: `)).trim();
  const tracked_arxiv_category_codes = tracked_codes_from_wizard_answer(categories_answer);

  const interests_blurb_text = (await ask("\nYour interests (one line, guides the picks, enter to skip): ")).trim();
  const reading_intent_blurb_text = (await ask("Your current goal (why you read papers, enter to skip): ")).trim();
  const chat_model_answer = (await ask(`Chat model [${default_settings.fireworks_chat_model_id}]: `)).trim();
  wizard_prompt.close();

  save_settings_changes({
    fireworks_api_key,
    tracked_arxiv_category_codes,
    interests_blurb_text,
    reading_intent_blurb_text,
    fireworks_chat_model_id: chat_model_answer || default_settings.fireworks_chat_model_id,
    has_completed_first_run_setup: true,
  });
  console.log("\n✅ Saved. Building today's reading list…\n");
}

function tracked_codes_from_wizard_answer(categories_answer) {
  if (!categories_answer) return default_settings.tracked_arxiv_category_codes;
  const answer_tokens = categories_answer.split(",").map((answer_token) => answer_token.trim()).filter(Boolean);
  const category_codes = answer_tokens.map((answer_token) => {
    const catalog_number = Number(answer_token);
    const is_catalog_number = Number.isInteger(catalog_number) && catalog_number >= 1 && catalog_number <= arxiv_category_catalog.length;
    if (is_catalog_number) return arxiv_category_catalog[catalog_number - 1].arxiv_category_code;
    return answer_token;
  });
  return [...new Set(category_codes)];
}

function open_in_browser(url) {
  const opener_command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener_command, [url], { detached: true, stdio: "ignore" }).unref();
}

function selected_paper() {
  const row_index = selected_paper_row_index(user_interface_state.paper_list_rows, user_interface_state.selected_arxiv_id);
  if (row_index < 0) return null;
  return user_interface_state.paper_list_rows[row_index].paper;
}

function open_selected_paper_in_browser() {
  const paper = selected_paper();
  if (!paper) return;
  open_in_browser(paper.arxiv_abstract_url);
}

function open_reading_session_calendar_link() {
  const paper = selected_paper();
  if (!paper) return;
  const session_start_date = next_full_hour_at_least_minutes_away({
    now_date: new Date(),
    minimum_minutes_away: minimum_minutes_before_reading_session,
  });
  const calendar_link = google_calendar_event_link({
    event_title: `Read: ${paper.title}`,
    event_details: [
      paper.language_model_selection_reason,
      paper.abstract_text.slice(0, abstract_characters_shown_in_calendar_details),
      paper.arxiv_abstract_url,
    ].join("\n\n"),
    start_date: session_start_date,
    duration_in_minutes: reading_session_duration_in_minutes,
    timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  open_in_browser(calendar_link);
  user_interface_state.status_message = "reading session sent to Google Calendar";
}

function backfill_missing_embedding_vector(paper) {
  const embedding_request = embed_paper_texts({
    fireworks_api_key: fireworks_api_key_in_use(),
    fireworks_embedding_model_id: user_interface_state.settings.fireworks_embedding_model_id,
    paper_texts: [`${paper.title}\n\n${paper.abstract_text}`],
  });
  embedding_request
    .then(([embedding_vector]) => {
      paper.abstract_embedding_vector = embedding_vector;
      home_files.write_daily_selection(user_interface_state.daily_selection);
      const marked_paper = home_files.read_mark_history()[paper.arxiv_id];
      if (marked_paper) home_files.upsert_mark({ ...marked_paper, abstract_embedding_vector: embedding_vector });
    })
    .catch((embedding_error) => {
      user_interface_state.status_message = `embedding backfill failed: ${embedding_error.message}`;
      render();
    });
}

function toggle_mark_on_selected_paper(mark_kind) {
  const paper = selected_paper();
  if (!paper) return;
  const marks_by_arxiv_id = user_interface_state.daily_selection.mark_by_arxiv_id;
  const is_already_marked_this_kind = marks_by_arxiv_id[paper.arxiv_id] === mark_kind;

  if (is_already_marked_this_kind) {
    delete marks_by_arxiv_id[paper.arxiv_id];
    home_files.remove_mark(paper.arxiv_id);
    home_files.write_daily_selection(user_interface_state.daily_selection);
    return;
  }

  marks_by_arxiv_id[paper.arxiv_id] = mark_kind;
  home_files.upsert_mark({
    arxiv_id: paper.arxiv_id,
    title: paper.title,
    abstract_text: paper.abstract_text,
    primary_arxiv_category_code: paper.primary_arxiv_category_code,
    mark_kind,
    marked_at_iso: new Date().toISOString(),
    abstract_embedding_vector: paper.abstract_embedding_vector ?? null,
  });
  home_files.write_daily_selection(user_interface_state.daily_selection);
  if (!paper.abstract_embedding_vector) backfill_missing_embedding_vector(paper);
}

async function regenerate_daily_selection() {
  if (user_interface_state.is_regenerating) return;
  user_interface_state.is_regenerating = true;
  user_interface_state.status_message = "refreshing…";
  render();
  try {
    apply_daily_selection_result(await generate_daily_selection({ force_regeneration: true }));
    user_interface_state.have_tracked_categories_changed = false;
    user_interface_state.status_message = null;
  } catch (regeneration_error) {
    user_interface_state.status_message = `refresh failed: ${regeneration_error.message}`;
  }
  user_interface_state.is_regenerating = false;
  render();
}

function mark_glyph_cell(mark_kind) {
  if (mark_kind === "completed") return `${completed_glyph_style}✓${ansi_reset} `;
  if (mark_kind === "crossed_out") return `${crossed_out_glyph_style}✗${ansi_reset} `;
  return "  ";
}

function paper_list_column_widths(rows) {
  const papers = rows.filter((row) => row.type === "paper").map((row) => row.paper);
  const widest_arxiv_id = Math.max(0, ...papers.map((paper) => paper.arxiv_id.length));
  const widest_category_code = Math.max(0, ...papers.map((paper) => paper.primary_arxiv_category_code.length));
  return { arxiv_id: widest_arxiv_id, category_code: widest_category_code };
}

function render_paper_row(row, column_widths, terminal_column_count, is_selected) {
  const spine_cell = row.is_under_last_category ? "  " : `${tree_spine_style}│${ansi_reset} `;
  const mark_kind = user_interface_state.daily_selection.mark_by_arxiv_id[row.paper.arxiv_id];
  const gap_and_prefix_width = 4 + 2 + column_widths.arxiv_id + 2 + 2 + column_widths.category_code + 1;
  const title_column_width = Math.max(8, terminal_column_count - gap_and_prefix_width);

  const arxiv_id_text = fit_text_to_width(row.paper.arxiv_id, column_widths.arxiv_id);
  const title_text = fit_text_to_width(row.paper.title, title_column_width);
  const category_code_text = fit_text_to_width(row.paper.primary_arxiv_category_code, column_widths.category_code);

  if (is_selected) {
    const selected_text = `${arxiv_id_text}  ${title_text}  ${category_code_text}`;
    return ` ${spine_cell}${mark_glyph_cell(mark_kind)}${ansi_inverse}${ansi_bold} ${selected_text}${ansi_reset}`;
  }
  const marked_text_style = mark_kind ? `${ansi_dim}${ansi_strikethrough}` : "";
  return (
    ` ${spine_cell}${mark_glyph_cell(mark_kind)} ` +
    `${arxiv_id_style}${marked_text_style}${arxiv_id_text}${ansi_reset}  ` +
    `${marked_text_style}${title_text}${ansi_reset}  ` +
    `${category_code_style}${marked_text_style}${category_code_text}${ansi_reset}`
  );
}

function render_paper_list_row(row, column_widths, terminal_column_count, is_selected) {
  if (row.type === "application_title") return ` ${application_title_style}${row.text}${ansi_reset}`;
  if (row.type === "spine") return ` ${tree_spine_style}│${row.text ? `  ${ansi_dim}${row.text}` : ""}${ansi_reset}`;
  if (row.type === "category_heading") {
    const branch_glyph = row.is_last_category ? "└─" : "├─";
    return ` ${tree_spine_style}${branch_glyph}${ansi_reset} ${section_heading_style}${row.text}${ansi_reset}`;
  }
  if (row.type === "paper") return render_paper_row(row, column_widths, terminal_column_count, is_selected);
  return "";
}

function rendered_text_setting_value(row) {
  if (user_interface_state.text_input?.setting_key === row.setting_key) return null;
  if (row.is_masked) return masked_api_key_text(row.current_text);
  if (!row.current_text) return `${ansi_dim}(not set)${ansi_reset}`;
  return row.current_text;
}

function render_active_text_input(label_text, terminal_column_count) {
  const editor_state = user_interface_state.text_input.editor_state;
  const editor_width = Math.max(12, terminal_column_count - label_text.length - 8);
  const { visible_text, cursor_position_in_visible_text } = windowed_draft_for_display({
    draft_text: editor_state.draft_text,
    cursor_position: editor_state.cursor_position,
    maximum_width: editor_width,
  });
  const text_before_cursor = visible_text.slice(0, cursor_position_in_visible_text);
  const character_under_cursor = visible_text[cursor_position_in_visible_text] ?? " ";
  const text_after_cursor = visible_text.slice(cursor_position_in_visible_text + 1);
  return `    ${section_heading_style}${label_text}${ansi_reset}: ${text_before_cursor}${ansi_inverse}${character_under_cursor}${ansi_reset}${text_after_cursor}`;
}

function render_settings_row(row, terminal_column_count, is_under_cursor) {
  if (row.type === "screen_title") return ` ${application_title_style}${row.text}${ansi_reset}`;
  if (row.type === "section_heading") return ` ${section_heading_style}${row.text}${ansi_reset}`;
  if (row.type === "blank") return "";

  if (row.type === "category_checkbox") {
    const is_tracked = user_interface_state.settings.tracked_arxiv_category_codes.includes(row.arxiv_category_code);
    const checkbox_glyph = is_tracked ? "[x]" : "[ ]";
    if (is_under_cursor) return `   ${ansi_inverse}${ansi_bold} ${checkbox_glyph} ${row.label} ${ansi_reset}`;
    return `    ${checkbox_glyph} ${row.label}`;
  }

  if (row.type === "add_custom_category_action") {
    const is_editing_this_row = user_interface_state.text_input?.setting_key === add_custom_category_setting_key;
    if (is_editing_this_row) return render_active_text_input("new code", terminal_column_count);
    if (is_under_cursor) return `   ${ansi_inverse}${ansi_bold} [+] ${row.label} ${ansi_reset}`;
    return `    ${ansi_dim}[+] ${row.label}${ansi_reset}`;
  }

  const setting_value_text = rendered_text_setting_value(row);
  if (setting_value_text === null) return render_active_text_input(row.label, terminal_column_count);
  const fitted_value_text = fit_text_to_width(setting_value_text, Math.max(12, terminal_column_count - row.label.length - 10)).trimEnd();
  if (is_under_cursor) return `   ${ansi_inverse}${ansi_bold} ${row.label}: ${fitted_value_text} ${ansi_reset}`;
  return `    ${row.label}: ${fitted_value_text}`;
}

function write_screen_frame(lines, footer_lines) {
  const frame =
    "\x1b[H" +
    lines.map((line) => line.slice(0, maximum_rendered_line_width) + "\x1b[K").join("\r\n") +
    "\r\n" +
    footer_lines.map((footer_line) => footer_line.slice(0, maximum_rendered_line_width) + "\x1b[K").join("\r\n");
  process.stdout.write(frame);
}

function visible_content_height() {
  return Math.max(3, (process.stdout.rows ?? 24) - 2);
}

function clamped_scroll_offset({ scroll_offset, target_row_index, row_count, content_height }) {
  let next_scroll_offset = scroll_offset;
  if (target_row_index >= 0 && target_row_index < next_scroll_offset) next_scroll_offset = target_row_index;
  if (target_row_index >= next_scroll_offset + content_height) next_scroll_offset = target_row_index - content_height + 1;
  return Math.min(next_scroll_offset, Math.max(0, row_count - content_height));
}

function footer_status_text() {
  const warning_text = user_interface_state.warnings[0]
    ? `${warning_style}${fit_text_to_width(user_interface_state.warnings[0], 60).trim()}${ansi_reset}${ansi_dim} · `
    : "";
  const category_change_hint = user_interface_state.have_tracked_categories_changed ? "categories changed · press r to refetch · " : "";
  const status_text = user_interface_state.status_message ? `${user_interface_state.status_message} · ` : "";
  return `${warning_text}${category_change_hint}${status_text}`;
}

function render_paper_list_screen() {
  const terminal_column_count = process.stdout.columns ?? 80;
  const content_height = visible_content_height();
  const rows = user_interface_state.paper_list_rows;
  const selected_row_index = selected_paper_row_index(rows, user_interface_state.selected_arxiv_id);

  user_interface_state.paper_list_scroll_offset = clamped_scroll_offset({
    scroll_offset: user_interface_state.paper_list_scroll_offset,
    target_row_index: selected_row_index,
    row_count: rows.length,
    content_height,
  });

  const column_widths = paper_list_column_widths(rows);
  const lines = [];
  for (let visible_row_index = 0; visible_row_index < content_height; visible_row_index++) {
    const row = rows[user_interface_state.paper_list_scroll_offset + visible_row_index];
    const absolute_row_index = user_interface_state.paper_list_scroll_offset + visible_row_index;
    lines.push(row ? render_paper_list_row(row, column_widths, terminal_column_count, absolute_row_index === selected_row_index) : "");
  }

  const reason_text = selected_paper()?.language_model_selection_reason ?? "";
  const reason_footer_line = ` ${ansi_dim}${fit_text_to_width(reason_text ? `↳ ${reason_text}` : "", Math.max(8, terminal_column_count - 2)).trimEnd()}${ansi_reset}`;
  const key_hints = "↑↓ · enter open · c done · x skip · g calendar · s settings · r refresh · q";
  const hints_footer_line = ` ${ansi_dim}${footer_status_text()}${key_hints}${ansi_reset}`;
  write_screen_frame(lines, [reason_footer_line, hints_footer_line]);
}

function render_settings_screen() {
  const terminal_column_count = process.stdout.columns ?? 80;
  const content_height = visible_content_height();
  const rows = user_interface_state.settings_rows;

  user_interface_state.settings_scroll_offset = clamped_scroll_offset({
    scroll_offset: user_interface_state.settings_scroll_offset,
    target_row_index: user_interface_state.settings_cursor_index,
    row_count: rows.length,
    content_height,
  });

  const lines = [];
  for (let visible_row_index = 0; visible_row_index < content_height; visible_row_index++) {
    const absolute_row_index = user_interface_state.settings_scroll_offset + visible_row_index;
    const row = rows[absolute_row_index];
    const is_under_cursor = absolute_row_index === user_interface_state.settings_cursor_index && !user_interface_state.text_input;
    lines.push(row ? render_settings_row(row, terminal_column_count, is_under_cursor) : "");
  }

  const editing_hints = "type · ←→ move · enter save · esc cancel";
  const browsing_hints = "↑↓ move · space toggle/edit · s/esc back";
  const hints_footer_line = ` ${ansi_dim}${footer_status_text()}${user_interface_state.text_input ? editing_hints : browsing_hints}${ansi_reset}`;
  write_screen_frame(lines, ["", hints_footer_line]);
}

function render() {
  if (!user_interface_state.is_inside_alternate_screen) return;
  if (user_interface_state.active_screen === "settings") {
    render_settings_screen();
    return;
  }
  render_paper_list_screen();
}

function open_settings_screen() {
  user_interface_state.settings_rows = build_settings_rows(user_interface_state.settings);
  user_interface_state.settings_cursor_index = nearest_interactive_settings_row_index(user_interface_state.settings_rows, 0);
  user_interface_state.active_screen = "settings";
}

function close_settings_screen() {
  user_interface_state.active_screen = "paper_list";
}

function toggle_tracked_category(arxiv_category_code) {
  const tracked_codes = user_interface_state.settings.tracked_arxiv_category_codes;
  const updated_tracked_codes = tracked_codes.includes(arxiv_category_code)
    ? tracked_codes.filter((tracked_code) => tracked_code !== arxiv_category_code)
    : [...tracked_codes, arxiv_category_code];
  save_settings_changes({ tracked_arxiv_category_codes: updated_tracked_codes });
  user_interface_state.have_tracked_categories_changed = true;
}

function begin_editing_settings_row(row) {
  if (row.type === "category_checkbox") {
    toggle_tracked_category(row.arxiv_category_code);
    return;
  }
  if (row.type === "add_custom_category_action") {
    user_interface_state.text_input = {
      setting_key: add_custom_category_setting_key,
      editor_state: text_editor_state_for({ setting_key: add_custom_category_setting_key, initial_text: "" }),
    };
    return;
  }
  user_interface_state.text_input = {
    setting_key: row.setting_key,
    editor_state: text_editor_state_for({ setting_key: row.setting_key, initial_text: row.current_text }),
  };
}

function commit_text_input(editor_state) {
  const committed_text = editor_state.draft_text.trim();
  if (editor_state.setting_key === add_custom_category_setting_key) {
    if (committed_text) toggle_tracked_category(committed_text);
    return;
  }
  save_settings_changes({ [editor_state.setting_key]: committed_text });
}

function handle_text_input_key(typed_character, pressed_key) {
  const key_outcome = text_editor_state_after_key({
    editor_state: user_interface_state.text_input.editor_state,
    typed_character,
    pressed_key,
  });
  if (key_outcome.kind === "editing") {
    user_interface_state.text_input = { ...user_interface_state.text_input, editor_state: key_outcome.editor_state };
    return;
  }
  if (key_outcome.kind === "committed") commit_text_input(key_outcome.editor_state);
  user_interface_state.text_input = null;
}

function handle_settings_key(pressed_key) {
  const rows = user_interface_state.settings_rows;
  if (pressed_key.name === "up" || pressed_key.name === "k") {
    user_interface_state.settings_cursor_index = settings_cursor_index_after_move(rows, user_interface_state.settings_cursor_index, -1);
  }
  if (pressed_key.name === "down" || pressed_key.name === "j") {
    user_interface_state.settings_cursor_index = settings_cursor_index_after_move(rows, user_interface_state.settings_cursor_index, 1);
  }
  if (pressed_key.name === "space" || pressed_key.name === "return") {
    begin_editing_settings_row(rows[user_interface_state.settings_cursor_index]);
  }
  if (pressed_key.name === "s" || pressed_key.name === "escape" || pressed_key.name === "q") close_settings_screen();
}

function handle_paper_list_key(pressed_key) {
  if (pressed_key.name === "q") quit();
  if (pressed_key.name === "up" || pressed_key.name === "k") {
    user_interface_state.selected_arxiv_id = arxiv_id_after_selection_move(user_interface_state.paper_list_rows, user_interface_state.selected_arxiv_id, -1);
  }
  if (pressed_key.name === "down" || pressed_key.name === "j") {
    user_interface_state.selected_arxiv_id = arxiv_id_after_selection_move(user_interface_state.paper_list_rows, user_interface_state.selected_arxiv_id, 1);
  }
  if (pressed_key.name === "return") open_selected_paper_in_browser();
  if (pressed_key.name === "c") toggle_mark_on_selected_paper("completed");
  if (pressed_key.name === "x") toggle_mark_on_selected_paper("crossed_out");
  if (pressed_key.name === "g") open_reading_session_calendar_link();
  if (pressed_key.name === "s") open_settings_screen();
  if (pressed_key.name === "r") regenerate_daily_selection();
}

function enter_alternate_screen() {
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  user_interface_state.is_inside_alternate_screen = true;
}

function leave_alternate_screen() {
  user_interface_state.is_inside_alternate_screen = false;
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

function quit(exit_code = 0) {
  leave_alternate_screen();
  process.exit(exit_code);
}

async function main() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("paperman needs an interactive terminal.");
    process.exit(1);
  }

  if (!user_interface_state.settings.has_completed_first_run_setup) await run_first_run_setup_wizard();

  let daily_selection_result;
  try {
    daily_selection_result = await generate_daily_selection({ force_regeneration: false });
  } catch (generation_error) {
    console.error(`❌ ${generation_error.message}`);
    console.error("Check your connection and Fireworks key (settings screen, or FIREWORKS_API_KEY).");
    process.exit(1);
  }

  enter_alternate_screen();
  apply_daily_selection_result(daily_selection_result);
  render();

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", (typed_character, pressed_key) => {
    if (!pressed_key) return;
    if (pressed_key.ctrl && pressed_key.name === "c") quit();
    if (user_interface_state.text_input) {
      handle_text_input_key(typed_character, pressed_key);
      render();
      return;
    }
    if (user_interface_state.active_screen === "settings") {
      handle_settings_key(pressed_key);
      render();
      return;
    }
    handle_paper_list_key(pressed_key);
    render();
  });

  process.stdout.on("resize", render);
  process.on("SIGTERM", () => quit());
}

main();
