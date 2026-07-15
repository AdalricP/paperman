import { category_tree_rows, initial_expanded_category_group_codes } from "./category_tree_model.mjs";
import { display_name_for_arxiv_category_code } from "./arxiv_category_catalog.mjs";

export function fit_text_to_width(text, width) {
  if (text.length > width) return text.slice(0, Math.max(0, width - 1)) + "…";
  return text.padEnd(width);
}

export function weekday_day_month_label(date_iso) {
  const parsed_date = new Date(`${date_iso}T12:00:00`);
  if (Number.isNaN(parsed_date.getTime())) return date_iso;
  return parsed_date.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

function application_title_text(daily_selection) {
  const selection_day_label = weekday_day_month_label(daily_selection.selection_date_iso);
  const announcement_date_iso = daily_selection.arxiv_announcement_date_iso;
  if (!announcement_date_iso || announcement_date_iso === daily_selection.selection_date_iso) return `paperman · ${selection_day_label}`;
  return `paperman · ${selection_day_label} · announced ${weekday_day_month_label(announcement_date_iso)}`;
}

function papers_grouped_by_source_feed_category(selected_papers) {
  const papers_by_category_code = new Map();
  for (const selected_paper of selected_papers) {
    const category_code = selected_paper.source_feed_category_code ?? selected_paper.primary_arxiv_category_code ?? "unknown";
    if (!papers_by_category_code.has(category_code)) papers_by_category_code.set(category_code, []);
    papers_by_category_code.get(category_code).push(selected_paper);
  }
  return [...papers_by_category_code.entries()].sort(([first_category_code], [second_category_code]) =>
    display_name_for_arxiv_category_code(first_category_code).localeCompare(display_name_for_arxiv_category_code(second_category_code))
  );
}

export function build_paper_list_rows(daily_selection) {
  const rows = [{ type: "application_title", text: application_title_text(daily_selection) }];
  const category_groups = papers_grouped_by_source_feed_category(daily_selection.selected_papers);
  for (const [group_index, [category_code, category_papers]] of category_groups.entries()) {
    const is_last_category = group_index === category_groups.length - 1;
    const category_display_name = display_name_for_arxiv_category_code(category_code);
    rows.push({ type: "spine" });
    rows.push({ type: "category_heading", text: category_display_name === category_code ? category_code : `${category_code} — ${category_display_name}`, is_last_category });
    rows.push(...category_papers.map((paper) => ({ type: "paper", paper, is_under_last_category: is_last_category })));
  }
  if (category_groups.length === 0) rows.push({ type: "spine", text: "no papers selected today" });
  return rows;
}

export function paper_row_indexes(rows) {
  return rows.flatMap((row, row_index) => (row.type === "paper" ? [row_index] : []));
}

export function selected_paper_row_index(rows, selected_arxiv_id) {
  const paper_row_indexes_in_rows = paper_row_indexes(rows);
  return paper_row_indexes_in_rows.find((row_index) => rows[row_index].paper.arxiv_id === selected_arxiv_id) ?? paper_row_indexes_in_rows[0] ?? -1;
}

export function arxiv_id_after_selection_move(rows, selected_arxiv_id, step_in_rows) {
  const paper_row_indexes_in_rows = paper_row_indexes(rows);
  if (paper_row_indexes_in_rows.length === 0) return null;
  const current_position = paper_row_indexes_in_rows.indexOf(selected_paper_row_index(rows, selected_arxiv_id));
  const next_position = Math.min(paper_row_indexes_in_rows.length - 1, Math.max(0, current_position + step_in_rows));
  return rows[paper_row_indexes_in_rows[next_position]].paper.arxiv_id;
}

const editable_text_settings = [
  { setting_key: "interests_blurb_text", label: "Interests", is_masked: false },
  { setting_key: "reading_intent_blurb_text", label: "Goal", is_masked: false },
  { setting_key: "papers_per_category_per_day", label: "Papers per category", is_masked: false },
  { setting_key: "openrouter_api_key", label: "OpenRouter key", is_masked: true },
  { setting_key: "airtable_personal_access_token", label: "Airtable token", is_masked: true },
  { setting_key: "airtable_base_input", label: "Airtable base URL or ID", is_masked: false },
];

export function build_settings_rows(settings, expanded_category_group_codes = initial_expanded_category_group_codes(settings.tracked_arxiv_category_codes)) {
  const text_setting_row = ({ setting_key, label, is_masked }) => ({ type: "text_setting", setting_key, label, is_masked, current_text: String(settings[setting_key] ?? "") });
  return [
    { type: "screen_title", text: "Settings" },
    { type: "blank" },
    { type: "section_heading", text: "Tracked categories" },
    ...category_tree_rows({ tracked_arxiv_category_codes: settings.tracked_arxiv_category_codes, expanded_category_group_codes }),
    { type: "blank" },
    { type: "section_heading", text: "Relevance" },
    ...editable_text_settings.slice(0, 3).map(text_setting_row),
    { type: "blank" },
    { type: "section_heading", text: "API" },
    ...editable_text_settings.slice(3).map(text_setting_row),
    { type: "blank" },
    { type: "section_heading", text: "Danger" },
    { type: "hard_reset_action", label: "hard reset…" },
  ];
}

const interactive_settings_row_types = new Set(["category_group", "category_checkbox", "text_setting", "hard_reset_action"]);

export function interactive_settings_row_indexes(rows) {
  return rows.flatMap((row, row_index) => (interactive_settings_row_types.has(row.type) ? [row_index] : []));
}

export function nearest_interactive_settings_row_index(rows, cursor_index) {
  const interactive_row_indexes = interactive_settings_row_indexes(rows);
  if (interactive_row_indexes.length === 0) return 0;
  if (interactive_row_indexes.includes(cursor_index)) return cursor_index;
  return interactive_row_indexes.reduce((closest_row_index, candidate_row_index) =>
    Math.abs(candidate_row_index - cursor_index) < Math.abs(closest_row_index - cursor_index) ? candidate_row_index : closest_row_index
  );
}

export function settings_cursor_index_after_move(rows, cursor_index, step_in_rows) {
  const interactive_row_indexes = interactive_settings_row_indexes(rows);
  if (interactive_row_indexes.length === 0) return 0;
  const current_position = interactive_row_indexes.indexOf(nearest_interactive_settings_row_index(rows, cursor_index));
  return interactive_row_indexes[Math.min(interactive_row_indexes.length - 1, Math.max(0, current_position + step_in_rows))];
}

export function masked_api_key_text(api_key_text) {
  if (!api_key_text) return "(not set)";
  return `${api_key_text.slice(0, 6)}…`;
}
