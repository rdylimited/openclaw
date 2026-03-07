/**
 * WeCom Customer Service (微信客服) Inbound Handler
 *
 * Handles callbacks from WeCom Customer Service:
 * - GET  /webhooks/kf → URL verification (same as agent)
 * - POST /webhooks/kf → Event notification → sync_msg → process → send_msg
 *
 * Flow: WeCom notifies us of new messages → we pull via sync_msg → route to
 * OpenClaw agent → reply via kf/send_msg.
 */

import { logger } from "../logger.js";
import { WecomCrypto } from "../crypto.js";
import {
  generateAgentId,
  getDynamicAgentConfig,
  shouldUseDynamicAgent,
} from "../dynamic-agent.js";
import { resolveWecomCommandAuthorized } from "./allow-from.js";
import { checkCommandAllowlist, getCommandConfig, isWecomAdmin } from "./commands.js";
import { MAX_REQUEST_BODY_SIZE } from "./constants.js";
import { getRuntime, resolveAgentConfig } from "./state.js";
import { ensureDynamicAgentListed } from "./workspace-template.js";
import { extractEncryptFromXml } from "./xml-parser.js";
import { agentDownloadMedia } from "./agent-api.js";
import { transcribeAudio } from "./asr-client.js";
import { kfSyncMsg, kfSendText } from "./kf-api.js";

// ── Message deduplication ──────────────────────────────────────────────

const RECENT_MSGID_TTL_MS = 10 * 60 * 1000;
const recentKfMsgIds = new Map();

/** Skip messages older than service start to prevent re-processing after restart. */
const SERVICE_START_EPOCH = Math.floor(Date.now() / 1000);

function rememberKfMsgId(msgId) {
  const now = Date.now();
  const existing = recentKfMsgIds.get(msgId);
  if (existing && now - existing < RECENT_MSGID_TTL_MS) return false;
  recentKfMsgIds.set(msgId, now);
  for (const [k, ts] of recentKfMsgIds) {
    if (now - ts >= RECENT_MSGID_TTL_MS) recentKfMsgIds.delete(k);
  }
  return true;
}

// ── HTTP body reader ───────────────────────────────────────────────────

async function readRawBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── URL Verification (GET) ─────────────────────────────────────────────

function handleUrlVerification(req, res, crypto) {
  const url = new URL(req.url || "", "http://localhost");
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const echostr = url.searchParams.get("echostr") || "";
  const msgSignature = url.searchParams.get("msg_signature") || "";

  const expectedSig = crypto.getSignature(timestamp, nonce, echostr);
  if (expectedSig !== msgSignature) {
    logger.warn("[kf-inbound] URL verification: signature mismatch");
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized");
    return true;
  }

  try {
    const { message: plainEchostr } = crypto.decrypt(echostr);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(plainEchostr);
    logger.info("[kf-inbound] URL verification successful");
    return true;
  } catch (err) {
    logger.error("[kf-inbound] URL verification: decrypt failed", { error: err.message });
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("decrypt failed");
    return true;
  }
}

// ── Event Notification (POST) ──────────────────────────────────────────

async function handleEventNotification(req, res, crypto, agentConfig, config) {
  try {
    const rawXml = await readRawBody(req);
    logger.debug("[kf-inbound] received callback", { bodyBytes: Buffer.byteLength(rawXml, "utf8") });

    const encrypted = extractEncryptFromXml(rawXml);
    const url = new URL(req.url || "", "http://localhost");
    const timestamp = url.searchParams.get("timestamp") || "";
    const nonce = url.searchParams.get("nonce") || "";
    const msgSignature = url.searchParams.get("msg_signature") || "";

    // Verify signature
    const expectedSig = crypto.getSignature(timestamp, nonce, encrypted);
    if (expectedSig !== msgSignature) {
      logger.warn("[kf-inbound] event callback: signature mismatch");
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("unauthorized");
      return true;
    }

    // Decrypt to get the Token for sync_msg
    const { message: decryptedXml } = crypto.decrypt(encrypted);

    // Extract Token from decrypted XML
    const tokenMatch = decryptedXml.match(/<Token><!\[CDATA\[(.*?)\]\]><\/Token>/);
    const syncToken = tokenMatch?.[1] || "";

    logger.info("[kf-inbound] event notification received", { hasToken: Boolean(syncToken) });

    // Respond immediately — async processing follows
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("success");

    // Pull and process messages asynchronously
    processKfMessages({ agentConfig, config, syncToken }).catch((err) => {
      logger.error("[kf-inbound] async processing failed", { error: err.message });
    });

    return true;
  } catch (err) {
    logger.error("[kf-inbound] callback failed", { error: err.message });
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("error");
    return true;
  }
}

