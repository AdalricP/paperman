import { homedir } from "node:os";
import { join } from "node:path";

const local_embedding_model_id = "Xenova/all-MiniLM-L6-v2";
const local_embedding_model_cache_directory_path = join(homedir(), ".paperman", "models");

let local_feature_extraction_pipeline_promise = null;

async function local_feature_extraction_pipeline() {
  if (local_feature_extraction_pipeline_promise) return local_feature_extraction_pipeline_promise;
  local_feature_extraction_pipeline_promise = import("@huggingface/transformers").then(
    async ({ env, pipeline }) => {
      env.cacheDir = local_embedding_model_cache_directory_path;
      return pipeline("feature-extraction", local_embedding_model_id);
    }
  );
  return local_feature_extraction_pipeline_promise;
}

export async function embed_paper_texts(paper_texts) {
  const feature_extraction_pipeline = await local_feature_extraction_pipeline();
  const embedding_tensor = await feature_extraction_pipeline(paper_texts, { pooling: "mean", normalize: true });
  return Array.from({ length: paper_texts.length }, (_unused_paper_text, paper_index) =>
    Array.from(embedding_tensor.data.slice(paper_index * embedding_tensor.dims.at(-1), (paper_index + 1) * embedding_tensor.dims.at(-1)))
  );
}
