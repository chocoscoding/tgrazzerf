import { TwitterApi } from "twitter-api-v2";
import { getConfig, saveConfig } from "../utils/store";
import { logger } from "../utils/logger";

// Temporary request-token secrets, keyed by oauth_token. Entries live only for
// the few minutes between /auth/start and the X redirect back to /auth/callback.
const pendingSecrets = new Map<string, { secret: string; createdAt: number }>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function prunePending() {
  const now = Date.now();
  for (const [token, entry] of pendingSecrets) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingSecrets.delete(token);
  }
}

/**
 * Step 1 of the 3-legged OAuth 1.0a flow.
 * Returns the X authorize URL to redirect the user's browser to.
 * `callbackUrl` must exactly match a Callback URI registered in the X developer portal.
 */
export async function startXAuth(callbackUrl: string): Promise<string> {
  const config = getConfig();
  if (!config.xApiKey || !config.xApiSecret) {
    throw new Error("X API Key/Secret not configured (set X_API_KEY and X_API_SECRET or save them in the panel)");
  }

  const client = new TwitterApi({ appKey: config.xApiKey, appSecret: config.xApiSecret });
  const link = await client.generateAuthLink(callbackUrl, { linkMode: "authorize" });

  prunePending();
  pendingSecrets.set(link.oauth_token, { secret: link.oauth_token_secret, createdAt: Date.now() });

  logger.info(`[x-auth] Auth link generated (callback: ${callbackUrl})`);
  return link.url;
}

/**
 * Step 2: called when X redirects back to the callback URL.
 * Exchanges the verifier for a permanent access token + secret and saves them
 * into the config so posting works immediately. Returns the connected handle.
 */
export async function completeXAuth(oauthToken: string, oauthVerifier: string): Promise<string> {
  const pending = pendingSecrets.get(oauthToken);
  if (!pending) {
    throw new Error("Unknown or expired login attempt — start again from the control panel");
  }
  pendingSecrets.delete(oauthToken);

  const config = getConfig();
  const client = new TwitterApi({
    appKey: config.xApiKey,
    appSecret: config.xApiSecret,
    accessToken: oauthToken,
    accessSecret: pending.secret,
  });

  const { accessToken, accessSecret, screenName } = await client.login(oauthVerifier);

  config.xAccessToken = accessToken;
  config.xAccessTokenSecret = accessSecret;
  config.xConnectedUser = screenName;
  saveConfig(config);

  logger.info(`[x-auth] Connected as @${screenName}, tokens saved`);
  return screenName;
}
