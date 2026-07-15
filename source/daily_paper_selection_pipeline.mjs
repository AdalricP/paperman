import { build_daily_pick_prompt, validate_daily_pick_response } from "./model_provider_api.mjs";

const maximum_candidate_papers_considered = 600;
const minimum_candidates_per_category_sent_to_language_model = 8;
const recency_score_full_age_in_days = 14;

function papers_in_round_robin_across_categories({ papers, maximum_count }) {
  const papers_by_category_code = new Map();
  for (const paper of papers) {
    const category_code = paper.source_feed_category_code ?? paper.primary_arxiv_category_code;
    if (!papers_by_category_code.has(category_code)) papers_by_category_code.set(category_code, []);
    papers_by_category_code.get(category_code).push(paper);
  }
  const category_queues = [...papers_by_category_code.values()];
  const round_robin_papers = [];
  let queue_cursor = 0;
  while (round_robin_papers.length < Math.min(maximum_count, papers.length)) {
    const category_queue = category_queues[queue_cursor % category_queues.length];
    queue_cursor++;
    if (category_queue.length === 0) continue;
    round_robin_papers.push(category_queue.shift());
  }
  return round_robin_papers;
}

export function sanitized_papers_per_category_per_day(papers_per_category_per_day) {
  const parsed_count = Number.parseInt(papers_per_category_per_day, 10);
  if (!Number.isInteger(parsed_count) || parsed_count < 1) return 10;
  return parsed_count;
}

export function merged_papers_across_feeds(feed_results) {
  const papers_by_arxiv_id = new Map();
  for (const feed_result of feed_results) {
    for (const paper of feed_result.papers) {
      const already_seen_paper = papers_by_arxiv_id.get(paper.arxiv_id);
      if (!already_seen_paper) {
        papers_by_arxiv_id.set(paper.arxiv_id, paper);
        continue;
      }
      const merged_category_codes = new Set([...already_seen_paper.arxiv_category_codes, ...paper.arxiv_category_codes]);
      papers_by_arxiv_id.set(paper.arxiv_id, { ...already_seen_paper, arxiv_category_codes: [...merged_category_codes] });
    }
  }
  return [...papers_by_arxiv_id.values()];
}

async function fetched_candidate_papers({ tracked_arxiv_category_codes, fetch_papers_for_category, crossed_out_arxiv_ids }) {
  const feed_settlements = await Promise.allSettled(
    tracked_arxiv_category_codes.map((arxiv_category_code) => fetch_papers_for_category(arxiv_category_code))
  );

  const feed_warnings = feed_settlements.flatMap((feed_settlement, category_index) => {
    if (feed_settlement.status === "fulfilled") return [];
    return [`${tracked_arxiv_category_codes[category_index]}: ${feed_settlement.reason.message}`];
  });
  const successful_feed_results = feed_settlements.flatMap((feed_settlement, category_index) => {
    if (feed_settlement.status !== "fulfilled") return [];
    return [
      {
        announcement_date_iso: feed_settlement.value.announcement_date_iso,
        papers: feed_settlement.value.papers.map((paper) => ({
          ...paper,
          source_feed_category_code: tracked_arxiv_category_codes[category_index],
        })),
      },
    ];
  });
  if (successful_feed_results.length === 0) {
    throw new Error(`Every tracked arXiv feed failed: ${feed_warnings.join(" · ")}`);
  }

  const announcement_date_iso = successful_feed_results
    .map((feed_result) => feed_result.announcement_date_iso)
    .filter(Boolean)
    .sort()
    .at(-1);

  const uncrossed_papers = merged_papers_across_feeds(successful_feed_results).filter(
    (paper) => !crossed_out_arxiv_ids.has(paper.arxiv_id)
  );
  const candidate_papers = papers_in_round_robin_across_categories({
    papers: uncrossed_papers,
    maximum_count: maximum_candidate_papers_considered,
  });

  return { candidate_papers, announcement_date_iso, feed_warnings };
}

function age_in_days_since_first_seen(first_seen_date_iso, current_date_iso) {
  const first_seen_date = new Date(`${first_seen_date_iso}T12:00:00Z`);
  const current_date = new Date(`${current_date_iso}T12:00:00Z`);
  return Math.max(0, Math.floor((current_date - first_seen_date) / 86_400_000));
}

