/**
 * DiscordWebhookServer — receive Discord interactions and hand them to the harness.
 *
 * A bare `node:http` server that implements the Discord Interactions API to let
 * the user pipe a Discord channel's messages into Rudy's message queue:
 *   - verifies EVERY request with Discord's Ed25519 signature verification,
 *   - answers the one-time PING interaction for URL verification,
 *   - on MESSAGE_CREATE interactions, extracts the message text and emits it
 *     via `onMessage`,
 *   - always responds to interactions within 3 seconds (Discord requirement).
 *
 * It also opens a `tunnelmole` tunnel so the local port is reachable from Discord's
 * servers; the tunnel URL is what the user pastes into their Discord app's
 * Interactions Endpoint URL. The tunnel is best-effort: the local handler is the
 * security boundary and stays up even if the tunnel can't be established.
 *
 * Runs in the Electron main process. Deliberately free of any `electron`
 * import so it can be unit-/smoke-tested as a plain Node module.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, verify } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

/** Reject request bodies larger than this — Discord payloads are relatively small. */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
/** Cap how long we wait for the public tunnel before giving up (server stays up). */
const TUNNEL_START_TIMEOUT_MS = 10_000;

export interface DiscordInboundMessage {
  /** The message author's Discord username. */
  author: string;
  /** The message text content. */
  text: string;
  /** Discord channel ID where the message came from. */
  channel: string;
  /** Discord message ID (used for threading/replies). */
  messageId: string;
  /** Discord interaction token (used for responding to the interaction). */
  interactionToken: string;
}

export interface DiscordWebhookServerOptions {
  /** Local TCP port the HTTP server binds to (and the tunnel forwards to). */
  port: number;
  /** Discord application public key (for signature verification). Required. */
  publicKey: string;
  /** Called once per accepted message. May be async. */
  onMessage: (m: DiscordInboundMessage) => void | Promise<void>;
}

export class DiscordWebhookServer {
  private server: Server | null = null;
  private tunnelUrl: string | null = null;
  private readonly port: number;
  private readonly publicKey: string;
  private readonly onMessage: (m: DiscordInboundMessage) => void | Promise<void>;

  constructor(opts: DiscordWebhookServerOptions) {
    this.port = opts.port;
    this.publicKey = opts.publicKey;
    this.onMessage = opts.onMessage;
  }

