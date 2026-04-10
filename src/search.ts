// ─── Tavily Web Search ──────────────────────────────────────────────────────

import type { Env } from "./config";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export async function searchWeb(env: Env, query: string): Promise<string | null> {
  const trimmedQuery = query.slice(0, 400);

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query: trimmedQuery,
        max_results: 5,
        search_depth: "basic",
        include_answer: false,
      }),
    });

    if (!res.ok) {
      console.error(`Tavily search failed: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as TavilyResponse;
    const results = data.results;

    if (!results || results.length === 0) return null;

    return results
      .map((r) => `${r.title}: ${r.content}\nСсылка: ${r.url}`)
      .join("\n\n");
  } catch (err) {
    console.error("Tavily search error:", err);
    return null;
  }
}
