/** HTTP client for qwen3-4b-scout vLLM instance. */

let scoutBaseUrl = "http://100.115.36.67:8082";
let scoutModel = "qwen3-4b-scout";

export function configureScout(url: string, model: string): void {
  scoutBaseUrl = url;
  scoutModel = model;
}

export type ScoutVerdict = {
  verdict: "bull" | "bear" | "hold";
  confidence: number;
  summary: string;
};

export async function scoutAnalyze(ticker: string, context: string): Promise<ScoutVerdict> {
  const res = await fetch(`${scoutBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: scoutModel,
      messages: [
        {
          role: "system",
          content:
            "You are a fast market scout. Analyze the provided data and respond ONLY with JSON: " +
            '{"verdict":"bull"|"bear"|"hold","confidence":0.0-1.0,"summary":"2 sentences max"}',
        },
        {
          role: "user",
          content: `Analyze ${ticker}:\n${context}`,
        },
      ],
      max_tokens: 256,
      temperature: 0.3,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Scout API ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim() ?? "";

  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}") + 1;
    if (start >= 0 && end > start) {
      return JSON.parse(raw.substring(start, end)) as ScoutVerdict;
    }
  } catch {
    /* fall through */
  }

  return { verdict: "hold", confidence: 0.5, summary: raw.slice(0, 200) };
}
