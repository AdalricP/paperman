import { build_daily_pick_prompt, validate_daily_pick_response } from "./fireworks_api.mjs";
import {
  bayes_completed_probabilities,
  blended_relevance_scores,
  embedding_affinity_scores,
  min_max_normalized_scores,
  papers_in_round_robin_across_categories,
  papers_ranked_by_relevance_score,
} from "./paper_relevance_scores.mjs";

export const number_of_papers_selected_per_day = 10;
const maximum_candidate_papers_considered = 600;
const maximum_candidate_papers_sent_to_language_model = 40;

const embedding_text_of_paper = (paper) => `${paper.title}\n\n${paper.abstract_text}`;

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
  const successful_feed_results = feed_settlements
    .filter((feed_settlement) => feed_settlement.status === "fulfilled")
    .map((feed_settlement) => feed_settlement.value);
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

function training_history_from_marks(marked_papers_by_arxiv_id) {
  const marked_papers = Object.values(marked_papers_by_arxiv_id);
  const marked_papers_of_kind = (mark_kind) => marked_papers.filter((marked_paper) => marked_paper.mark_kind === mark_kind);
  const embedding_vectors_of = (papers_of_kind) =>
    papers_of_kind.map((marked_paper) => marked_paper.abstract_embedding_vector).filter(Boolean);
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

async function embedding_vectors_or_warning({ candidate_papers, embed_texts }) {
  try {
    const embedding_vectors = await embed_texts(candidate_papers.map(embedding_text_of_paper));
    return { embedding_vectors, embedding_warning: null };
  } catch (embedding_error) {
    return { embedding_vectors: null, embedding_warning: `embeddings unavailable: ${embedding_error.message}` };
  }
}

async function locally_ranked_candidates({ candidate_papers, training_history, embed_texts, report_progress }) {
  const is_cold_start = training_history.total_mark_count === 0;
  if (is_cold_start) {
    const pruned_papers = papers_in_round_robin_across_categories({
      papers: candidate_papers,
      maximum_count: maximum_candidate_papers_sent_to_language_model,
    });
    const { embedding_vectors, embedding_warning } = await embedding_vectors_or_warning({
      candidate_papers: pruned_papers,
      embed_texts,
    });
    return {
      pruned_papers,
      pruned_relevance_scores: null,
      embedding_vector_by_arxiv_id: embedding_vector_map(pruned_papers, embedding_vectors),
      scoring_warnings: embedding_warning ? [embedding_warning] : [],
    };
  }

  report_progress(`scoring ${candidate_papers.length} candidates against ${training_history.total_mark_count} past marks…`);
  const { embedding_vectors, embedding_warning } = await embedding_vectors_or_warning({ candidate_papers, embed_texts });

  const normalized_embedding_scores = embedding_scores_when_available({ candidate_papers, embedding_vectors, training_history });
  const bayes_probabilities = bayes_completed_probabilities({
    candidate_texts: candidate_papers.map(embedding_text_of_paper),
    completed_texts: training_history.completed_texts,
    crossed_out_texts: training_history.crossed_out_texts,
  });
  const relevance_scores = blended_relevance_scores({ normalized_embedding_scores, bayes_probabilities });

  if (!relevance_scores) {
    const pruned_papers = papers_in_round_robin_across_categories({
      papers: candidate_papers,
      maximum_count: maximum_candidate_papers_sent_to_language_model,
    });
    return {
      pruned_papers,
      pruned_relevance_scores: null,
      embedding_vector_by_arxiv_id: embedding_vector_map(candidate_papers, embedding_vectors),
      scoring_warnings: embedding_warning ? [embedding_warning] : [],
    };
  }

  const ranked_entries = papers_ranked_by_relevance_score({ papers: candidate_papers, relevance_scores }).slice(
    0,
    maximum_candidate_papers_sent_to_language_model
  );
  return {
    pruned_papers: ranked_entries.map((ranked_entry) => ranked_entry.paper),
    pruned_relevance_scores: ranked_entries.map((ranked_entry) => ranked_entry.relevance_score),
    embedding_vector_by_arxiv_id: embedding_vector_map(candidate_papers, embedding_vectors),
    scoring_warnings: embedding_warning ? [embedding_warning] : [],
  };
}

function embedding_vector_map(papers, embedding_vectors) {
  if (!embedding_vectors) return new Map();
  return new Map(papers.map((paper, paper_index) => [paper.arxiv_id, embedding_vectors[paper_index]]));
}

function embedding_scores_when_available({ candidate_papers, embedding_vectors, training_history }) {
  if (!embedding_vectors) return null;
  const raw_affinity_scores = embedding_affinity_scores({
    candidate_embedding_vectors: embedding_vectors,
    completed_embedding_vectors: training_history.completed_embedding_vectors,
    crossed_out_embedding_vectors: training_history.crossed_out_embedding_vectors,
  });
  if (!raw_affinity_scores) return null;
  return min_max_normalized_scores(raw_affinity_scores);
}

async function language_model_selection({ settings, pruned_papers, pruned_relevance_scores, request_pick, report_progress }) {
  const number_of_papers_to_select = Math.min(number_of_papers_selected_per_day, pruned_papers.length);
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: settings.tracked_arxiv_category_codes,
    interests_blurb_text: settings.interests_blurb_text,
    reading_intent_blurb_text: settings.reading_intent_blurb_text,
    candidate_papers: pruned_papers,
    candidate_relevance_scores: pruned_relevance_scores,
    number_of_papers_to_select,
  });
  const candidate_arxiv_ids = pruned_papers.map((pruned_paper) => pruned_paper.arxiv_id);

  for (const attempt_number of [1, 2]) {
    try {
      report_progress(attempt_number === 1 ? "asking the model for today's picks…" : "retrying the model once…");
      const response_text = await request_pick(prompt_text);
      const validated_picks = validate_daily_pick_response({
        response_text,
        candidate_arxiv_ids,
        number_of_papers_to_select,
      });
      return { validated_picks, selection_warning: null };
    } catch (selection_error) {
      if (attempt_number === 2) {
        return { validated_picks: fallback_picks({ pruned_papers, pruned_relevance_scores, number_of_papers_to_select }), selection_warning: `model pick failed, used local ranking: ${selection_error.message}` };
      }
    }
  }
}

function fallback_picks({ pruned_papers, pruned_relevance_scores, number_of_papers_to_select }) {
  const fallback_reason = pruned_relevance_scores
    ? "picked by local relevance ranking (model unavailable)"
    : "picked round-robin across categories (model unavailable)";
  return pruned_papers.slice(0, number_of_papers_to_select).map((pruned_paper) => ({
    arxiv_id: pruned_paper.arxiv_id,
    selection_reason: fallback_reason,
  }));
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
  if (candidate_papers.length === 0) {
    throw new Error("No unmarked papers in any tracked feed today");
  }

  const training_history = training_history_from_marks(marked_papers_by_arxiv_id);
  const { pruned_papers, pruned_relevance_scores, embedding_vector_by_arxiv_id, scoring_warnings } =
    await locally_ranked_candidates({ candidate_papers, training_history, embed_texts, report_progress });

  const { validated_picks, selection_warning } = await language_model_selection({
    settings,
    pruned_papers,
    pruned_relevance_scores,
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

  return {
    daily_selection,
    warnings: [...feed_warnings, ...scoring_warnings, ...(selection_warning ? [selection_warning] : [])],
  };
}
