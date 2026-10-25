/** Deployment-controlled endpoint. Parent messages must never choose it. */
export function trustedApiUrl(configured: string | undefined, development: boolean): string {
  const url = new URL(configured ?? (development ? "http://localhost:3000" : "https://api.swish.cash"));
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("VITE_SWISH_API_URL must be an API origin");
  }
  if (url.protocol !== "https:" && !(development && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("VITE_SWISH_API_URL must use HTTPS (HTTP loopback is allowed in development)");
  }
  return url.origin;
}
