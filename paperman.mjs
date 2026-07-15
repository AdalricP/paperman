#!/usr/bin/env node
// αριανός

import "./source/environment_variables.mjs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fetch_arxiv_papers_for_category } from "./source/arxiv_paper_feed.mjs";
import { request_daily_pick } from "./source/model_provider_api.mjs";
import { daily_paper_selection_for_date } from "./source/daily_paper_selection_pipeline.mjs";
import { google_calendar_event_link, next_full_hour_at_least_minutes_away } from "./source/google_calendar_event_link.mjs";
import { airtable_base_id_from_input, append_crossed_paper_to_airtable, remove_crossed_paper_from_airtable } from "./source/airtable_paper_log.mjs";
import { open_paperman_home_files, paperman_home_directory_path } from "./source/paperman_home_files.mjs";
import { expanded_category_group_codes_after_toggle, initial_expanded_category_group_codes } from "./source/category_tree_model.mjs";
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
  active_setup_wizard_step,
  build_setup_wizard_rows,
  initial_setup_wizard_state,
  setup_wizard_state_after_key,
} from "./source/setup_wizard_flow.mjs";
import {
  text_editor_state_after_key,
  text_editor_state_for,
  windowed_draft_for_display,
} from "./source/single_line_text_editor.mjs";

const maximum_rendered_line_width = 400;
const reading_session_duration_in_minutes = 60;
const minimum_minutes_before_reading_session = 60;
const abstract_characters_shown_in_calendar_details = 400;

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
const confirmation_glyph_style = "\x1b[38;2;120;220;120m";
const crossed_out_glyph_style = "\x1b[38;2;255;110;110m";
const warning_style = "\x1b[38;2;255;110;110m";

const home_files = open_paperman_home_files(paperman_home_directory_path());

const user_interface_state = {
  active_screen: "paper_list",
  setup_wizard: null,
  setup_wizard_completion_resolver: null,
  setup_wizard_scroll_offset: 0,
  settings: home_files.read_settings(),
  daily_selection: null,
  warnings: [],
  paper_list_rows: [],
  selected_arxiv_id: null,
  paper_list_scroll_offset: 0,
  settings_rows: [],
  settings_cursor_index: 0,
  settings_scroll_offset: 0,
  error_details_scroll_offset: 0,
  expanded_category_group_codes: initial_expanded_category_group_codes(home_files.read_settings().tracked_arxiv_category_codes),
  text_input: null,
  status_message: null,
  is_regenerating: false,
  have_tracked_categories_changed: false,
  is_inside_alternate_screen: false,
  is_hard_reset_confirmation_pending: false,
  pending_airtable_sync_arxiv_ids: new Set(),
};

function current_date_iso() {
  const fake_today_iso = process.env.PAPERMAN_FAKE_TODAY?.trim();
  if (fake_today_iso) return fake_today_iso;
  return new Date().toLocaleDateString("en-CA");
}

