/**
 * Svipe backend configuration for the web client.
 *
 * The recsys API (auth + feed + discover) is reverse-proxied SAME-ORIGIN under
 * /v1 by the web host's nginx (the FastAPI app ships no CORS headers), so all
 * API calls use relative paths. requestWebView, however, needs the bot's own
 * web-app URL on the backend host, so webAppUrl is absolute.
 *
 * Environment is picked from the hostname, mirroring Android's isBetaApp split:
 *   prod  → web.svipe.uz / svipe.uz          → @Svipe_auth_bot, svipe.uz
 *   dev   → web.abdinazarov.uz / localhost   → @Lavha_auth_bot, lavha-dev.abdinazarov.uz
 */
const host = typeof location !== 'undefined' ? location.hostname : '';
const IS_PROD = host === 'web.svipe.uz' || host === 'svipe.uz';

export const svipeConfig = {
  isProd: IS_PROD,
  // Same-origin; nginx proxies /v1/* to the backend container.
  apiBase: '',
  botUsername: IS_PROD ? 'Svipe_auth_bot' : 'Lavha_auth_bot',
  backendOrigin: IS_PROD ? 'https://svipe.uz' : 'https://lavha-dev.abdinazarov.uz',
  get webAppUrl() {
    return this.backendOrigin + '/webapp';
  }
};

export default svipeConfig;
