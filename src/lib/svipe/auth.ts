import type {User, WebViewResult} from '@layer';
import rootScope from '@lib/rootScope';
import svipeConfig from './config';

/**
 * Svipe backend authentication, replicating the Android SvipeAuth chain:
 *   cached access token → POST /v1/auth/refresh → requestWebView initData login.
 *
 * The web client is itself a full MTProto client, so it mints Telegram-signed
 * Mini-App initData the same way Android does — messages.requestWebView on the
 * Svipe auth bot (from_bot_menu), then scrape tgWebAppData out of the returned
 * URL fragment — and POSTs it to /v1/auth/telegram/webapp. No web view is ever
 * rendered.
 */

const ACCESS_KEY = 'svipe_access_token';
const REFRESH_KEY = 'svipe_refresh_token';
const EXPIRES_KEY = 'svipe_token_expires';
const EXPIRY_MARGIN_MS = 60_000;

type TokenResponse = {
  status?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

let inFlight: Promise<string | undefined> | undefined;

function storeTokens(res: TokenResponse) {
  if(!res.access_token) return;
  localStorage.setItem(ACCESS_KEY, res.access_token);
  // A refresh response may omit refresh_token — keep the existing one then.
  if(res.refresh_token) localStorage.setItem(REFRESH_KEY, res.refresh_token);
  const ttl = (res.expires_in || 3600) * 1000;
  localStorage.setItem(EXPIRES_KEY, String(Date.now() + ttl));
}

function getValidStoredToken(): string | undefined {
  const token = localStorage.getItem(ACCESS_KEY);
  const expires = Number(localStorage.getItem(EXPIRES_KEY) || 0);
  if(token && Date.now() < expires - EXPIRY_MARGIN_MS) return token;
  return undefined;
}

export function invalidateAccessToken() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(EXPIRES_KEY);
}

/** Pull the once-URL-decoded tgWebAppData query string out of a web-view URL. */
function extractInitData(url: string): string | undefined {
  const hash = url.indexOf('#');
  if(hash === -1) return undefined;
  const fragment = url.slice(hash + 1);
  for(const param of fragment.split('&')) {
    if(param.startsWith('tgWebAppData=')) {
      // Single decode on the client; the backend's parse_qsl does the second,
      // matching how Telegram computes the HMAC (Android does the same).
      return decodeURIComponent(param.slice('tgWebAppData='.length));
    }
  }
  return undefined;
}

async function apiPost(path: string, body: unknown): Promise<TokenResponse | undefined> {
  const res = await fetch(svipeConfig.apiBase + path, {
    method: 'POST',
    headers: {'Accept': 'application/json', 'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  if(res.status === 401) {
    // Refresh token dead — drop it so we fall through to a fresh webapp login.
    localStorage.removeItem(REFRESH_KEY);
    return undefined;
  }
  if(!res.ok) return undefined;
  return res.json().catch((): undefined => undefined);
}

async function tryRefresh(): Promise<string | undefined> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if(!refresh) return undefined;
  const res = await apiPost('/v1/auth/refresh', {refresh_token: refresh});
  if(res?.status === 'ok' && res.access_token) {
    storeTokens(res);
    return res.access_token;
  }
  return undefined;
}

async function webAppLogin(): Promise<string | undefined> {
  const managers = rootScope.managers;

  const peer = await managers.appUsersManager.resolveUsername(svipeConfig.botUsername);
  if(!peer || peer._ !== 'user') return undefined;
  const botId = (peer as User.user).id;

  const result = await managers.appAttachMenuBotsManager.requestWebView({
    botId,
    peerId: botId.toPeerId(false),
    url: svipeConfig.webAppUrl,
    fromBotMenu: true
  }) as WebViewResult.webViewResultUrl;

  const initData = result?.url && extractInitData(result.url);
  if(!initData) return undefined;

  const res = await apiPost('/v1/auth/telegram/webapp', {init_data: initData});
  if(res?.status === 'ok' && res.access_token) {
    storeTokens(res);
    return res.access_token;
  }
  return undefined;
}

async function resolveToken(): Promise<string | undefined> {
  const cached = getValidStoredToken();
  if(cached) return cached;
  const refreshed = await tryRefresh();
  if(refreshed) return refreshed;
  return webAppLogin();
}

/** Single-flight: concurrent callers share one auth attempt. */
export function getAccessToken(): Promise<string | undefined> {
  if(inFlight) return inFlight;
  inFlight = resolveToken().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
