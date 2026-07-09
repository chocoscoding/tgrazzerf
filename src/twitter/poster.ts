import { TwitterApi } from "twitter-api-v2";
import { logger } from "../utils/logger";

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function buildClient(creds: XCredentials): TwitterApi {
  return new TwitterApi({
    appKey: creds.apiKey,
    appSecret: creds.apiSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessTokenSecret,
  });
}

/**
 * Upload a media buffer and post it as a tweet with the given text.
 * Returns the new tweet's id, or null on failure.
 */
export async function postMediaToX(
  creds: XCredentials,
  text: string,
  media: { buffer: Buffer; mimeType: string },
): Promise<string | null> {
  const client = buildClient(creds);

  try {
    const mediaId = await client.v1.uploadMedia(media.buffer, { mimeType: media.mimeType });
    const result = await client.v2.tweet({ text, media: { media_ids: [mediaId] } });
    const id = result.data.id;
    logger.info(`[x] Tweet posted: https://x.com/i/web/status/${id}`);
    return id;
  } catch (err: any) {
    logger.error(`[x] Tweet failed: ${err.message}`);
    return null;
  }
}

/**
 * Reply under an existing tweet with plain text.
 * Returns the new reply's id, or null on failure.
 */
export async function replyToX(creds: XCredentials, tweetId: string, text: string): Promise<string | null> {
  const client = buildClient(creds);

  try {
    const result = await client.v2.reply(text, tweetId);
    const id = result.data.id;
    logger.info(`[x] Reply posted: https://x.com/i/web/status/${id}`);
    return id;
  } catch (err: any) {
    logger.error(`[x] Reply failed: ${err.message}`);
    return null;
  }
}