export function candidate_pool_after_merging_fetched_papers({ existing_candidate_papers_by_arxiv_id, fetched_candidate_papers, current_date_iso }) {
  const candidate_papers_by_arxiv_id = { ...existing_candidate_papers_by_arxiv_id };
  for (const fetched_candidate_paper of fetched_candidate_papers) {
    const existing_pooled_paper = candidate_papers_by_arxiv_id[fetched_candidate_paper.arxiv_id];
    candidate_papers_by_arxiv_id[fetched_candidate_paper.arxiv_id] = {
      ...fetched_candidate_paper,
      first_seen_date_iso: existing_pooled_paper?.first_seen_date_iso ?? current_date_iso,
    };
  }
  return candidate_papers_by_arxiv_id;
}

function candidate_papers_with_recency({ candidate_papers_by_arxiv_id, current_date_iso, excluded_arxiv_ids }) {
  return Object.values(candidate_papers_by_arxiv_id)
    .filter((candidate_paper) => !excluded_arxiv_ids.has(candidate_paper.arxiv_id))
    .map((candidate_paper) => {
      const age_in_days = age_in_days_since_first_seen(candidate_paper.first_seen_date_iso, current_date_iso);
      return { ...candidate_paper, age_in_days, recency_score: Math.max(0, 1 - age_in_days / recency_score_full_age_in_days) };
    });
}

function papers_ranked_by_recency(candidate_papers) {
  return [...candidate_papers].sort((first_paper, second_paper) => second_paper.recency_score - first_paper.recency_score);
}

function pruned_by_category({ ordered_papers, papers_per_category_per_day }) {
  const per_category_cap = Math.max(minimum_candidates_per_category_sent_to_language_model, papers_per_category_per_day * 4);
  const kept_count_by_category = new Map();
  const pruned_papers = [];

  for (const paper of ordered_papers) {
    const category_code = paper.source_feed_category_code;
    const kept_count = kept_count_by_category.get(category_code) ?? 0;
    if (kept_count >= per_category_cap) continue;
    kept_count_by_category.set(category_code, kept_count + 1);
    pruned_papers.push(paper);
  }

  return { pruned_papers };
}

function recency_ranked_candidates({ candidate_papers, papers_per_category_per_day }) {
  const { pruned_papers } = pruned_by_category({
    ordered_papers: papers_ranked_by_recency(candidate_papers),
    papers_per_category_per_day,
  });
  return { pruned_papers };
}

export function selection_targets_for_candidates({ pruned_papers, papers_per_category_per_day }) {
  const candidate_count_by_category = new Map();
  for (const paper of pruned_papers) {
    const category_code = paper.source_feed_category_code;
    candidate_count_by_category.set(category_code, (candidate_count_by_category.get(category_code) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...candidate_count_by_category.entries()].map(([category_code, candidate_count]) => [
      category_code,
      Math.min(papers_per_category_per_day, candidate_count),
    ])
  );
}

function fallback_picks({ pruned_papers, selection_target_by_category_code }) {
  const fallback_reason = "picked in recency order (model unavailable)";
  const remaining_target_by_category = { ...selection_target_by_category_code };
  return pruned_papers.flatMap((pruned_paper) => {
    const category_code = pruned_paper.source_feed_category_code;
    if ((remaining_target_by_category[category_code] ?? 0) === 0) return [];
    remaining_target_by_category[category_code] -= 1;
    return [{ arxiv_id: pruned_paper.arxiv_id, selection_reason: fallback_reason }];
  });
}

async function language_model_selection({
  settings,
  pruned_papers,
  selection_target_by_category_code,
  request_pick,
  report_progress,
}) {
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: settings.tracked_arxiv_category_codes,
    interests_blurb_text: settings.interests_blurb_text,
    reading_intent_blurb_text: settings.reading_intent_blurb_text,
    candidate_papers: pruned_papers,
    selection_target_by_category_code,
  });

  for (const attempt_number of [1, 2]) {
    try {
      report_progress(attempt_number === 1 ? "asking the model for today's picks…" : "retrying the model once…");
      const response_text = await request_pick(prompt_text);
      const validated_picks = validate_daily_pick_response({
        response_text,
        candidate_papers: pruned_papers,
        selection_target_by_category_code,
      });
      return { validated_picks, selection_warning: null };
    } catch (selection_error) {
      if (attempt_number === 2) {
        return {
          validated_picks: fallback_picks({ pruned_papers, selection_target_by_category_code }),
          selection_warning: `model pick failed, used local ranking: ${selection_error.message}`,
        };
      }
    }
  }
}

