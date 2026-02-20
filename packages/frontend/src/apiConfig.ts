/**
 * API URL configuration
 *
 * Derives the backend API URL from the current hostname:
 * - On gofish.paimastudios.com -> https://api-gofish.paimastudios.com
 * - On localhost -> http://localhost:9996
 */

function getApiBaseUrl(): string {
  const hostname = window.location.hostname;

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:9996';
  }

  // For deployed environments, use the api- subdomain with same protocol
  const protocol = window.location.protocol;
  return `${protocol}//api-${hostname}`;
}

export const API_BASE_URL = getApiBaseUrl();