  /**
   * Bind the local HTTP server, then open a public tunnel to it. The HTTP
   * handler (the security boundary) is live the instant `listen` resolves; the
   * tunnel is opened afterwards and is non-fatal — if it can't be established
   * (offline, loca.lt down, timed out) the server keeps running and we report
   * the tunnel error without a URL.
   */
  async start(): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (this.server) return { ok: false, error: 'already running' };
    if (!this.publicKey) return { ok: false, error: 'missing public key' };
    try {
      await this.listen();
    } catch (e) {
      this.stop();
      return { ok: false, error: `failed to bind port ${this.port}: ${errMsg(e)}` };
    }
    try {
      const url = await this.openTunnel();
      if (!url) throw new Error('tunnelmole returned empty URL');
      this.tunnelUrl = url;
      // tunnelmole runs in the background; there is no close handle to wire here.
      return { ok: true, url };
    } catch (e) {
      // Tunnel failed after the server was successfully bound.
      // The server stays up so the user can manually configure a static URL or
      // retry the tunnel independently. Return ok:true but with an error message
      // and no URL so the caller knows to retry or configure manually.
      return { ok: true, error: `tunnel unavailable: ${errMsg(e)}` };
    }
  }

  /** Close the HTTP server. Idempotent and best-effort. */
  stop(): void {
    this.tunnelUrl = null;
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
  }

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      const onError = (e: Error): void => reject(e);
      server.once('error', onError);
      server.listen(this.port, () => {
        server.off('error', onError);
        this.server = server;
        resolve();
      });
    });
  }

  private async openTunnel(): Promise<string> {
    // Dynamic import keeps the ESM-only `tunnelmole` out of the CJS require graph.
    const { tunnelmole } = await import('tunnelmole');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), TUNNEL_START_TIMEOUT_MS);
      tunnelmole({ port: this.port })
        .then((url) => { clearTimeout(timer); resolve(url); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** Buffer the raw body (needed verbatim for signature verification) under a size cap. */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413); res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      this.handleBody(req, res, Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (aborted) return;
      try { res.writeHead(400); res.end(); } catch { /* socket already gone */ }
    });
  }

  private handleBody(req: IncomingMessage, res: ServerResponse, rawBody: string): void {
    // 1) Verify the signature before parsing — any failure → 401.
    if (!this.verify(req, rawBody)) {
      res.writeHead(401); res.end();
      return;
    }

    let payload: DiscordPayload;
    try { payload = JSON.parse(rawBody) as DiscordPayload; }
    catch { res.writeHead(400); res.end(); return; }

    // 2) Handle PING interaction for URL verification.
    if (payload.type === 1) { // PING = 1
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 1 })); // PING response = 1
      return;
    }

    // 3) Handle APPLICATION_COMMAND interaction (slash commands and message commands).
    if (payload.type === 2) { // APPLICATION_COMMAND = 2
      // Respond immediately to the interaction (Discord requires within 3 seconds).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 5 })); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5

      // Extract message data.
      const text = payload.data?.options?.[0]?.value?.trim?.() || payload.data?.content?.trim() || '';
      const messageId = payload.id || '';
      const interactionToken = payload.token || '';
      const channel = payload.channel_id || '';
      const author = payload.member?.user?.username || payload.user?.username || 'Unknown';

      // Fire when text is non-empty.
      if (text && messageId && interactionToken && channel) {
        const msg: DiscordInboundMessage = { text, channel, messageId, interactionToken, author };
        try { void this.onMessage(msg); } catch { /* delivery is best-effort */ }
      }
      return;
    }

    // 4) Unknown interaction type — respond with deferred response.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 5 }));
  }

  /**
   * Verify a request is genuinely from Discord using Ed25519 signature verification.
   * Discord sends:
   * - X-Signature-Ed25519: The Ed25519 signature (hex-encoded)
   * - X-Signature-Timestamp: The timestamp
   * We verify: signature over (timestamp + rawBody) matches the public key.
   */
  private verify(req: IncomingMessage, rawBody: string): boolean {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];

    if (typeof signature !== 'string' || typeof timestamp !== 'string') return false;

    try {
      const message = timestamp + rawBody;

      // Discord's public key is provided in PEM format in the config
      // We need to convert it to the right format for Node.js crypto.verify()
      const publicKeyPem = this.formatPublicKey(this.publicKey);

      // Verify using Ed25519 algorithm
      const signatureBuffer = Buffer.from(signature, 'hex');
      const result = verify('ed25519', Buffer.from(message), publicKeyPem, signatureBuffer);
      return result === true;
    } catch (e) {
      // If verification fails or throws, reject the request
      return false;
    }
  }

  /**
   * Format the Discord public key for use with Node.js crypto.verify().
   * Discord provides the public key in raw hex format; we need to convert it
   * to a format Node.js crypto can use.
   */
  private formatPublicKey(publicKeyHex: string): string {
    // If it's already in PEM format, return as-is
    if (publicKeyHex.includes('-----BEGIN')) {
      return publicKeyHex;
    }

    // Otherwise, convert hex public key to DER and wrap in PEM
    // For Ed25519, the public key is 32 bytes (64 hex chars)
    const publicKeyBuffer = Buffer.from(publicKeyHex, 'hex');

    // Create the SubjectPublicKeyInfo DER structure for Ed25519
    // This is a bit complex, but necessary for Node.js crypto to accept it
    const oid = Buffer.from('302a300506032b6570032100', 'hex'); // Ed25519 OID structure
    const der = Buffer.concat([oid, publicKeyBuffer]);

    // Encode to PEM
    const base64 = der.toString('base64');
    const pem = `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
    return pem;
  }
}

/** Minimal shape of the Discord Interactions API payloads we handle. */
interface DiscordPayload {
  type?: number; // 1 = PING, 2 = APPLICATION_COMMAND
  id?: string;
  token?: string;
  channel_id?: string;
  member?: {
    user?: {
      id?: string;
      username?: string;
    };
  };
  user?: {
    id?: string;
    username?: string;
  };
  data?: {
    type?: number; // 4 = MESSAGE
    content?: string;
    options?: Array<{
      name?: string;
      type?: number; // 3 = STRING
      value?: string;
    }>;
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Post a reply into a Discord channel via the interactions API — a raw `node:https`
 * POST (no discord.js dep), matching the repo's zero-SDK approach. The bot token
 * is passed in by the caller: it lives in main's config and never leaves the
 * main process, and is NEVER logged.
 */
export function postDiscordReply(opts: {
  botToken: string;
  channelId: string;
  interactionToken: string;
  messageId: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!opts.botToken) { resolve({ ok: false, error: 'missing bot token' }); return; }
    if (!opts.channelId?.trim()) {
      resolve({ ok: false, error: 'missing channel id' }); return;
    }

    // For Discord, we can either:
    // 1. Use the interaction token (followUp message via interactions API)
    // 2. Post directly to the channel (requires message.send permission)
    // We'll use the direct channel posting approach for simplicity.

    const body = JSON.stringify({ content: opts.text });
    const req = httpsRequest({
      method: 'POST',
      hostname: 'discord.com',
      path: `/api/v10/channels/${opts.channelId}/messages`,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        authorization: `Bot ${opts.botToken}`
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: string; error?: string };
          resolve({ ok: !!json.id, error: json.error });
        } catch { resolve({ ok: false, error: 'bad response from Discord' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: errMsg(e) }));
    req.write(body);
    req.end();
  });
}

/** Per-session shared secret + lazy bot-token accessor for the reply endpoint. */
export interface DiscordReplyServerOptions {
  /** Secret the helper must echo in the `x-md-reply-token` header. */
  token: string;
  /** Latest bot token, read lazily so a config change is picked up at reply time. */
  getBotToken: () => string | undefined;
  /** Fired with a message ID after an agent's DIRECT reply posts successfully. */
  onReplied?: (messageId: string) => void;
}

/**
 * Loopback-only HTTP endpoint that lets a bundled helper script post a Discord
 * reply WITHOUT ever seeing the bot token. Similar to SlackReplyServer but for Discord.
 */
export class DiscordReplyServer {
  private server: Server | null = null;
  private readonly token: string;
  private readonly getBotToken: () => string | undefined;
  private readonly onReplied?: (messageId: string) => void;

  constructor(opts: DiscordReplyServerOptions) {
    this.token = opts.token;
    this.getBotToken = opts.getBotToken;
    this.onReplied = opts.onReplied;
  }

  /** Bind a loopback port (0 ⇒ OS-assigned). Resolves the actual bound port. */
  start(preferredPort = 0): Promise<{ ok: boolean; port?: number; error?: string }> {
    return new Promise((resolve) => {
      if (this.server) { resolve({ ok: false, error: 'already running' }); return; }
      const server = createServer((req, res) => this.handle(req, res));
      const onError = (e: Error): void => { server.off('listening', onListening); resolve({ ok: false, error: errMsg(e) }); };
      const onListening = (): void => {
        server.off('error', onError);
        this.server = server;
        const addr = server.address();
        resolve({ ok: true, port: addr && typeof addr === 'object' ? addr.port : preferredPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // '127.0.0.1' ONLY — the public tunnel forwards the webhook port, never this.
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /** Close the endpoint. Idempotent and best-effort. */
  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Defense in depth: even bound loopback-only, refuse any non-loopback peer.
    if (!isLoopback(req.socket.remoteAddress ?? '')) { res.writeHead(403); res.end(); return; }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/reply') {
      res.writeHead(404); res.end(); return;
    }
    if (!this.checkToken(req.headers['x-md-reply-token'])) { res.writeHead(401); res.end(); return; }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { aborted = true; res.writeHead(413); res.end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let parsed: { channelId?: string; messageId?: string; text?: string };
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); return; }
      const botToken = this.getBotToken();
      if (!botToken) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'no bot token' })); return; }
      if (!parsed.channelId || !parsed.messageId || !parsed.text) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'channelId, messageId, text required' })); return;
      }
      const messageId = parsed.messageId;
      postDiscordReply({
        botToken,
        channelId: parsed.channelId,
        interactionToken: '', // Not needed for direct channel posting
        messageId,
        text: parsed.text
      })
        .then((r) => {
          if (r.ok) { try { this.onReplied?.(messageId); } catch { /* never break the reply */ } }
          res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' }); res.end(JSON.stringify(r));
        })
        .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: errMsg(e) })); });
    });
    req.on('error', () => { if (!aborted) { try { res.writeHead(400); res.end(); } catch { /* socket gone */ } } });
  }

  /** Constant-time match of the request's reply token against the session token. */
  private checkToken(provided: string | string[] | undefined): boolean {
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/** True for IPv4 loopback (127.0.0.0/8) and IPv6 ::1 (incl. v4-mapped form). */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}
