import Conf from "conf";
import { homedir } from "node:os";
import { join } from "node:path";

export const default_settings = {
  tracked_arxiv_category_codes: ["physics", "cs.RO", "cs.LG"],
  papers_per_category_per_day: 10,
  interests_blurb_text: "",
  reading_intent_blurb_text: "",
  openrouter_api_key: "",
  airtable_personal_access_token: "",
  airtable_base_input: "",
  openrouter_chat_model_id: "deepseek/deepseek-v4-flash",
  has_completed_first_run_setup: false,
};

const maximum_marked_papers_kept_in_history = 1000;
const maximum_candidate_pool_age_in_days = 21;

export function paperman_home_directory_path() {
  return process.env.PAPERMAN_HOME || join(homedir(), ".paperman");
}

export function pruned_mark_history(marked_papers_by_arxiv_id) {
  const marked_paper_entries_newest_first = Object.entries(marked_papers_by_arxiv_id).sort(
    ([, first_marked_paper], [, second_marked_paper]) =>
      String(second_marked_paper.marked_at_iso).localeCompare(String(first_marked_paper.marked_at_iso))
  );

  const kept_entries = marked_paper_entries_newest_first.slice(0, maximum_marked_papers_kept_in_history);

  return Object.fromEntries(kept_entries);
}

export function pruned_candidate_pool(candidate_papers_by_arxiv_id, current_date_iso) {
  const current_date = new Date(`${current_date_iso}T12:00:00Z`);
  return Object.fromEntries(
    Object.entries(candidate_papers_by_arxiv_id).filter(([, pooled_paper]) => {
      const first_seen_date = new Date(`${pooled_paper.first_seen_date_iso}T12:00:00Z`);
      const age_in_days = Math.floor((current_date - first_seen_date) / 86_400_000);
      return Number.isFinite(age_in_days) && age_in_days <= maximum_candidate_pool_age_in_days;
    })
  );
}

export function open_paperman_home_files(home_directory_path) {
  const conf_store_named = (store_name) =>
    new Conf({ cwd: home_directory_path, configName: store_name, projectName: "paperman" });

  const settings_store = conf_store_named("settings");
  const daily_selection_store = conf_store_named("daily_selection");
  const mark_history_store = conf_store_named("mark_history");
  const candidate_pool_store = conf_store_named("candidate_pool");
  const airtable_sync_store = conf_store_named("airtable_sync");

  const read_mark_history = () => mark_history_store.get("marked_papers_by_arxiv_id", {});
  const read_airtable_record_syncs = () => airtable_sync_store.get("record_sync_by_arxiv_id", {});

  return {
    read_settings: () => ({ ...default_settings, ...settings_store.store }),
    write_settings: (settings_changes) => settings_store.set(settings_changes),
    read_daily_selection: () => {
      const stored_daily_selection = { ...daily_selection_store.store };
      if (!stored_daily_selection.selection_date_iso) return null;
      return stored_daily_selection;
    },
    write_daily_selection: (daily_selection) => {
      daily_selection_store.clear();
      daily_selection_store.set(daily_selection);
    },
    read_mark_history,
    upsert_mark: (marked_paper) => {
      const marked_papers_by_arxiv_id = {
        ...read_mark_history(),
        [marked_paper.arxiv_id]: marked_paper,
      };
      mark_history_store.set("marked_papers_by_arxiv_id", pruned_mark_history(marked_papers_by_arxiv_id));
    },
    remove_mark: (arxiv_id) => {
      const marked_papers_by_arxiv_id = { ...read_mark_history() };
      delete marked_papers_by_arxiv_id[arxiv_id];
      mark_history_store.set("marked_papers_by_arxiv_id", marked_papers_by_arxiv_id);
    },
    read_airtable_record_sync: (arxiv_id) => read_airtable_record_syncs()[arxiv_id] ?? null,
    upsert_airtable_record_sync: ({ arxiv_id, airtable_base_id, airtable_record_id }) => {
      airtable_sync_store.set("record_sync_by_arxiv_id", {
        ...read_airtable_record_syncs(),
        [arxiv_id]: { airtable_base_id, airtable_record_id },
      });
    },
    remove_airtable_record_sync: (arxiv_id) => {
      const record_sync_by_arxiv_id = { ...read_airtable_record_syncs() };
      delete record_sync_by_arxiv_id[arxiv_id];
      airtable_sync_store.set("record_sync_by_arxiv_id", record_sync_by_arxiv_id);
    },
    read_candidate_pool: () => candidate_pool_store.get("papers_by_arxiv_id", {}),
    write_candidate_pool: (candidate_papers_by_arxiv_id, current_date_iso) => {
      candidate_pool_store.clear();
      candidate_pool_store.set("papers_by_arxiv_id", pruned_candidate_pool(candidate_papers_by_arxiv_id, current_date_iso));
    },
    reset_all: () => {
      settings_store.clear();
      daily_selection_store.clear();
      mark_history_store.clear();
      candidate_pool_store.clear();
      airtable_sync_store.clear();
    },
  };
}
