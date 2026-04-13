/**
 * API URL configuration
 *
 * Uses VITE_NODE_API_URL env var to point directly at the Paima node backend.
 * For deployed environments, falls back to the api- subdomain convention.
 */

function getApiBaseUrl(): string {
  if (import.meta.env.VITE_NODE_API_URL) {
    return import.meta.env.VITE_NODE_API_URL.replace(/\/$/, '');
  }

  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:9996';
  }

  // For deployed environments, use the api- subdomain with same protocol
  const protocol = window.location.protocol;
  return `${protocol}//api-${hostname}`;
}

export const API_BASE_URL = getApiBaseUrl();