// ── Async Message Processing ───────────────────────────────────────────

async function processKfMessages({ agentConfig, config, syncToken }) {
  // Resolve openKfId from config
  const openKfId = config?.channels?.wecom?.kf?.openKfId || "";
  if (!openKfId) {
    logger.error("[kf-inbound] openKfId not configured in channels.wecom.kf.openKfId");
    return;
  }

  // Pull messages via sync_msg
  const messages = await kfSyncMsg({ agent: agentConfig, token: syncToken, openKfId });

  if (!messages.length) {
    logger.debug("[kf-inbound] no new messages");
    return;
  }

  logger.info("[kf-inbound] pulled messages", { count: messages.length });

  for (const msg of messages) {
    try {
      // Skip non-text messages and events for now
      if (msg.msgtype === "event") {
        logger.info("[kf-inbound] event", {
          eventType: msg.event?.event_type,
          openKfId: msg.open_kfid,
          externalUserId: msg.external_userid,
        });

        // Send welcome on enter_session
        if (msg.event?.event_type === "enter_session" && msg.event?.external_userid) {
          await kfSendText({
            agent: agentConfig,
            toUser: msg.event.external_userid,
            openKfId: msg.event.open_kfid || openKfId,
            text: "你好！👋 有什么我可以帮你的吗？",
          });
        }
        continue;
      }

      // Only process messages FROM customers (origin 3 = customer, 5 = system)
      if (msg.origin !== 3) {
        logger.debug("[kf-inbound] skipping non-customer message", { origin: msg.origin, msgtype: msg.msgtype });
        continue;
      }

      // Skip stale messages (sent before this service started) to prevent
      // re-processing after restart when cursor cache is empty
      if (msg.send_time && msg.send_time < SERVICE_START_EPOCH) {
        logger.debug("[kf-inbound] skipping stale message (pre-restart)", {
          msgId: msg.msgid, sendTime: msg.send_time, serviceStart: SERVICE_START_EPOCH,
        });
        continue;
      }

      // Deduplication
      if (msg.msgid && !rememberKfMsgId(msg.msgid)) {
        logger.debug("[kf-inbound] duplicate msgId, skipping", { msgId: msg.msgid });
        continue;
      }

      // ── Extract content and media ──────────────────────────────────
      let content = msg.text?.content || "";
      const mediaPaths = [];
      const mediaTypes = [];

      if (["image", "voice", "video", "file"].includes(msg.msgtype)) {
        // KF messages have media_id in their type-specific field
        const mediaId =
          msg.image?.media_id ||
          msg.voice?.media_id ||
          msg.video?.media_id ||
          msg.file?.media_id ||
          "";

        if (mediaId) {
          try {
            const runtime = getRuntime();
            const core = runtime.channel;
            logger.debug("[kf-inbound] downloading media", { mediaId, msgtype: msg.msgtype });
            const { buffer, contentType } = await agentDownloadMedia({
              agent: agentConfig,
              mediaId,
            });
            const fileName = msg.file?.file_name || `${mediaId}.bin`;
            const saved = await core.media.saveMediaBuffer(
              buffer,
              contentType,
              "inbound",
              25 * 1024 * 1024,
              fileName,
            );
            logger.info("[kf-inbound] media saved", { path: saved.path, size: buffer.length });
            mediaPaths.push(saved.path);
            mediaTypes.push(contentType);

            // Transcribe voice messages via ASR
            if (msg.msgtype === "voice" && saved.path) {
              const transcript = await transcribeAudio(saved.path);
              if (transcript) {
                content = transcript;
                logger.info("[kf-inbound] voice transcribed via ASR", { preview: transcript.substring(0, 80) });
              }
            }

            if (!content.trim()) {
              const typeLabels = { image: "图片", voice: "语音", video: "视频", file: "文件" };
              content = `[用户发送了一${msg.msgtype === "file" ? "个" : "张"}${typeLabels[msg.msgtype] || "媒体"}]`;
            }
          } catch (err) {
            logger.error("[kf-inbound] media download failed", { error: err.message, mediaId });
            if (!content.trim()) {
              content = `[用户发送了媒体，但处理失败: ${err.message}]`;
            }
          }
        }
      }

      if (!content.trim()) {
        logger.debug("[kf-inbound] empty content after media processing, skipping", { msgtype: msg.msgtype });
        continue;
      }

      logger.info("[kf-inbound] processing message", {
        msgtype: msg.msgtype,
        externalUserId: msg.external_userid,
        openKfId: msg.open_kfid,
        contentPreview: content.substring(0, 100),
        hasMedia: mediaPaths.length > 0,
      });

      await dispatchKfMessage({
        agentConfig,
        config,
        externalUserId: msg.external_userid,
        openKfId: msg.open_kfid,
        content,
        mediaPaths,
        mediaTypes,
      });
    } catch (err) {
      logger.error("[kf-inbound] message processing error", {
        msgId: msg.msgid,
        error: err.message,
      });
    }
  }
}

