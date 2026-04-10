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

export interface SearchResult {
  context: string;
  sources: { title: string; url: string }[];
}

export async function searchWeb(env: Env, query: string): Promise<SearchResult | null> {
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

    return {
      context: results
        .map((r) => `${r.title}: ${r.content}\nСсылка: ${r.url}`)
        .join("\n\n"),
      sources: results.slice(0, 3).map((r) => ({ title: r.title, url: r.url })),
    };
  } catch (err) {
    console.error("Tavily search error:", err);
    return null;
  }
}

const VIDEO_DOMAINS = ["youtube.com", "youtu.be", "vimeo.com", "tiktok.com"];

function isVideoUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace("www.", "");
    return VIDEO_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

export function formatSources(sources: { title: string; url: string }[]): string {
  const filtered = sources.filter((s) => !isVideoUrl(s.url));
  if (filtered.length === 0) return "";
  return "\n\n📎 Источники:\n" + filtered.map((s) => `${s.title} — ${s.url}`).join("\n");
}
