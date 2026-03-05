/** HTTP client for the ChartStrike Pit API (UW data). */

let pitBaseUrl = "http://100.114.112.7:8001";

export function configurePit(url: string): void {
  pitBaseUrl = url;
}

export async function pitFetch<T = unknown>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${pitBaseUrl}${path}`, { signal: controller.signal });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") throw new Error(`Pit API timeout (30s) ${path}`);
    throw err;
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Pit API ${res.status} ${path}: ${body}`);
  }
  return (await res.json()) as T;
}

export function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export async function pitPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${pitBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") throw new Error(`Pit API timeout (15s) POST ${path}`);
    throw err;
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Pit API ${res.status} POST ${path}: ${text}`);
  }
  return (await res.json()) as T;
}
