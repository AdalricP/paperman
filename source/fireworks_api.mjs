const fireworks_embeddings_url = "https://api.fireworks.ai/inference/v1/embeddings";
const fireworks_chat_completions_url = "https://api.fireworks.ai/inference/v1/chat/completions";
const embedding_texts_per_batch = 64;
const maximum_abstract_characters_sent_to_language_model = 700;
const language_model_sampling_temperature = 0.2;
const language_model_maximum_output_tokens = 2000;

async function fireworks_json_request({ endpoint_url, fireworks_api_key, request_payload }) {
  const api_response = await fetch(endpoint_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fireworks_api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request_payload),
  });
  if (!api_response.ok) {
    const error_body_text = await api_response.text();
    throw new Error(`Fireworks ${endpoint_url} returned ${api_response.status}: ${error_body_text.slice(0, 300)}`);
  }
  return api_response.json();
}

export async function embed_paper_texts({ fireworks_api_key, fireworks_embedding_model_id, paper_texts }) {
  const embedding_vectors = [];
  for (let batch_start_index = 0; batch_start_index < paper_texts.length; batch_start_index += embedding_texts_per_batch) {
    const batch_texts = paper_texts.slice(batch_start_index, batch_start_index + embedding_texts_per_batch);
    const embeddings_response = await fireworks_json_request({
      endpoint_url: fireworks_embeddings_url,
      fireworks_api_key,
      request_payload: { model: fireworks_embedding_model_id, input: batch_texts },
    });
    embedding_vectors.push(...embeddings_response.data.map((embedding_entry) => embedding_entry.embedding));
  }
  return embedding_vectors;
}

const daily_pick_response_json_schema = {
  type: "object",
  properties: {
    selected_papers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          arxiv_id: { type: "string" },
          selection_reason: { type: "string" },
        },
        required: ["arxiv_id", "selection_reason"],
      },
    },
  },
  required: ["selected_papers"],
};

export function build_daily_pick_prompt({
  tracked_arxiv_category_codes,
  interests_blurb_text,
  reading_intent_blurb_text,
  candidate_papers,
  candidate_relevance_scores,
  number_of_papers_to_select,
}) {
  const candidate_lines = candidate_papers.map((candidate_paper, candidate_index) =>
    JSON.stringify({
      arxiv_id: candidate_paper.arxiv_id,
      title: candidate_paper.title,
      abstract: candidate_paper.abstract_text.slice(0, maximum_abstract_characters_sent_to_language_model),
      categories: candidate_paper.arxiv_category_codes,
      local_relevance_score: candidate_relevance_scores
        ? Number(candidate_relevance_scores[candidate_index].toFixed(3))
        : null,
    })
  );

  const interests_line = interests_blurb_text || "(not provided)";
  const reading_intent_line = reading_intent_blurb_text || "(not provided)";

  return [
    "You curate a daily arXiv reading list for one person.",
    "",
    `Tracked arXiv categories: ${tracked_arxiv_category_codes.join(", ")}`,
    `Their interests: ${interests_line}`,
    `Their current goal: ${reading_intent_line}`,
    "",
    "local_relevance_score (0-1, null on cold start) comes from a recommender trained on papers they previously finished versus dismissed. Treat it as a strong prior, but override it when a paper clearly matches or clashes with the stated interests and goal.",
    "",
    "Candidate papers, one JSON object per line:",
    ...candidate_lines,
    "",
    `Select exactly ${number_of_papers_to_select} distinct papers from the candidates above, spread across categories when quality allows. Respond with JSON only:`,
    '{"selected_papers": [{"arxiv_id": "...", "selection_reason": "one concrete line on why this paper is worth their time today"}]}',
  ].join("\n");
}

export function validate_daily_pick_response({ response_text, candidate_arxiv_ids, number_of_papers_to_select }) {
  let parsed_response;
  try {
    parsed_response = JSON.parse(response_text);
  } catch (parse_error) {
    throw new Error(`Daily pick response is not valid JSON (${parse_error.message}): ${response_text.slice(0, 200)}`);
  }

  const selected_papers = parsed_response?.selected_papers;
  if (!Array.isArray(selected_papers)) {
    throw new Error(`Daily pick response has no selected_papers array: ${response_text.slice(0, 200)}`);
  }
  if (selected_papers.length !== number_of_papers_to_select) {
    throw new Error(`Daily pick returned ${selected_papers.length} papers, expected ${number_of_papers_to_select}`);
  }

  const known_candidate_ids = new Set(candidate_arxiv_ids);
  const seen_selected_ids = new Set();
  for (const selected_paper of selected_papers) {
    if (!known_candidate_ids.has(selected_paper.arxiv_id)) {
      throw new Error(`Daily pick invented arxiv_id ${selected_paper.arxiv_id} that is not among the candidates`);
    }
    if (seen_selected_ids.has(selected_paper.arxiv_id)) {
      throw new Error(`Daily pick selected arxiv_id ${selected_paper.arxiv_id} twice`);
    }
    if (!selected_paper.selection_reason || typeof selected_paper.selection_reason !== "string") {
      throw new Error(`Daily pick gave no selection_reason for ${selected_paper.arxiv_id}`);
    }
    seen_selected_ids.add(selected_paper.arxiv_id);
  }

  return selected_papers.map((selected_paper) => ({
    arxiv_id: selected_paper.arxiv_id,
    selection_reason: selected_paper.selection_reason.trim(),
  }));
}

export async function request_daily_pick({ fireworks_api_key, fireworks_chat_model_id, prompt_text }) {
  const chat_response = await fireworks_json_request({
    endpoint_url: fireworks_chat_completions_url,
    fireworks_api_key,
    request_payload: {
      model: fireworks_chat_model_id,
      messages: [{ role: "user", content: prompt_text }],
      temperature: language_model_sampling_temperature,
      max_tokens: language_model_maximum_output_tokens,
      response_format: { type: "json_object", schema: daily_pick_response_json_schema },
    },
  });
  const response_text = chat_response?.choices?.[0]?.message?.content;
  if (!response_text) throw new Error("Fireworks chat response has no message content");
  return response_text.trim();
}
