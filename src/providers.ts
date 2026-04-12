import type { LLMMessage, Env } from "./config";

// ─── Gemini API ──────────────────────────────────────────────────────────────

export async function callGemini(
  apiKey: string,
  messages: LLMMessage[],
  systemPrompt: string,
  maxTokens: number = 512,
  temperature: number = 0.75,
  model: string = "gemini-3.1-flash-lite-preview",
  thinkBudget?: number,
): Promise<string | null> {
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

  const body: any = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      ...(thinkBudget !== undefined ? { thinkingConfig: { thinkBudget } } : {}),
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
    ],
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
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number };
    };

    const candidate = data?.candidates?.[0];
    // With thinking enabled, parts = [{thought:true, text:"..."}, {text:"response"}]
    // Pick the last non-thought part
    const parts = candidate?.content?.parts || [];
    const responsePart = parts.filter((p: any) => !p.thought).pop();
    const text = responsePart?.text ?? null;

    // Diagnostic logging (includes cache hit detection)
    const usage = data?.usageMetadata;
    console.log(`[Gemini] model=${model} finish=${candidate?.finishReason} prompt=${usage?.promptTokenCount} cached=${usage?.cachedContentTokenCount ?? 0} output=${usage?.candidatesTokenCount} total=${usage?.totalTokenCount} textLen=${text?.length ?? 0}`);

    return text;
  } catch (err) {
    console.error("Gemini context error:", err);
    return null;
  }
}
