/** HTTP client for the ChartStrike Pit API (UW data). */

let pitBaseUrl = "http://100.114.112.7:8001";

export function configurePit(url: string): void {
  pitBaseUrl = url;
}

export async function pitFetch<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${pitBaseUrl}${path}`);
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
