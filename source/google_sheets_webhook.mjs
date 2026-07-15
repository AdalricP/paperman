function readable_webhook_error_text(response_text) {
  return response_text.replace(/\s+/g, " ").trim().slice(0, 300) || "no response details";
}

export async function append_crossed_paper_to_google_sheet({ google_sheets_webhook_url, paper, crossed_at_iso }) {
  if (!google_sheets_webhook_url) return false;
  let webhook_response;
  try {
    webhook_response = await fetch(google_sheets_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        crossed_at_iso,
        arxiv_id: paper.arxiv_id,
        title: paper.title,
        source_category: paper.source_feed_category_code,
        primary_category: paper.primary_arxiv_category_code,
        arxiv_url: paper.arxiv_abstract_url,
        selection_reason: paper.language_model_selection_reason,
        abstract: paper.abstract_text,
      }),
    });
  } catch (webhook_error) {
    throw new Error(`Google Sheet request failed: ${webhook_error.message}`);
  }
  if (!webhook_response.ok) {
    throw new Error(`Google Sheet request failed (HTTP ${webhook_response.status}): ${readable_webhook_error_text(await webhook_response.text())}`);
  }
  return true;
}
