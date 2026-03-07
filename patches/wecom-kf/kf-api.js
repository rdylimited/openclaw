/**
 * WeCom Customer Service (微信客服) API Client
 * Handles sync_msg (pull messages) and send_msg (reply) for external WeChat users.
 */

import { logger } from "../logger.js";
import { getAccessToken } from "./agent-api.js";
import { AGENT_API_REQUEST_TIMEOUT_MS } from "./constants.js";

const KF_API_ENDPOINTS = {
  SYNC_MSG: "https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg",
  SEND_MSG: "https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg",
  ACCOUNT_LIST: "https://qyapi.weixin.qq.com/cgi-bin/kf/account/list",
};

/** Cursor persistence: Map<corpId, cursor> */
const cursorCache = new Map();

/**
 * Fetch new messages from the Customer Service message queue.
 * @param {object} params
 * @param {object} params.agent - { corpId, corpSecret, agentId }
 * @param {string} [params.token] - Token from callback notification
 * @returns {Promise<Array>} List of messages
 */
export async function kfSyncMsg({ agent, token, openKfId }) {
  const accessToken = await getAccessToken(agent);
  const url = `${KF_API_ENDPOINTS.SYNC_MSG}?access_token=${encodeURIComponent(accessToken)}`;

  const cursor = cursorCache.get(agent.corpId) || "";
  const body = { cursor, limit: 1000, open_kfid: openKfId };
  if (token) body.token = token;

  const allMessages = [];
  let hasMore = true;
  let currentCursor = cursor;

  while (hasMore) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, cursor: currentCursor }),
      signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
    });
    const json = await res.json();

    if (json.errcode !== 0) {
      throw new Error(`kf/sync_msg failed: ${json.errcode} ${json.errmsg}`);
    }

    if (json.msg_list?.length) {
      allMessages.push(...json.msg_list);
    }

    currentCursor = json.next_cursor || "";
    hasMore = json.has_more === 1 && currentCursor;
  }

  // Persist cursor for next poll
  if (currentCursor) {
    cursorCache.set(agent.corpId, currentCursor);
  }

  return allMessages;
}

/**
 * Send a text message to a customer via Customer Service.
 * @param {object} params
 * @param {object} params.agent - { corpId, corpSecret, agentId }
 * @param {string} params.toUser - external_userid of the customer
 * @param {string} params.openKfId - Customer service account ID
 * @param {string} params.text - Message text
 */
export async function kfSendText({ agent, toUser, openKfId, text }) {
  const accessToken = await getAccessToken(agent);
  const url = `${KF_API_ENDPOINTS.SEND_MSG}?access_token=${encodeURIComponent(accessToken)}`;

  const body = {
    touser: toUser,
    open_kfid: openKfId,
    msgtype: "text",
    text: { content: text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  const json = await res.json();

  if (json.errcode !== 0) {
    throw new Error(`kf/send_msg failed: ${json.errcode} ${json.errmsg}`);
  }

  logger.info("[kf] message sent", {
    toUser,
    openKfId,
    msgid: json.msgid,
    contentPreview: text.substring(0, 50),
  });

  return json;
}

/**
 * List all customer service accounts.
 * @param {object} params
 * @param {object} params.agent - { corpId, corpSecret, agentId }
 */
export async function kfAccountList({ agent }) {
  const accessToken = await getAccessToken(agent);
  const url = `${KF_API_ENDPOINTS.ACCOUNT_LIST}?access_token=${encodeURIComponent(accessToken)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  const json = await res.json();

  if (json.errcode !== 0) {
    throw new Error(`kf/account/list failed: ${json.errcode} ${json.errmsg}`);
  }

  return json.account_list || [];
}