function openrouter_api_key_in_use() {
  return process.env.OPENROUTER_API_KEY?.trim() || user_interface_state.settings.openrouter_api_key;
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
    read_candidate_pool: home_files.read_candidate_pool,
    write_candidate_pool: home_files.write_candidate_pool,
    fetch_papers_for_category: fetch_arxiv_papers_for_category,
    request_pick: (prompt_text) =>
      request_daily_pick({
        openrouter_api_key: openrouter_api_key_in_use(),
        openrouter_chat_model_id: settings.openrouter_chat_model_id,
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
  user_interface_state.settings_rows = build_settings_rows(user_interface_state.settings, user_interface_state.expanded_category_group_codes);
}

function completed_setup_wizard() {
  user_interface_state.setup_wizard = initial_setup_wizard_state({
    environment_openrouter_api_key: process.env.OPENROUTER_API_KEY?.trim(),
  });
  user_interface_state.active_screen = "setup_wizard";
  render();
  return new Promise((resolve_when_setup_completes) => {
    user_interface_state.setup_wizard_completion_resolver = resolve_when_setup_completes;
  });
}

function handle_setup_wizard_key(typed_character, pressed_key) {
  const wizard_outcome = setup_wizard_state_after_key({
    wizard_state: user_interface_state.setup_wizard,
    typed_character,
    pressed_key,
  });
  if (wizard_outcome.kind === "in_progress") {
    user_interface_state.setup_wizard = wizard_outcome.wizard_state;
    return;
  }
  save_settings_changes({ ...wizard_outcome.draft_settings, has_completed_first_run_setup: true });
  user_interface_state.setup_wizard = null;
  user_interface_state.active_screen = "paper_list";
  user_interface_state.setup_wizard_completion_resolver?.();
  user_interface_state.setup_wizard_completion_resolver = null;
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

function toggle_crossed_out_mark_on_selected_paper() {
  const paper = selected_paper();
  if (!paper) return;
  user_interface_state.status_message = null;
  const marks_by_arxiv_id = user_interface_state.daily_selection.mark_by_arxiv_id;
  const is_already_crossed_out = marks_by_arxiv_id[paper.arxiv_id] === "crossed_out";

  if (is_already_crossed_out) {
    delete marks_by_arxiv_id[paper.arxiv_id];
    home_files.remove_mark(paper.arxiv_id);
    home_files.write_daily_selection(user_interface_state.daily_selection);
    const airtable_record_sync = home_files.read_airtable_record_sync(paper.arxiv_id);
    if (!airtable_record_sync) return;
    remove_crossed_paper_from_airtable({
      airtable_personal_access_token: user_interface_state.settings.airtable_personal_access_token,
      airtable_base_input: user_interface_state.settings.airtable_base_input,
      airtable_record_sync,
    })
      .then((was_removed) => {
        if (!was_removed) return;
        home_files.remove_airtable_record_sync(paper.arxiv_id);
        render();
      })
      .catch((airtable_error) => {
        user_interface_state.status_message = `uncrossed locally · Airtable removal failed: ${airtable_error.message}`;
        render();
      });
    return;
  }

  const crossed_at_iso = new Date().toISOString();
  marks_by_arxiv_id[paper.arxiv_id] = "crossed_out";
  home_files.upsert_mark({
    arxiv_id: paper.arxiv_id,
    title: paper.title,
    abstract_text: paper.abstract_text,
    primary_arxiv_category_code: paper.primary_arxiv_category_code,
    mark_kind: "crossed_out",
    marked_at_iso: crossed_at_iso,
  });
  home_files.write_daily_selection(user_interface_state.daily_selection);
  const configured_airtable_base_id = airtable_base_id_from_input(user_interface_state.settings.airtable_base_input);
  const airtable_record_sync = home_files.read_airtable_record_sync(paper.arxiv_id);
  if (airtable_record_sync?.airtable_base_id === configured_airtable_base_id) return;
  if (user_interface_state.pending_airtable_sync_arxiv_ids.has(paper.arxiv_id)) return;
  user_interface_state.pending_airtable_sync_arxiv_ids.add(paper.arxiv_id);
  append_crossed_paper_to_airtable({
    airtable_personal_access_token: user_interface_state.settings.airtable_personal_access_token,
    airtable_base_input: user_interface_state.settings.airtable_base_input,
    paper,
  })
    .then(async (new_airtable_record_sync) => {
      user_interface_state.pending_airtable_sync_arxiv_ids.delete(paper.arxiv_id);
      if (!new_airtable_record_sync) return;
      if (marks_by_arxiv_id[paper.arxiv_id] !== "crossed_out") {
        await remove_crossed_paper_from_airtable({
          airtable_personal_access_token: user_interface_state.settings.airtable_personal_access_token,
          airtable_base_input: user_interface_state.settings.airtable_base_input,
          airtable_record_sync: new_airtable_record_sync,
        });
        render();
        return;
      }
      home_files.upsert_airtable_record_sync({ arxiv_id: paper.arxiv_id, ...new_airtable_record_sync });
      render();
    })
    .catch((airtable_error) => {
      user_interface_state.pending_airtable_sync_arxiv_ids.delete(paper.arxiv_id);
      user_interface_state.status_message = `crossed locally · Airtable sync failed: ${airtable_error.message}`;
      render();
    });
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
    const indentation_prefix = "  ".repeat(row.indentation_level ?? 0);
    if (is_under_cursor) return `   ${ansi_inverse}${ansi_bold} ${indentation_prefix}${checkbox_glyph} ${row.label} ${ansi_reset}`;
    return `    ${indentation_prefix}${checkbox_glyph} ${row.label}`;
  }

  if (row.type === "category_group") {
    const expansion_glyph = row.is_expanded ? "[-]" : "[+]";
    if (is_under_cursor) return `   ${ansi_inverse}${ansi_bold} ${expansion_glyph} ${row.label} ${ansi_reset}`;
    return `    ${ansi_dim}${expansion_glyph} ${row.label}${ansi_reset}`;
  }

  if (row.type === "hard_reset_action") {
    const confirmation_text = user_interface_state.is_hard_reset_confirmation_pending ? "press again to confirm hard reset" : row.label;
    if (is_under_cursor) return `   ${ansi_inverse}${ansi_bold} ! ${confirmation_text} ${ansi_reset}`;
    return `    ${warning_style}! ${confirmation_text}${ansi_reset}`;
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
  return Math.max(3, (process.stdout.rows || 24) - 2);
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
  const category_change_hint = user_interface_state.have_tracked_categories_changed ? "selection settings changed · press r to refetch · " : "";
  const status_text = user_interface_state.status_message ? `${user_interface_state.status_message} · ` : "";
  return `${warning_text}${category_change_hint}${status_text}`;
}

function wrapped_plain_text_lines(text, maximum_line_width) {
  const words = text.split(/\s+/).filter(Boolean);
  const wrapped_lines = [];
  let current_line = "";
  for (const word of words) {
    const next_line = current_line ? `${current_line} ${word}` : word;
    if (next_line.length <= maximum_line_width || !current_line) {
      current_line = next_line;
      continue;
    }
    wrapped_lines.push(current_line);
    current_line = word;
  }
  if (current_line) wrapped_lines.push(current_line);
  return wrapped_lines;
}

function active_category_heading_in_scrollable_rows(scrollable_rows, scroll_offset) {
  const category_heading_indexes = scrollable_rows.flatMap((row, row_index) => (row.type === "category_heading" ? [row_index] : []));
  const most_recent_heading_index = category_heading_indexes.filter((row_index) => row_index <= scroll_offset).at(-1);
  const next_heading_index = category_heading_indexes.find((row_index) => row_index > scroll_offset);
  const heading_index = most_recent_heading_index ?? next_heading_index;
  if (heading_index === undefined) return null;
  return { heading_index, row: scrollable_rows[heading_index] };
}

function render_paper_list_screen() {
  const terminal_column_count = process.stdout.columns || 80;
  const rows = user_interface_state.paper_list_rows;
  const [application_title_row, ...scrollable_rows] = rows;
  const selected_row_index = selected_paper_row_index(rows, user_interface_state.selected_arxiv_id);
  const selected_scrollable_row_index = Math.max(0, selected_row_index - 1);
  const visible_rows = visible_content_height();
  const active_category_heading = active_category_heading_in_scrollable_rows(
    scrollable_rows,
    user_interface_state.paper_list_scroll_offset
  );
  const scrollable_content_height = Math.max(1, visible_rows - (active_category_heading ? 2 : 1));

  user_interface_state.paper_list_scroll_offset = clamped_scroll_offset({
    scroll_offset: user_interface_state.paper_list_scroll_offset,
    target_row_index: selected_scrollable_row_index,
    row_count: scrollable_rows.length,
    content_height: scrollable_content_height,
  });
  const sticky_category_heading = active_category_heading_in_scrollable_rows(
    scrollable_rows,
    user_interface_state.paper_list_scroll_offset
  );

  const column_widths = paper_list_column_widths(rows);
  const lines = [render_paper_list_row(application_title_row, column_widths, terminal_column_count, false)];
  if (sticky_category_heading) lines.push(render_paper_list_row(sticky_category_heading.row, column_widths, terminal_column_count, false));
  const first_scrollable_row_index = sticky_category_heading && sticky_category_heading.heading_index >= user_interface_state.paper_list_scroll_offset
    ? sticky_category_heading.heading_index + 1
    : user_interface_state.paper_list_scroll_offset;
  for (let visible_row_index = 0; visible_row_index < scrollable_content_height; visible_row_index++) {
    const scrollable_row_index = first_scrollable_row_index + visible_row_index;
    const row = scrollable_rows[scrollable_row_index];
    const absolute_row_index = scrollable_row_index + 1;
    lines.push(row ? render_paper_list_row(row, column_widths, terminal_column_count, absolute_row_index === selected_row_index) : "");
  }

  const reason_text = selected_paper()?.language_model_selection_reason ?? "";
  const reason_footer_line = ` ${ansi_dim}${fit_text_to_width(reason_text ? `↳ ${reason_text}` : "", Math.max(8, terminal_column_count - 2)).trimEnd()}${ansi_reset}`;
  const diagnostics_hint = user_interface_state.warnings.length > 0 ? " · e error details" : "";
  const key_hints = `↑↓ · enter open · x cross read · g calendar · → settings · r refresh${diagnostics_hint} · q`;
  const hints_footer_line = ` ${ansi_dim}${footer_status_text()}${key_hints}${ansi_reset}`;
  write_screen_frame(lines, [reason_footer_line, hints_footer_line]);
}

function render_settings_screen() {
  const terminal_column_count = process.stdout.columns || 80;
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
  const browsing_hints = "↑↓ move · space toggle/edit · ← back";
  const hints_footer_line = ` ${ansi_dim}${footer_status_text()}${user_interface_state.text_input ? editing_hints : browsing_hints}${ansi_reset}`;
  write_screen_frame(lines, ["", hints_footer_line]);
}

function error_details_lines(terminal_column_count) {
  const warning_lines = user_interface_state.warnings.flatMap((warning_text) =>
    wrapped_plain_text_lines(warning_text, Math.max(20, terminal_column_count - 4))
  );
  return [
    ` ${application_title_style}Request diagnostics${ansi_reset}`,
    ` ${tree_spine_style}│${ansi_reset}`,
    ...warning_lines.map((warning_line) => ` ${tree_spine_style}└─${ansi_reset} ${warning_style}${warning_line}${ansi_reset}`),
  ];
}

function render_error_details_screen() {
  const terminal_column_count = process.stdout.columns || 80;
  const content_height = visible_content_height();
  const lines = error_details_lines(terminal_column_count);
  const maximum_scroll_offset = Math.max(0, lines.length - content_height);
  user_interface_state.error_details_scroll_offset = Math.min(user_interface_state.error_details_scroll_offset, maximum_scroll_offset);
  const visible_lines = lines.slice(user_interface_state.error_details_scroll_offset, user_interface_state.error_details_scroll_offset + content_height);
  while (visible_lines.length < content_height) visible_lines.push("");
  write_screen_frame(visible_lines, ["", ` ${ansi_dim}↑↓ scroll · e/esc/← back · q quit${ansi_reset}`]);
}

const wizard_step_glyph_by_state = {
  completed: `${confirmation_glyph_style}✓${ansi_reset}`,
  active: `${application_title_style}●${ansi_reset}`,
  pending: `${tree_spine_style}○${ansi_reset}`,
};

function render_wizard_child_prefix(is_under_last_step) {
  return is_under_last_step ? "      " : ` ${tree_spine_style}│${ansi_reset}    `;
}

function render_wizard_text_input_row(row, terminal_column_count) {
  const editor_state = row.text_editor_state;
  const editor_width = Math.max(12, terminal_column_count - 14);
  const { visible_text, cursor_position_in_visible_text } = windowed_draft_for_display({
    draft_text: editor_state.draft_text,
    cursor_position: editor_state.cursor_position,
    maximum_width: editor_width,
  });
  const text_before_cursor = visible_text.slice(0, cursor_position_in_visible_text);
  const character_under_cursor = visible_text[cursor_position_in_visible_text] ?? " ";
  const text_after_cursor = visible_text.slice(cursor_position_in_visible_text + 1);
  return (
    render_wizard_child_prefix(row.is_under_last_step) +
    `${section_heading_style}▸${ansi_reset} ${text_before_cursor}${ansi_inverse}${character_under_cursor}${ansi_reset}${text_after_cursor}`
  );
}

function render_setup_wizard_row(row, terminal_column_count) {
  if (row.type === "wizard_title") return ` ${application_title_style}${row.text}${ansi_reset}`;
  if (row.type === "spine") return ` ${tree_spine_style}│${ansi_reset}`;

  if (row.type === "wizard_step") {
    const branch_glyph = row.is_last_step ? "└─" : "├─";
    const label_style = row.step_state === "active" ? `${ansi_bold}` : row.step_state === "pending" ? ansi_dim : "";
    const summary_cell = row.summary_text ? `  ${ansi_dim}${row.summary_text}${ansi_reset}` : "";
    return (
      ` ${tree_spine_style}${branch_glyph}${ansi_reset} ${wizard_step_glyph_by_state[row.step_state]} ` +
      `${label_style}${fit_text_to_width(row.label, 14)}${ansi_reset}${summary_cell}`
    );
  }

  if (row.type === "wizard_category_option") {
    const checkbox_glyph = row.is_tracked ? "[x]" : "[ ]";
    if (row.is_under_cursor) {
      return `${render_wizard_child_prefix(row.is_under_last_step)}${ansi_inverse}${ansi_bold} ${"  ".repeat(row.indentation_level ?? 0)}${checkbox_glyph} ${row.label} ${ansi_reset}`;
    }
    return `${render_wizard_child_prefix(row.is_under_last_step)} ${"  ".repeat(row.indentation_level ?? 0)}${checkbox_glyph} ${row.label}`;
  }

  if (row.type === "wizard_category_group") {
    const expansion_glyph = row.is_expanded ? "[-]" : "[+]";
    if (row.is_under_cursor) return `${render_wizard_child_prefix(row.is_under_last_step)}${ansi_inverse}${ansi_bold} ${expansion_glyph} ${row.label} ${ansi_reset}`;
    return `${render_wizard_child_prefix(row.is_under_last_step)} ${ansi_dim}${expansion_glyph} ${row.label}${ansi_reset}`;
  }

  if (row.type === "wizard_continue_option") {
    if (row.is_under_cursor) {
      return `${render_wizard_child_prefix(row.is_under_last_step)}${ansi_inverse}${ansi_bold} → continue ${ansi_reset}`;
    }
    return `${render_wizard_child_prefix(row.is_under_last_step)} ${ansi_dim}→ continue${ansi_reset}`;
  }

  if (row.type === "wizard_text_input") return render_wizard_text_input_row(row, terminal_column_count);
  return "";
}

function wizard_scroll_target_row_index(rows) {
  const cursor_row_index = rows.findIndex((row) => row.is_under_cursor);
  if (cursor_row_index !== -1) return cursor_row_index;
  return rows.findIndex((row) => row.type === "wizard_step" && row.step_state === "active");
}

function render_setup_wizard_screen() {
  const terminal_column_count = process.stdout.columns || 80;
  const content_height = visible_content_height();
  const rows = build_setup_wizard_rows(user_interface_state.setup_wizard);

  user_interface_state.setup_wizard_scroll_offset = clamped_scroll_offset({
    scroll_offset: user_interface_state.setup_wizard_scroll_offset,
    target_row_index: wizard_scroll_target_row_index(rows),
    row_count: rows.length,
    content_height,
  });

  const lines = [];
  for (let visible_row_index = 0; visible_row_index < content_height; visible_row_index++) {
    const row = rows[user_interface_state.setup_wizard_scroll_offset + visible_row_index];
    lines.push(row ? render_setup_wizard_row(row, terminal_column_count) : "");
  }

  const validation_message = user_interface_state.setup_wizard.validation_message;
  const validation_footer_line = validation_message ? ` ${warning_style}${validation_message}${ansi_reset}` : "";
  const hint_text = active_setup_wizard_step(user_interface_state.setup_wizard).hint_text;
  const hints_footer_line = ` ${ansi_dim}${hint_text} · esc back · ctrl+c quit${ansi_reset}`;
  write_screen_frame(lines, [validation_footer_line, hints_footer_line]);
}

function render_loading_screen() {
  const status_text = user_interface_state.status_message ?? "starting…";
  const lines = [
    ` ${application_title_style}📮 paperman${ansi_reset}`,
    ` ${tree_spine_style}│${ansi_reset}`,
    ` ${tree_spine_style}└─${ansi_reset} ${ansi_dim}${status_text}${ansi_reset}`,
  ];
  write_screen_frame(lines, ["", ` ${ansi_dim}assembling today's delivery · ctrl+c quit${ansi_reset}`]);
}

function render() {
  if (!user_interface_state.is_inside_alternate_screen) return;
  if (user_interface_state.active_screen === "setup_wizard") {
    render_setup_wizard_screen();
    return;
  }
  if (user_interface_state.active_screen === "settings") {
    render_settings_screen();
    return;
  }
  if (user_interface_state.active_screen === "error_details") {
    render_error_details_screen();
    return;
  }
  if (!user_interface_state.daily_selection) {
    render_loading_screen();
    return;
  }
  render_paper_list_screen();
}

function open_settings_screen() {
  user_interface_state.expanded_category_group_codes = initial_expanded_category_group_codes(user_interface_state.settings.tracked_arxiv_category_codes);
  user_interface_state.settings_rows = build_settings_rows(user_interface_state.settings, user_interface_state.expanded_category_group_codes);
  user_interface_state.settings_cursor_index = nearest_interactive_settings_row_index(user_interface_state.settings_rows, 0);
  user_interface_state.active_screen = "settings";
}

function close_settings_screen() {
  user_interface_state.active_screen = "paper_list";
  if (user_interface_state.have_tracked_categories_changed) regenerate_daily_selection();
}

function open_error_details_screen() {
  if (user_interface_state.warnings.length === 0) return;
  user_interface_state.error_details_scroll_offset = 0;
  user_interface_state.active_screen = "error_details";
}

function close_error_details_screen() {
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
  if (row.type === "category_group") {
    user_interface_state.expanded_category_group_codes = expanded_category_group_codes_after_toggle(user_interface_state.expanded_category_group_codes, row.archive_code);
    user_interface_state.settings_rows = build_settings_rows(user_interface_state.settings, user_interface_state.expanded_category_group_codes);
    user_interface_state.settings_cursor_index = nearest_interactive_settings_row_index(user_interface_state.settings_rows, user_interface_state.settings_cursor_index);
    return;
  }
  if (row.type === "category_checkbox") {
    toggle_tracked_category(row.arxiv_category_code);
    return;
  }
  if (row.type === "hard_reset_action") {
    if (!user_interface_state.is_hard_reset_confirmation_pending) {
      user_interface_state.is_hard_reset_confirmation_pending = true;
      user_interface_state.status_message = "press again to confirm hard reset";
      return;
    }
    home_files.reset_all();
    user_interface_state.settings = home_files.read_settings();
    user_interface_state.daily_selection = null;
    user_interface_state.paper_list_rows = [];
    user_interface_state.warnings = [];
    user_interface_state.is_hard_reset_confirmation_pending = false;
    user_interface_state.status_message = null;
    completed_setup_wizard();
    user_interface_state.setup_wizard_completion_resolver = () => regenerate_daily_selection();
    return;
  }
  user_interface_state.text_input = {
    setting_key: row.setting_key,
    editor_state: text_editor_state_for({ setting_key: row.setting_key, initial_text: row.current_text }),
  };
}

function commit_text_input(editor_state) {
  const committed_text = editor_state.draft_text.trim();
  if (editor_state.setting_key === "papers_per_category_per_day") {
    const parsed_count = Number.parseInt(committed_text, 10);
    if (!Number.isInteger(parsed_count) || parsed_count < 1) {
      user_interface_state.status_message = "papers per category must be a whole number of 1 or more";
      return;
    }
    save_settings_changes({ papers_per_category_per_day: parsed_count });
    user_interface_state.have_tracked_categories_changed = true;
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
  if (pressed_key.name === "left" || pressed_key.name === "s" || pressed_key.name === "escape" || pressed_key.name === "q") close_settings_screen();
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
  if (pressed_key.name === "x") toggle_crossed_out_mark_on_selected_paper();
  if (pressed_key.name === "g") open_reading_session_calendar_link();
  if (pressed_key.name === "right" || pressed_key.name === "s") open_settings_screen();
  if (pressed_key.name === "r") regenerate_daily_selection();
  if (pressed_key.name === "e") open_error_details_screen();
}

function handle_error_details_key(pressed_key) {
  if (pressed_key.name === "q") quit();
  if (pressed_key.name === "up" || pressed_key.name === "k") {
    user_interface_state.error_details_scroll_offset = Math.max(0, user_interface_state.error_details_scroll_offset - 1);
  }
  if (pressed_key.name === "down" || pressed_key.name === "j") {
    const error_detail_lines = error_details_lines(process.stdout.columns || 80);
    user_interface_state.error_details_scroll_offset = Math.min(
      Math.max(0, error_detail_lines.length - visible_content_height()),
      user_interface_state.error_details_scroll_offset + 1
    );
  }
  if (pressed_key.name === "e" || pressed_key.name === "escape" || pressed_key.name === "left") close_error_details_screen();
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

function handle_keypress(typed_character, pressed_key) {
  if (!pressed_key) return;
  if (pressed_key.ctrl && pressed_key.name === "c") quit();
  if (user_interface_state.active_screen === "setup_wizard") {
    handle_setup_wizard_key(typed_character, pressed_key);
    render();
    return;
  }
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
  if (user_interface_state.active_screen === "error_details") {
    handle_error_details_key(pressed_key);
    render();
    return;
  }
  handle_paper_list_key(pressed_key);
  render();
}

async function main() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("paperman needs an interactive terminal.");
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", handle_keypress);
  process.stdout.on("resize", render);
  process.on("SIGTERM", () => quit());
  enter_alternate_screen();

  if (!user_interface_state.settings.has_completed_first_run_setup) await completed_setup_wizard();
  render();

  try {
    apply_daily_selection_result(await generate_daily_selection({ force_regeneration: false }));
  } catch (generation_error) {
    leave_alternate_screen();
    console.error(`❌ ${generation_error.message}`);
    console.error("Check your connection and OpenRouter key (settings screen, .env, or OPENROUTER_API_KEY).");
    process.exit(1);
  }
  render();
}

main();
