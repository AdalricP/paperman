import Conf from "conf";
import { homedir } from "node:os";
import { join } from "node:path";

export const default_settings = {
  tracked_arxiv_category_codes: ["physics", "cs.RO", "cs.LG"],
  interests_blurb_text: "",
  reading_intent_blurb_text: "",
  fireworks_api_key: "",
  fireworks_chat_model_id: "accounts/fireworks/models/glm-5p2",
  fireworks_embedding_model_id: "fireworks/qwen3-embedding-8b",
  has_completed_first_run_setup: false,
};

const maximum_marked_papers_kept_in_history = 1000;
const maximum_marked_papers_kept_with_embedding_vectors = 400;

export function paperman_home_directory_path() {
  return process.env.PAPERMAN_HOME || join(homedir(), ".paperman");
}

export function pruned_mark_history(marked_papers_by_arxiv_id) {
  const marked_paper_entries_newest_first = Object.entries(marked_papers_by_arxiv_id).sort(
    ([, first_marked_paper], [, second_marked_paper]) =>
      String(second_marked_paper.marked_at_iso).localeCompare(String(first_marked_paper.marked_at_iso))
  );

  const kept_entries = marked_paper_entries_newest_first
    .slice(0, maximum_marked_papers_kept_in_history)
    .map(([arxiv_id, marked_paper], recency_rank) => {
      if (recency_rank < maximum_marked_papers_kept_with_embedding_vectors) return [arxiv_id, marked_paper];
      return [arxiv_id, { ...marked_paper, abstract_embedding_vector: null }];
    });

  return Object.fromEntries(kept_entries);
}

export function open_paperman_home_files(home_directory_path) {
  const conf_store_named = (store_name) =>
    new Conf({ cwd: home_directory_path, configName: store_name, projectName: "paperman" });

  const settings_store = conf_store_named("settings");
  const daily_selection_store = conf_store_named("daily_selection");
  const mark_history_store = conf_store_named("mark_history");

  const read_mark_history = () => mark_history_store.get("marked_papers_by_arxiv_id", {});

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
  };
}
