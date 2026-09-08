'use strict';

/**
 * Discord webhook server — basic validation of core functionality.
 *
 * The Discord Interactions API requires:
 * 1. Signature verification using Ed25519 (X-Signature-Ed25519 header)
 * 2. Handling PING interactions for URL verification
 * 3. Processing APPLICATION_COMMAND interactions
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const { DiscordWebhookServer } = loadTs('src/main/discord.ts');

/** Generate a test Ed25519 keypair */
function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Extract the raw public key bytes (32 bytes for Ed25519) from the public key object
  const publicKeyDER = publicKey.export({ format: 'der', type: 'spki' });
  // For Ed25519 SPKI format: the last 32 bytes are the actual public key
  const rawPublicKey = publicKeyDER.slice(-32);
  return { privateKey, publicKey, rawPublicKey, rawPublicKeyHex: rawPublicKey.toString('hex') };
}

/** Sign a message with Ed25519 private key */
function signMessage(message, privateKey) {
  return crypto.sign(null, Buffer.from(message), privateKey);
}

/** A server whose callbacks record what they were handed. */
function makeServer(overrides = {}, publicKeyHex = null) {
  const seen = [];
  // If no public key provided, use a hex string (which the server will convert)
  const publicKey = publicKeyHex || crypto.randomBytes(32).toString('hex');
  const server = new DiscordWebhookServer({
    port: 0,
    publicKey,
    onMessage: (msg) => {
      seen.push(msg);
      if (overrides.onMessage) overrides.onMessage(msg);
    }
  });
  return { server, seen };
}

/** Fire one request through the handler and resolve with `{status, body}`. */
function request(server, { method = 'POST', url = '/', headers = {}, body = undefined }) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;
    req.socket = { remoteAddress: '127.0.0.1' }; // mock loopback for reply server tests
    req.destroy = () => { /* no socket to tear down */ };
    const res = {
      writeHead(status) { res._status = status; return res; },
      end(payload) {
        let parsed = null;
        try { parsed = payload ? JSON.parse(payload) : null; } catch { parsed = payload; }
        resolve({ status: res._status, body: parsed });
      }
    };
    // Access the private handleRequest method for testing
    server.constructor.prototype.handleRequest.call(server, req, res);
    if (method === 'POST') {
      if (body !== undefined) req.emit('data', Buffer.from(body));
      req.emit('end');
    }
  });
}

test('rejects requests without signature headers', async () => {
  const { server } = makeServer();
  const result = await request(server, {
    url: '/',
    headers: {},
    body: JSON.stringify({ type: 1 }) // PING
  });
  assert.equal(result.status, 401, 'missing headers should be 401');
});

test('responds to GET with 405', async () => {
  const { server } = makeServer();
  const result = await request(server, {
    method: 'GET',
    headers: { 'x-signature-ed25519': 'sig', 'x-signature-timestamp': '123' }
  });
  assert.equal(result.status, 405, 'GET should be 405');
});

test('handles invalid JSON body gracefully', async () => {
  const { server } = makeServer();
  const result = await request(server, {
    url: '/',
    headers: { 'x-signature-ed25519': 'sig', 'x-signature-timestamp': '123' },
    body: 'not-json'
  });
  // Will return 400 for bad JSON or 401 for bad signature
  assert.ok([400, 401].includes(result.status));
});

test('accepts well-formed PING interaction (with valid Ed25519 signature)', async () => {
  const keypair = generateTestKeyPair();
  const { server, seen } = makeServer({}, keypair.rawPublicKeyHex);
  
  const pingPayload = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = timestamp + pingPayload;
  const signature = signMessage(message, keypair.privateKey).toString('hex');
  
  const result = await request(server, {
    method: 'POST',
    url: '/',
    headers: {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp
    },
    body: pingPayload
  });

  // With proper signature verification, PING should return 200 with type 1 response
  assert.equal(result.status, 200, 'PING should be accepted');
  assert.equal(result.body?.type, 1, 'PING response should be type 1');
});

test('rejects PING with invalid Ed25519 signature', async () => {
  const keypair = generateTestKeyPair();
  const { server } = makeServer({}, keypair.rawPublicKeyHex);
  
  const pingPayload = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const badSignature = crypto.randomBytes(64).toString('hex'); // Invalid signature
  
  const result = await request(server, {
    method: 'POST',
    url: '/',
    headers: {
      'x-signature-ed25519': badSignature,
      'x-signature-timestamp': timestamp
    },
    body: pingPayload
  });

  assert.equal(result.status, 401, 'invalid signature should be 401');
});

test('accepts APPLICATION_COMMAND with valid signature and calls onMessage', async () => {
  const keypair = generateTestKeyPair();
  const { server, seen } = makeServer({}, keypair.rawPublicKeyHex);

  const messagePayload = JSON.stringify({
    type: 2,
    id: 'msg-123',
    token: 'interaction-token',
    channel_id: 'channel-456',
    member: { user: { username: 'testuser' } },
    data: {
      options: [
        {
          name: 'message',
          type: 3,
          value: 'hello world'
        }
      ]
    }
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = timestamp + messagePayload;
  const signature = signMessage(message, keypair.privateKey).toString('hex');

  const result = await request(server, {
    method: 'POST',
    url: '/',
    headers: {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp
    },
    body: messagePayload
  });

  // Should respond with 200 and type 4 (immediate response)
  assert.equal(result.status, 200, 'APPLICATION_COMMAND should be accepted');
  assert.equal(result.body?.type, 4, 'APPLICATION_COMMAND response should be type 4 (immediate)');
  
  // Should have called onMessage with the extracted text
  assert.equal(seen.length, 1, 'onMessage should be called once');
  assert.equal(seen[0].text, 'hello world', 'extracted text should match');
  assert.equal(seen[0].author, 'testuser', 'extracted author should match');
  assert.equal(seen[0].channel, 'channel-456', 'extracted channel should match');
});

test('server instantiates with correct config', async () => {
  const { server } = makeServer();
  assert.ok(server, 'server should exist');
});

