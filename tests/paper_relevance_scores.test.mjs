import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bayes_completed_probabilities,
  blended_relevance_scores,
  centroid_of_embedding_vectors,
  embedding_affinity_scores,
  min_max_normalized_scores,
  papers_in_round_robin_across_categories,
  papers_ranked_by_relevance_score,
} from "../source/paper_relevance_scores.mjs";

test("centroid averages vectors and is null when empty", () => {
  assert.deepEqual(centroid_of_embedding_vectors([[1, 0], [0, 1]]), [0.5, 0.5]);
  assert.equal(centroid_of_embedding_vectors([]), null);
});

test("embedding affinity attracts toward completed and repels from crossed out", () => {
  const affinity_scores = embedding_affinity_scores({
    candidate_embedding_vectors: [[1, 0], [0, 1]],
    completed_embedding_vectors: [[1, 0]],
    crossed_out_embedding_vectors: [[0, 1]],
  });
  assert.ok(affinity_scores[0] > affinity_scores[1]);
});

test("embedding affinity is null without any marked embeddings", () => {
  const affinity_scores = embedding_affinity_scores({
    candidate_embedding_vectors: [[1, 0]],
    completed_embedding_vectors: [],
    crossed_out_embedding_vectors: [],
  });
  assert.equal(affinity_scores, null);
});

test("min max normalization maps equal scores to 0.5", () => {
  assert.deepEqual(min_max_normalized_scores([2, 2]), [0.5, 0.5]);
  assert.deepEqual(min_max_normalized_scores([0, 5, 10]), [0, 0.5, 1]);
});

test("bayes probabilities are gated behind three marks per class", () => {
  const gated_probabilities = bayes_completed_probabilities({
    candidate_texts: ["anything"],
    completed_texts: ["one", "two"],
    crossed_out_texts: ["one", "two", "three"],
  });
  assert.equal(gated_probabilities, null);
});

test("bayes prefers candidates that read like completed papers", () => {
  const bayes_probabilities_for_candidates = bayes_completed_probabilities({
    candidate_texts: ["robot manipulation dexterous grasping", "galaxy survey redshift catalog"],
    completed_texts: [
      "robot manipulation policies",
      "dexterous grasping with tactile sensing",
      "manipulation learning for robot arms",
    ],
    crossed_out_texts: [
      "galaxy formation simulations",
      "redshift survey of distant galaxies",
      "stellar catalog astrometry",
    ],
  });
  assert.ok(bayes_probabilities_for_candidates[0] > bayes_probabilities_for_candidates[1]);
});

test("blend renormalizes to the available signal", () => {
  assert.deepEqual(blended_relevance_scores({ normalized_embedding_scores: [1], bayes_probabilities: null }), [1]);
  assert.deepEqual(blended_relevance_scores({ normalized_embedding_scores: null, bayes_probabilities: [0.7] }), [0.7]);
  assert.equal(blended_relevance_scores({ normalized_embedding_scores: null, bayes_probabilities: null }), null);
  const blended_scores = blended_relevance_scores({ normalized_embedding_scores: [1], bayes_probabilities: [0.5] });
  assert.ok(Math.abs(blended_scores[0] - 0.8) < 1e-9);
});

test("ranking sorts papers by descending score", () => {
  const papers = [{ arxiv_id: "low" }, { arxiv_id: "high" }];
  const ranked_entries = papers_ranked_by_relevance_score({ papers, relevance_scores: [0.1, 0.9] });
  assert.deepEqual(ranked_entries.map((ranked_entry) => ranked_entry.paper.arxiv_id), ["high", "low"]);
});

test("round robin interleaves categories up to the maximum", () => {
  const paper_in_category = (arxiv_id, category_code) => ({ arxiv_id, primary_arxiv_category_code: category_code });
  const round_robin_papers = papers_in_round_robin_across_categories({
    papers: [
      paper_in_category("a1", "cs.LG"),
      paper_in_category("a2", "cs.LG"),
      paper_in_category("a3", "cs.LG"),
      paper_in_category("b1", "cs.RO"),
    ],
    maximum_count: 3,
  });
  assert.deepEqual(round_robin_papers.map((paper) => paper.arxiv_id), ["a1", "b1", "a2"]);
});