// ── Dispatch to OpenClaw Agent ─────────────────────────────────────────

async function dispatchKfMessage({ agentConfig, config, externalUserId, openKfId, content, mediaPaths = [], mediaTypes = [] }) {
  const runtime = getRuntime();
  const core = runtime.channel;

  const peerId = externalUserId;
  const peerKind = "dm";

  // Dynamic agent routing — one agent per external user
  const dynamicConfig = getDynamicAgentConfig(config);
  const targetAgentId =
    dynamicConfig.enabled
      ? generateAgentId("kf", peerId)
      : null;

  if (targetAgentId) {
    await ensureDynamicAgentListed(targetAgentId, { source: "kf" });
    logger.debug("[kf-inbound] dynamic agent", { agentId: targetAgentId, peerId });
  }

  // Route resolution
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: "default",
    peer: { kind: peerKind, id: peerId },
  });

  if (targetAgentId) {
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:kf:${peerId}`;
  }

  // Build inbound context
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.reply.formatAgentEnvelope({
    channel: "WeChat Customer Service",
    from: externalUserId,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: content,
  });

  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: "default",
    senderId: externalUserId,
  });

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    RawBody: content,
    CommandBody: content,
    From: `wecom-kf:${externalUserId}`,
    To: `wecom-kf:${openKfId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: `KF:${externalUserId}`,
    SenderName: externalUserId,
    SenderId: externalUserId,
    Provider: "wecom-kf",
    Surface: "wecom-kf",
    OriginatingChannel: "wecom-kf",
    OriginatingTo: `wecom-kf:${openKfId}`,
    CommandAuthorized: commandAuthorized,
    ...(mediaPaths.length > 0 && { MediaPaths: mediaPaths }),
    ...(mediaTypes.length > 0 && { MediaTypes: mediaTypes }),
  });

  // Record session
  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error("[kf-inbound] session record failed", { error: err.message });
    });

  // Dispatch to LLM and reply via kf/send_msg
  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    replyOptions: {
      disableBlockStreaming: true,
    },
    dispatcherOptions: {
      deliver: async (payload, info) => {
        const text = payload.text ?? "";
        if (!text.trim()) return;

        try {
          await kfSendText({
            agent: agentConfig,
            toUser: externalUserId,
            openKfId,
            text,
          });
          logger.info("[kf-inbound] reply delivered", {
            kind: info.kind,
            toUser: externalUserId,
            openKfId,
            contentPreview: text.substring(0, 50),
          });
        } catch (err) {
          logger.error("[kf-inbound] reply delivery failed", { error: err.message });
        }
      },
      onError: (err, info) => {
        logger.error("[kf-inbound] dispatch error", { kind: info.kind, error: err.message });
      },
    },
  });
}

// ── Public Entry Point ─────────────────────────────────────────────────

/**
 * Handle Customer Service inbound webhook request.
 *
 * @param {object} params
 * @param {import("http").IncomingMessage} params.req
 * @param {import("http").ServerResponse} params.res
 * @param {object} params.kfAccount - { token, encodingAesKey, corpId, corpSecret, agentId }
 * @param {object} params.config - Full openclaw config
 */
export async function handleKfInbound({ req, res, kfAccount, config }) {
  const crypto = new WecomCrypto(kfAccount.token, kfAccount.encodingAesKey);
  const agentConfig = {
    corpId: kfAccount.corpId,
    corpSecret: kfAccount.corpSecret,
    agentId: kfAccount.agentId,
  };

  if (req.method === "GET") {
    return handleUrlVerification(req, res, crypto);
  }

  if (req.method === "POST") {
    return handleEventNotification(req, res, crypto, agentConfig, config);
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
  return true;
}


// ── Exported for agent-inbound kf_msg_or_event routing ─────────────────

export { processKfMessages as processKfNotification };
