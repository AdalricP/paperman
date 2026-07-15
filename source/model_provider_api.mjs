const openrouter_chat_completions_url = "https://openrouter.ai/api/v1/chat/completions";
const maximum_abstract_characters_sent_to_language_model = 350;
const language_model_sampling_temperature = 0.2;
const language_model_maximum_output_tokens = 8000;
const maximum_paper_contribution_characters = 280;

function readable_openrouter_error_text(error_body_text) {
  try {
    const parsed_error_body = JSON.parse(error_body_text);
    return parsed_error_body?.error?.message ?? parsed_error_body?.message ?? error_body_text;
  } catch {
    return error_body_text;
  }
}

async function provider_json_request({ endpoint_url, api_key, request_payload }) {
  let api_response;
  try {
    api_response = await fetch(endpoint_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request_payload),
    });
  } catch (openrouter_request_error) {
    throw new Error(`OpenRouter request failed before a response: ${openrouter_request_error.message}`);
  }
  if (!api_response.ok) {
    const error_body_text = await api_response.text();
    const readable_error_text = readable_openrouter_error_text(error_body_text);
    throw new Error(`OpenRouter request failed (HTTP ${api_response.status}): ${readable_error_text.slice(0, 1000)}`);
  }
  return api_response.json();
}

const quota_summary_text = (selection_target_by_category_code) =>
  Object.entries(selection_target_by_category_code)
    .map(([category_code, selection_target]) => `${category_code}: ${selection_target}`)
    .join(" · ");

export const total_selection_target = (selection_target_by_category_code) =>
  Object.values(selection_target_by_category_code).reduce(
    (running_total, selection_target) => running_total + selection_target,
    0
  );

export function build_daily_pick_prompt({
  tracked_arxiv_category_codes,
  interests_blurb_text,
  reading_intent_blurb_text,
  candidate_papers,
  selection_target_by_category_code,
}) {
  const candidate_lines = candidate_papers.map((candidate_paper) =>
    JSON.stringify({
      arxiv_id: candidate_paper.arxiv_id,
      title: candidate_paper.title,
      abstract: candidate_paper.abstract_text.slice(0, maximum_abstract_characters_sent_to_language_model),
      quota_category: candidate_paper.source_feed_category_code,
      categories: candidate_paper.arxiv_category_codes,
      age_in_days: candidate_paper.age_in_days,
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
    "Prefer newer papers. Only choose an older paper when it clearly fits the stated interests and goal better.",
    "For every selected paper, give a candid paper_contribution of at most 25 words: what it actually contributes. If it seems incremental or merely applies known methods, say that plainly but fairly.",
    "",
    "Candidate papers, one JSON object per line:",
    ...candidate_lines,
    "",
    `Select the best papers per quota_category, exactly these counts (total ${total_selection_target(selection_target_by_category_code)}): ${quota_summary_text(selection_target_by_category_code)}.`,
    "Respond with JSON only:",
    '{"selected_papers": [{"arxiv_id": "...", "selection_reason": "one concrete line on why this paper is worth their time today", "paper_contribution": "at most 25 words on the paper’s actual contribution"}]}',
  ].join("\n");
}

function selected_counts_by_category({ selected_papers, category_code_by_arxiv_id }) {
  const selected_counts = {};
  for (const selected_paper of selected_papers) {
    const category_code = category_code_by_arxiv_id.get(selected_paper.arxiv_id);
    selected_counts[category_code] = (selected_counts[category_code] ?? 0) + 1;
  }
  return selected_counts;
}

export function validated_picks_in_daily_pick_response({ response_text, candidate_papers }) {
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

  const category_code_by_arxiv_id = new Map(
    candidate_papers.map((candidate_paper) => [candidate_paper.arxiv_id, candidate_paper.source_feed_category_code])
  );
  const seen_selected_ids = new Set();
  for (const selected_paper of selected_papers) {
    if (!category_code_by_arxiv_id.has(selected_paper.arxiv_id)) {
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
    paper_contribution: typeof selected_paper.paper_contribution === "string"
      ? selected_paper.paper_contribution.replace(/\s+/g, " ").trim().slice(0, maximum_paper_contribution_characters)
      : "",
  }));
}

export function validate_daily_pick_response({ response_text, candidate_papers, selection_target_by_category_code }) {
  const validated_picks = validated_picks_in_daily_pick_response({ response_text, candidate_papers });
  const category_code_by_arxiv_id = new Map(
    candidate_papers.map((candidate_paper) => [candidate_paper.arxiv_id, candidate_paper.source_feed_category_code])
  );
  const selected_counts = selected_counts_by_category({ selected_papers: validated_picks, category_code_by_arxiv_id });
  for (const [category_code, selection_target] of Object.entries(selection_target_by_category_code)) {
    const selected_count = selected_counts[category_code] ?? 0;
    if (selected_count !== selection_target) {
      throw new Error(`Daily pick chose ${selected_count} papers for ${category_code}, expected ${selection_target}`);
    }
  }

  return validated_picks;
}

export async function request_daily_pick({ openrouter_api_key, openrouter_chat_model_id, prompt_text }) {
  if (!openrouter_api_key) {
    throw new Error("no OpenRouter key set — add OPENROUTER_API_KEY to .env or set it in settings");
  }
  const chat_response = await provider_json_request({
    endpoint_url: openrouter_chat_completions_url,
    api_key: openrouter_api_key,
    request_payload: {
      model: openrouter_chat_model_id,
      messages: [{ role: "user", content: prompt_text }],
      temperature: language_model_sampling_temperature,
      max_tokens: language_model_maximum_output_tokens,
      response_format: { type: "json_object" },
      reasoning: { effort: "medium", exclude: true },
    },
  });
  const response_text = chat_response?.choices?.[0]?.message?.content;
  if (!response_text) throw new Error("OpenRouter chat response has no message content");
  return response_text.trim();
}
