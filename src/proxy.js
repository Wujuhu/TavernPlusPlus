import { ProxyAgent, fetch as undiciFetch } from 'undici';

let cachedDispatcher = null;
let cachedUrl = '';

function getDispatcher(proxyUrl) {
    if (cachedUrl === proxyUrl && cachedDispatcher) {
        return cachedDispatcher;
    }
    cachedDispatcher = new ProxyAgent(proxyUrl);
    cachedUrl = proxyUrl;
    return cachedDispatcher;
}

/**
 * Creates a fetch function that routes requests through an HTTP/HTTPS/SOCKS proxy.
 * If proxyUrl is falsy, returns the global fetch unchanged.
 */
export function createProxyFetch(proxyUrl) {
    if (!proxyUrl) {
        return globalThis.fetch;
    }

    const dispatcher = getDispatcher(proxyUrl);
    return (url, options = {}) => undiciFetch(url, { ...options, dispatcher });
}
