import svipeConfig from './config';
import {getAccessToken, invalidateAccessToken} from './auth';

type SvipeFetchOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
};

/**
 * fetch() wrapper for the Svipe backend: prepends the (same-origin) base,
 * attaches `Authorization: Bearer`, and does one silent re-auth + retry on 401,
 * mirroring the Android SvipeApi client.
 */
export async function svipeFetch(path: string, options: SvipeFetchOptions = {}): Promise<Response> {
  const {method = 'GET', body, auth = true} = options;

  const run = (token?: string) => fetch(svipeConfig.apiBase + path, {
    method,
    headers: {
      'Accept': 'application/json',
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(token ? {'Authorization': 'Bearer ' + token} : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const token = auth ? await getAccessToken() : undefined;
  let res = await run(token);

  if(res.status === 401 && auth) {
    invalidateAccessToken();
    const fresh = await getAccessToken();
    if(fresh) res = await run(fresh);
  }

  return res;
}

export async function svipeGetJson<T = any>(path: string, auth = true): Promise<T | undefined> {
  const res = await svipeFetch(path, {auth});
  if(!res.ok) return undefined;
  return res.json().catch((): undefined => undefined);
}
