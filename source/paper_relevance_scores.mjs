import "./environment_variables.mjs";
import { similarity } from "ml-distance";
import natural from "natural";

const embedding_affinity_weight = 0.6;
const bayes_probability_weight = 0.4;
export const minimum_marks_per_class_for_bayes_training = 3;
const completed_class_label = "completed";
const crossed_out_class_label = "crossed_out";

export function centroid_of_embedding_vectors(embedding_vectors) {
  if (embedding_vectors.length === 0) return null;
  const vector_dimension_count = embedding_vectors[0].length;
  const centroid_vector = new Array(vector_dimension_count).fill(0);
  for (const embedding_vector of embedding_vectors) {
    for (let dimension_index = 0; dimension_index < vector_dimension_count; dimension_index++) {
      centroid_vector[dimension_index] += embedding_vector[dimension_index] / embedding_vectors.length;
    }
  }
  return centroid_vector;
}

export function embedding_affinity_scores({
  candidate_embedding_vectors,
  completed_embedding_vectors,
  crossed_out_embedding_vectors,
}) {
  const completed_centroid = centroid_of_embedding_vectors(completed_embedding_vectors);
  const crossed_out_centroid = centroid_of_embedding_vectors(crossed_out_embedding_vectors);
  if (!completed_centroid && !crossed_out_centroid) return null;

  return candidate_embedding_vectors.map((candidate_embedding_vector) => {
    if (!candidate_embedding_vector) return 0;
    const attraction_toward_completed = completed_centroid
      ? similarity.cosine(candidate_embedding_vector, completed_centroid)
      : 0;
    const repulsion_from_crossed_out = crossed_out_centroid
      ? similarity.cosine(candidate_embedding_vector, crossed_out_centroid)
      : 0;
    return attraction_toward_completed - repulsion_from_crossed_out;
  });
}

export function min_max_normalized_scores(raw_scores) {
  const lowest_score = Math.min(...raw_scores);
  const highest_score = Math.max(...raw_scores);
  if (highest_score === lowest_score) return raw_scores.map(() => 0.5);
  return raw_scores.map((raw_score) => (raw_score - lowest_score) / (highest_score - lowest_score));
}

export function bayes_completed_probabilities({ candidate_texts, completed_texts, crossed_out_texts }) {
  const has_enough_training_examples =
    completed_texts.length >= minimum_marks_per_class_for_bayes_training &&
    crossed_out_texts.length >= minimum_marks_per_class_for_bayes_training;
  if (!has_enough_training_examples) return null;

  const bayes_classifier = new natural.BayesClassifier();
  for (const completed_text of completed_texts) bayes_classifier.addDocument(completed_text, completed_class_label);
  for (const crossed_out_text of crossed_out_texts) bayes_classifier.addDocument(crossed_out_text, crossed_out_class_label);
  bayes_classifier.train();

  return candidate_texts.map((candidate_text) => {
    const classifications = bayes_classifier.getClassifications(candidate_text);
    const score_for_label = (class_label) =>
      classifications.find((classification) => classification.label === class_label)?.value ?? 0;
    const completed_score = score_for_label(completed_class_label);
    const crossed_out_score = score_for_label(crossed_out_class_label);
    if (completed_score + crossed_out_score === 0) return 0.5;
    return completed_score / (completed_score + crossed_out_score);
  });
}

export function blended_relevance_scores({ normalized_embedding_scores, bayes_probabilities }) {
  if (!normalized_embedding_scores && !bayes_probabilities) return null;
  if (!bayes_probabilities) return normalized_embedding_scores;
  if (!normalized_embedding_scores) return bayes_probabilities;
  return normalized_embedding_scores.map(
    (normalized_embedding_score, candidate_index) =>
      embedding_affinity_weight * normalized_embedding_score +
      bayes_probability_weight * bayes_probabilities[candidate_index]
  );
}

export function papers_ranked_by_relevance_score({ papers, relevance_scores }) {
  return papers
    .map((paper, paper_index) => ({ paper, relevance_score: relevance_scores[paper_index] }))
    .sort((first_entry, second_entry) => second_entry.relevance_score - first_entry.relevance_score);
}

export function papers_in_round_robin_across_categories({ papers, maximum_count }) {
  const papers_by_category_code = new Map();
  for (const paper of papers) {
    const category_code = paper.primary_arxiv_category_code;
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
