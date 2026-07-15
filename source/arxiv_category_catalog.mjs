export const arxiv_category_catalog = [
  { arxiv_category_code: "physics", display_name: "Physics" },
  { arxiv_category_code: "quant-ph", display_name: "Quantum Physics" },
  { arxiv_category_code: "astro-ph", display_name: "Astrophysics" },
  { arxiv_category_code: "cond-mat", display_name: "Condensed Matter" },
  { arxiv_category_code: "cs.RO", display_name: "Robotics" },
  { arxiv_category_code: "cs.LG", display_name: "Machine Learning" },
  { arxiv_category_code: "cs.AI", display_name: "Artificial Intelligence" },
  { arxiv_category_code: "cs.CV", display_name: "Computer Vision" },
  { arxiv_category_code: "cs.CL", display_name: "Computation and Language" },
  { arxiv_category_code: "cs.NE", display_name: "Neural and Evolutionary Computing" },
  { arxiv_category_code: "cs.SY", display_name: "Systems and Control" },
  { arxiv_category_code: "stat.ML", display_name: "Statistics: Machine Learning" },
  { arxiv_category_code: "math.OC", display_name: "Optimization and Control" },
  { arxiv_category_code: "eess.SY", display_name: "Electrical Engineering: Systems" },
];

export function display_name_for_arxiv_category_code(arxiv_category_code) {
  const catalog_entry = arxiv_category_catalog.find(
    (candidate_entry) => candidate_entry.arxiv_category_code === arxiv_category_code
  );
  if (!catalog_entry) return arxiv_category_code;
  return catalog_entry.display_name;
}
