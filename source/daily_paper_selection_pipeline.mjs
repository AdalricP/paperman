import { build_daily_pick_prompt, validate_daily_pick_response } from "./model_provider_api.mjs";
import {
  bayes_completed_probabilities,
  blended_relevance_scores,
  embedding_affinity_scores,
  min_max_normalized_scores,
  papers_in_round_robin_across_categories,
  papers_ranked_by_relevance_score,
} from "./paper_relevance_scores.mjs";

const maximum_candidate_papers_considered = 600;
const minimum_candidates_per_category_sent_to_language_model = 8;
const relevance_score_weight = 0.8;
const recency_score_weight = 0.2;
const recency_score_full_age_in_days = 14;

const embedding_text_of_paper = (paper) => `${paper.title}\n\n${paper.abstract_text}`;

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

async function fetched_candidate_papers({ tracked_arxiv_category_codes, fetch_papers_for_category, marked_arxiv_ids }) {
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

  const unmarked_papers = merged_papers_across_feeds(successful_feed_results).filter(
    (paper) => !marked_arxiv_ids.has(paper.arxiv_id)
  );
  const candidate_papers = papers_in_round_robin_across_categories({
    papers: unmarked_papers,
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

function training_history_from_marks(marked_papers_by_arxiv_id) {
  const marked_papers = Object.values(marked_papers_by_arxiv_id);
  const marked_papers_of_kind = (mark_kind) => marked_papers.filter((marked_paper) => marked_paper.mark_kind === mark_kind);
  const embedding_vectors_of = (papers_of_kind) => papers_of_kind
    .map((marked_paper) => marked_paper.abstract_embedding_vector)
    .filter((embedding_vector) => Array.isArray(embedding_vector) && embedding_vector.length > 0);
  const training_text_of = (marked_paper) => `${marked_paper.title}\n\n${marked_paper.abstract_text}`;

  const completed_papers = marked_papers_of_kind("completed");
  const crossed_out_papers = marked_papers_of_kind("crossed_out");
  return {
    total_mark_count: marked_papers.length,
    completed_texts: completed_papers.map(training_text_of),
    crossed_out_texts: crossed_out_papers.map(training_text_of),
    completed_embedding_vectors: embedding_vectors_of(completed_papers),
    crossed_out_embedding_vectors: embedding_vectors_of(crossed_out_papers),
  };
}

async function embedding_vectors_or_warning({ candidate_papers, embed_texts, report_progress }) {
  try {
    report_progress("embedding candidates locally… first use downloads the model once");
    const embedding_vectors = await embed_texts(candidate_papers.map(embedding_text_of_paper));
    return { embedding_vectors, embedding_warning: null };
  } catch (embedding_error) {
    return { embedding_vectors: null, embedding_warning: `embeddings unavailable: ${embedding_error.message}` };
  }
}

function embedding_vector_map(papers, embedding_vectors) {
  if (!embedding_vectors) return new Map();
  return new Map(papers.map((paper, paper_index) => [paper.arxiv_id, embedding_vectors[paper_index]]));
}

function embedding_scores_when_available({ candidate_papers, embedding_vectors, training_history }) {
  if (!embedding_vectors) return null;
  const expected_embedding_dimension_count = embedding_vectors[0]?.length;
  if (!expected_embedding_dimension_count) return null;
  const matching_embedding_vectors = (embedding_vectors_to_filter) =>
    embedding_vectors_to_filter.filter((embedding_vector) => embedding_vector.length === expected_embedding_dimension_count);
  const raw_affinity_scores = embedding_affinity_scores({
    candidate_embedding_vectors: embedding_vectors,
    completed_embedding_vectors: matching_embedding_vectors(training_history.completed_embedding_vectors),
    crossed_out_embedding_vectors: matching_embedding_vectors(training_history.crossed_out_embedding_vectors),
  });
  if (!raw_affinity_scores) return null;
  return min_max_normalized_scores(raw_affinity_scores);
}

function papers_ranked_by_recency(candidate_papers) {
  return [...candidate_papers].sort((first_paper, second_paper) => second_paper.recency_score - first_paper.recency_score);
}

function blended_relevance_and_recency_scores(relevance_scores, candidate_papers) {
  return relevance_scores.map((relevance_score, paper_index) =>
    relevance_score_weight * relevance_score + recency_score_weight * candidate_papers[paper_index].recency_score
  );
}

function pruned_by_category({ ordered_papers, ordered_relevance_scores, papers_per_category_per_day }) {
  const per_category_cap = Math.max(minimum_candidates_per_category_sent_to_language_model, papers_per_category_per_day * 4);
  const kept_count_by_category = new Map();
  const pruned_papers = [];
  const pruned_relevance_scores = [];

  for (const [paper_index, paper] of ordered_papers.entries()) {
    const category_code = paper.source_feed_category_code;
    const kept_count = kept_count_by_category.get(category_code) ?? 0;
    if (kept_count >= per_category_cap) continue;
    kept_count_by_category.set(category_code, kept_count + 1);
    pruned_papers.push(paper);
    if (ordered_relevance_scores) pruned_relevance_scores.push(ordered_relevance_scores[paper_index]);
  }

  return { pruned_papers, pruned_relevance_scores: ordered_relevance_scores ? pruned_relevance_scores : null };
}

async function locally_ranked_candidates({ candidate_papers, training_history, embed_texts, papers_per_category_per_day, report_progress }) {
  const is_cold_start = training_history.total_mark_count === 0;
  if (is_cold_start) {
    const { pruned_papers } = pruned_by_category({
      ordered_papers: papers_ranked_by_recency(candidate_papers),
      ordered_relevance_scores: null,
      papers_per_category_per_day,
    });
    const { embedding_vectors, embedding_warning } = await embedding_vectors_or_warning({
      candidate_papers: pruned_papers,
      embed_texts,
      report_progress,
    });
    return {
      pruned_papers,
      pruned_relevance_scores: null,
      embedding_vector_by_arxiv_id: embedding_vector_map(pruned_papers, embedding_vectors),
      scoring_warnings: embedding_warning ? [embedding_warning] : [],
    };
  }

  report_progress(`scoring ${candidate_papers.length} candidates against ${training_history.total_mark_count} past marks…`);
  const { embedding_vectors, embedding_warning } = await embedding_vectors_or_warning({ candidate_papers, embed_texts, report_progress });

  const normalized_embedding_scores = embedding_scores_when_available({ candidate_papers, embedding_vectors, training_history });
  const bayes_probabilities = bayes_completed_probabilities({
    candidate_texts: candidate_papers.map(embedding_text_of_paper),
    completed_texts: training_history.completed_texts,
    crossed_out_texts: training_history.crossed_out_texts,
  });
  const relevance_scores = blended_relevance_scores({ normalized_embedding_scores, bayes_probabilities });
  const relevance_scores_including_recency = relevance_scores
    ? blended_relevance_and_recency_scores(relevance_scores, candidate_papers)
    : null;

  const ranked_entries = relevance_scores_including_recency
    ? papers_ranked_by_relevance_score({ papers: candidate_papers, relevance_scores: relevance_scores_including_recency })
    : papers_ranked_by_recency(candidate_papers).map((paper) => ({ paper, relevance_score: null }));
  const { pruned_papers, pruned_relevance_scores } = pruned_by_category({
    ordered_papers: ranked_entries.map((ranked_entry) => ranked_entry.paper),
    ordered_relevance_scores: relevance_scores_including_recency ? ranked_entries.map((ranked_entry) => ranked_entry.relevance_score) : null,
    papers_per_category_per_day,
  });

  return {
    pruned_papers,
    pruned_relevance_scores,
    embedding_vector_by_arxiv_id: embedding_vector_map(candidate_papers, embedding_vectors),
    scoring_warnings: embedding_warning ? [embedding_warning] : [],
  };
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

function fallback_picks({ pruned_papers, pruned_relevance_scores, selection_target_by_category_code }) {
  const fallback_reason = pruned_relevance_scores
    ? "picked by local relevance ranking (model unavailable)"
    : "picked in announcement order (model unavailable)";
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
  pruned_relevance_scores,
  selection_target_by_category_code,
  request_pick,
  report_progress,
}) {
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: settings.tracked_arxiv_category_codes,
    interests_blurb_text: settings.interests_blurb_text,
    reading_intent_blurb_text: settings.reading_intent_blurb_text,
    candidate_papers: pruned_papers,
    candidate_relevance_scores: pruned_relevance_scores,
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
          validated_picks: fallback_picks({ pruned_papers, pruned_relevance_scores, selection_target_by_category_code }),
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
  pruned_relevance_scores,
  embedding_vector_by_arxiv_id,
  previous_marks_by_arxiv_id,
}) {
  const pruned_paper_by_arxiv_id = new Map(pruned_papers.map((pruned_paper) => [pruned_paper.arxiv_id, pruned_paper]));
  const relevance_score_by_arxiv_id = new Map(
    pruned_papers.map((pruned_paper, paper_index) => [
      pruned_paper.arxiv_id,
      pruned_relevance_scores ? Number(pruned_relevance_scores[paper_index].toFixed(3)) : null,
    ])
  );

  const selected_papers = validated_picks.map((validated_pick) => ({
    ...pruned_paper_by_arxiv_id.get(validated_pick.arxiv_id),
    local_relevance_score: relevance_score_by_arxiv_id.get(validated_pick.arxiv_id),
    language_model_selection_reason: validated_pick.selection_reason,
    abstract_embedding_vector: embedding_vector_by_arxiv_id.get(validated_pick.arxiv_id) ?? null,
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
  embed_texts,
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
  const { candidate_papers, announcement_date_iso, feed_warnings } = await fetched_candidate_papers({
    tracked_arxiv_category_codes: settings.tracked_arxiv_category_codes,
    fetch_papers_for_category,
    marked_arxiv_ids: new Set(Object.keys(marked_papers_by_arxiv_id)),
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
    excluded_arxiv_ids: new Set([...Object.keys(marked_papers_by_arxiv_id), ...currently_selected_arxiv_ids]),
  });
  const round_robin_candidate_papers = papers_in_round_robin_across_categories({
    papers: pooled_candidate_papers,
    maximum_count: maximum_candidate_papers_considered,
  });
  if (round_robin_candidate_papers.length === 0) {
    throw new Error("No unmarked papers in any tracked feed today");
  }

  const papers_per_category_per_day = sanitized_papers_per_category_per_day(settings.papers_per_category_per_day);
  const training_history = training_history_from_marks(marked_papers_by_arxiv_id);
  const { pruned_papers, pruned_relevance_scores, embedding_vector_by_arxiv_id, scoring_warnings } =
    await locally_ranked_candidates({
      candidate_papers: round_robin_candidate_papers,
      training_history,
      embed_texts,
      papers_per_category_per_day,
      report_progress,
    });

  const selection_target_by_category_code = selection_targets_for_candidates({ pruned_papers, papers_per_category_per_day });
  const { validated_picks, selection_warning } = await language_model_selection({
    settings,
    pruned_papers,
    pruned_relevance_scores,
    selection_target_by_category_code,
    request_pick,
    report_progress,
  });

  const daily_selection = frozen_daily_selection({
    current_date_iso,
    announcement_date_iso,
    validated_picks,
    pruned_papers,
    pruned_relevance_scores,
    embedding_vector_by_arxiv_id,
    previous_marks_by_arxiv_id: is_frozen_for_today ? existing_daily_selection.mark_by_arxiv_id ?? {} : {},
  });
  write_daily_selection(daily_selection);
  const selected_arxiv_ids = new Set(daily_selection.selected_papers.map((selected_paper) => selected_paper.arxiv_id));
  const unselected_unmarked_candidate_papers_by_arxiv_id = Object.fromEntries(
    Object.entries(candidate_papers_by_arxiv_id).filter(([arxiv_id]) => !selected_arxiv_ids.has(arxiv_id) && !marked_papers_by_arxiv_id[arxiv_id])
  );
  write_candidate_pool(unselected_unmarked_candidate_papers_by_arxiv_id, current_date_iso);

  return {
    daily_selection,
    warnings: [...feed_warnings, ...scoring_warnings, ...(selection_warning ? [selection_warning] : [])],
  };
}
