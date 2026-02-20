/**
 * API URL configuration
 *
 * Derives the backend API URL from the current hostname:
 * - On localhost -> '' (empty, uses Vite proxy to avoid CORS)
 * - On gofish.paimastudios.com -> https://api-gofish.paimastudios.com
 */

function getApiBaseUrl(): string {
  const hostname = window.location.hostname;

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    // Use same-origin requests; Vite dev server proxies to backend on port 9996
    return '';
  }

  // For deployed environments, use the api- subdomain with same protocol
  const protocol = window.location.protocol;
  return `${protocol}//api-${hostname}`;
}

export const API_BASE_URL = getApiBaseUrl();