function frozen_daily_selection({
  current_date_iso,
  announcement_date_iso,
  validated_picks,
  pruned_papers,
  previous_marks_by_arxiv_id,
}) {
  const pruned_paper_by_arxiv_id = new Map(pruned_papers.map((pruned_paper) => [pruned_paper.arxiv_id, pruned_paper]));
  const selected_papers = validated_picks.map((validated_pick) => ({
    ...pruned_paper_by_arxiv_id.get(validated_pick.arxiv_id),
    language_model_selection_reason: validated_pick.selection_reason,
  }));

  const selected_arxiv_ids = new Set(selected_papers.map((selected_paper) => selected_paper.arxiv_id));
  const carried_over_marks = Object.fromEntries(
    Object.entries(previous_marks_by_arxiv_id).filter(([arxiv_id]) => selected_arxiv_ids.has(arxiv_id))
  );

  return {
    selection_date_iso: current_date_iso,
    arxiv_announcement_date_iso: announcement_date_iso ?? null,
    selected_papers,
    mark_by_arxiv_id: carried_over_marks,
  };
}

export async function daily_paper_selection_for_date({
  current_date_iso,
  force_regeneration,
  settings,
  read_daily_selection,
  write_daily_selection,
  read_mark_history,
  read_candidate_pool = () => ({}),
  write_candidate_pool = () => {},
  fetch_papers_for_category,
  request_pick,
  report_progress,
}) {
  const existing_daily_selection = read_daily_selection();
  const is_frozen_for_today = existing_daily_selection?.selection_date_iso === current_date_iso;
  if (is_frozen_for_today && !force_regeneration) {
    return { daily_selection: existing_daily_selection, warnings: [] };
  }

  report_progress("fetching arXiv feeds…");
  const marked_papers_by_arxiv_id = read_mark_history();
  const crossed_out_arxiv_ids = new Set(
    Object.values(marked_papers_by_arxiv_id)
      .filter((marked_paper) => marked_paper.mark_kind === "crossed_out")
      .map((marked_paper) => marked_paper.arxiv_id)
  );
  const { candidate_papers, announcement_date_iso, feed_warnings } = await fetched_candidate_papers({
    tracked_arxiv_category_codes: settings.tracked_arxiv_category_codes,
    fetch_papers_for_category,
    crossed_out_arxiv_ids,
  });
  const currently_selected_arxiv_ids = new Set(existing_daily_selection?.selected_papers?.map((selected_paper) => selected_paper.arxiv_id) ?? []);
  const candidate_papers_by_arxiv_id = candidate_pool_after_merging_fetched_papers({
    existing_candidate_papers_by_arxiv_id: read_candidate_pool(),
    fetched_candidate_papers: candidate_papers,
    current_date_iso,
  });
  const pooled_candidate_papers = candidate_papers_with_recency({
    candidate_papers_by_arxiv_id,
    current_date_iso,
    excluded_arxiv_ids: new Set([...crossed_out_arxiv_ids, ...currently_selected_arxiv_ids]),
  });
  const round_robin_candidate_papers = papers_in_round_robin_across_categories({
    papers: pooled_candidate_papers,
    maximum_count: maximum_candidate_papers_considered,
  });
  if (round_robin_candidate_papers.length === 0) {
    throw new Error("No uncrossed papers in any tracked feed today");
  }

  const papers_per_category_per_day = sanitized_papers_per_category_per_day(settings.papers_per_category_per_day);
  const { pruned_papers } = recency_ranked_candidates({
    candidate_papers: round_robin_candidate_papers,
    papers_per_category_per_day,
  });

  const selection_target_by_category_code = selection_targets_for_candidates({ pruned_papers, papers_per_category_per_day });
  const { validated_picks, selection_warning } = await language_model_selection({
    settings,
    pruned_papers,
    selection_target_by_category_code,
    request_pick,
    report_progress,
  });

  const daily_selection = frozen_daily_selection({
    current_date_iso,
    announcement_date_iso,
    validated_picks,
    pruned_papers,
    previous_marks_by_arxiv_id: is_frozen_for_today ? existing_daily_selection.mark_by_arxiv_id ?? {} : {},
  });
  write_daily_selection(daily_selection);
  const selected_arxiv_ids = new Set(daily_selection.selected_papers.map((selected_paper) => selected_paper.arxiv_id));
  const unselected_unmarked_candidate_papers_by_arxiv_id = Object.fromEntries(
    Object.entries(candidate_papers_by_arxiv_id).filter(([arxiv_id]) => !selected_arxiv_ids.has(arxiv_id) && !crossed_out_arxiv_ids.has(arxiv_id))
  );
  write_candidate_pool(unselected_unmarked_candidate_papers_by_arxiv_id, current_date_iso);

  return {
    daily_selection,
    warnings: [...feed_warnings, ...(selection_warning ? [selection_warning] : [])],
  };
}
