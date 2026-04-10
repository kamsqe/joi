import type { LLMMessage, Env } from "./config";

// ─── Cloudflare Workers AI (Gemma 2) ─────────────────────────────────────────

export async function callWorkersAI(
  env: Env,
  messages: LLMMessage[],
  systemPrompt: string,
  maxTokens: number,
  temperature: number,
): Promise<string | null> {
  const aiMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  try {
    const result = await (env.AI as any).run("@cf/google/gemma-2-9b-it", {
      messages: aiMessages,
      max_tokens: maxTokens,
      temperature,
    }) as { response?: string };

    return result.response ?? null;
  } catch (err) {
    console.error("Workers AI error:", err);
    return null;
  }
}

// ─── Gemini API (Single Key) ──────────────────────────────────────────────────

export async function callGemini(
  apiKey: string,
  messages: LLMMessage[],
  systemPrompt: string,
  maxTokens: number = 512,
  temperature: number = 0.75,
): Promise<string | null> {
  const model = "gemini-3.1-flash-lite-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const lastContent = contents[contents.length - 1];

    if (lastContent && lastContent.role === role) {
      lastContent.parts[0].text += "\n" + msg.content;
    } else {
      contents.push({ role, parts: [{ text: msg.content }] });
    }
  }

  if (contents.length > 0 && contents[0].role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "." }] });
  }

  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "Привет" }] });
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`Gemini ${res.status}:`, await res.text());
      return null;
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (err) {
    console.error("Gemini context error:", err);
    return null;
  }
}
