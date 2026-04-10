// ─── Weather Feature ────────────────────────────────────────────────────────

import type { Env } from "./config";

// ─── Primary: Scrape Telegram Channel ────────────────────────────────────────

async function fetchFromTelegramChannel(): Promise<string | null> {
  try {
    const res = await fetch("https://t.me/s/almatylive_kz", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)",
      },
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Extract message texts from the channel page
    const messageRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    const messages: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = messageRegex.exec(html)) !== null) {
      const text = match[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      if (text.length > 0) {
        messages.push(text);
      }
    }

    // Search from latest to oldest for the daily weather post
    // It always contains temperature (°) and time-of-day weather blocks
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const lower = msg.toLowerCase();

      // Must contain temperature + time-of-day pattern (утром/днём/вечером)
      if (lower.includes("°") && (lower.includes("утром") || lower.includes("днём"))) {
        return cleanWeatherPost(msg);
      }
    }

    return null;
  } catch (err) {
    console.error("Telegram channel scrape error:", err);
    return null;
  }
}

// ─── Clean Weather Post ─────────────────────────────────────────────────────

function cleanWeatherPost(raw: string): string {
  let text = raw;

  // Replace "Доброе утро, Алматы" with "Доброе утро, джиги"
  text = text.replace(/Доброе утро,?\s*Алматы/i, "Доброе утро, джиги");

  // Remove the Almaty Live subscription footer
  // Matches variations like "⛰Almaty Live. Подписаться. (https://...)"
  text = text.replace(/⛰\s*Almaty\s*Live[\s\S]*$/i, "");

  // Also catch just the link line if formatted differently
  text = text.replace(/Подписаться[.\s]*\(https?:\/\/[^\)]+\)/gi, "");

  // Clean up trailing whitespace/newlines
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

// ─── Fallback: wttr.in ──────────────────────────────────────────────────────

async function fetchFromWttr(): Promise<string | null> {
  try {
    const res = await fetch("https://wttr.in/Almaty?format=4&lang=ru", {
      headers: { "User-Agent": "curl/7.0" },
    });

    if (!res.ok) return null;

    const text = await res.text();
    if (!text.trim()) return null;

    // Wrap wttr.in output in our format
    return `Доброе утро, джиги ☀️\n\n${text.trim()}`;
  } catch (err) {
    console.error("wttr.in error:", err);
    return null;
  }
}

// ─── Public: Fetch Weather ──────────────────────────────────────────────────

export async function fetchWeather(_env: Env): Promise<string> {
  const channelWeather = await fetchFromTelegramChannel();
  if (channelWeather) return channelWeather;

  const wttrWeather = await fetchFromWttr();
  if (wttrWeather) return wttrWeather;

  return "Не удалось получить данные о погоде 😔";
}
