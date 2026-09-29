'use strict';
const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const WebSocket = require('ws');
const { NoiseXXInitiator } = require('./noise-xx.cjs');
const { NoiseWire, encode } = require('./wire.cjs');
const { SubscriptionDecoder } = require('./subscription.cjs');
const { DictationDecoder, RATE, MAX_SECONDS } = require('./audio.cjs');
const ROUTES = Object.freeze({
  'connection.ping': ['POST', '/api/ping'],
  'activity.list': ['GET', '/activity'],
  'tasks.list': ['GET', '/tasks'],
  'tasks.runs': ['GET', '/tasks/runs'],
  'subagents.status': ['GET', '/subagents/status'],
  'subagents.list': ['GET', '/subagents'],
  'chat.history': ['GET', '/chat/history'],
  'chat.message_get': ['GET', '/chat/message'],
  'fs.stat': ['POST', '/fs/stat'],
  'fs.read': ['POST', '/fs/read'],
  'chat.subscribe': ['POST', '/chat/subscribe', true],
  'activity.subscribe': ['POST', '/activity/subscribe', true],
  'tasks.subscribe': ['POST', '/tasks/subscribe', true],
});
function verifyStandardBinding(payload, serverKey, clientNonce) {
  // Standard (non-CVM) evidence: outer field 2 contains server static key and
  // the exact client freshness nonce. Reject all other evidence variants.
  const Reader = require('protobufjs').Reader;
  try {
    const outer = Reader.create(payload);
    if (outer.uint32() !== 18) throw new Error('variant');
    const body = Reader.create(outer.bytes());
    if (outer.pos !== outer.len || body.uint32() !== 10) throw new Error('shape');
    const key = Buffer.from(body.bytes());
    if (body.uint32() !== 18) throw new Error('shape');
    const nonce = Buffer.from(body.bytes());
    if (body.pos !== body.len || key.length !== 32 || nonce.length !== 32 ||
        serverKey?.length !== 32 || clientNonce?.length !== 32 ||
        !timingSafeEqual(key, serverKey) || !timingSafeEqual(nonce, clientNonce)) throw new Error('binding');
    return true;
  } catch { throw new Error('attestation_verifier_required'); }
}
function gatewayURL(credentials) {
  const { vmId, authToken, notaryToken } = credentials ?? {};
  if (typeof vmId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(vmId) ||
      typeof authToken !== 'string' || !authToken || authToken.length > 16384 || /[\x00-\x20\x7f]/.test(authToken)) throw new Error('invalid_credentials');
  const url = new URL('wss://hatch.metaaivm.com/v1/noise');
  url.searchParams.set('vm_id', vmId); url.searchParams.set('auth_token', authToken);
  url.searchParams.set('app_id', 'hatch-web'); url.searchParams.set('request_id', randomUUID());
  if (notaryToken) {
    if (typeof notaryToken !== 'string' || notaryToken.length > 16384 || /[\x00-\x20\x7f]/.test(notaryToken)) throw new Error('invalid_credentials');
    url.searchParams.set('notary_token', notaryToken);
  }
  return url;
}
function pinnedStandardVerifier(policy) {
  if (policy?.vmType !== 'standard' || policy?.attestationTier !== 'off' ||
      typeof policy?.serverKeyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(policy.serverKeyHex)) {
    throw new Error('verified_peer_policy_required');
  }
  const expected = Buffer.from(policy.serverKeyHex, 'hex');
  return async ({ payload, serverKey, clientNonce }) => {
    // Do not accept a CVM/attestation-bearing peer without implementing its
    // required verification. Never downgrade or auto-enroll it as standard.
    if (payload.length !== 0 || policy.binding === 'standard-nonce-v1') verifyStandardBinding(payload, serverKey, clientNonce);
    if (serverKey.length !== 32 || !timingSafeEqual(expected, serverKey)) {
      const error = new Error('server_identity_mismatch');
      if (policy.binding === 'standard-nonce-v1') error.candidateKeyHex = serverKey.toString('hex');
      throw error;
    }
    return true;
  };
}
class NativeGateway extends EventEmitter {
  constructor() {
    super(); this.socket = null; this.wire = null; this.pending = new Map();
    this.inbox = []; this.waiter = null; this.closed = false; this.ready = false;
  }
  async connect(credentials, verifyPeer) {
    if (typeof verifyPeer !== 'function') throw new Error('peer_verifier_required');
    if (this.socket) throw new Error('already_started');
    const url = gatewayURL(credentials);
    const ws = new WebSocket(url, { origin: 'https://muse.ai',
      handshakeTimeout: 12000, maxPayload: 4 * 1024 * 1024, followRedirects: false });
    this.socket = ws;
    ws.on('error', () => this.close('gateway_transport_failed'));
    ws.on('close', () => this.close('gateway_closed'));
    ws.on('unexpected-response', (_request, response) => {
      response.resume(); this.close([401, 403].includes(response.statusCode) ? 'authorization_required' : 'gateway_rejected');
    });
    ws.on('message', (data, binary) => {
      try {
        if (!binary) throw new Error('nonbinary_noise_frame');
        if (this.wire) this.dispatch(this.wire.accept(Buffer.from(data)));
        else if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve(Buffer.from(data)); }
        else { if (this.inbox.length >= 4 || data.length > 65535) throw new Error('handshake_queue_limit'); this.inbox.push(Buffer.from(data)); }
      } catch (error) {
        const allowed = new Set(['subscription_protocol_error','unknown_stream','body_before_response','response_limit','rpc_error',
          'invalid_transport_frame','invalid_service_response','cipher_authentication_failed']);
        this.emit('diagnostic', { step: 'incoming_frame_rejected', reason: allowed.has(error.message) ? error.message : 'decode_failure' });
        this.close('gateway_protocol_error');
      }
    });
    const handshake = new NoiseXXInitiator();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('gateway_open_timeout')), 12000);
        const disconnected = reason => finish(new Error(reason));
        const opened = () => finish();
        const finish = error => { clearTimeout(timer); this.removeListener('closed', disconnected); ws.removeListener('open', opened); error ? reject(error) : resolve(); };
        this.once('closed', disconnected); ws.once('open', opened);
      });
      const clientNonce = randomBytes(32);
      ws.send(handshake.writeMessage1(encode('ClientNonce', { nonce: clientNonce })));
      const remote = handshake.readMessage2(await this.nextHandshake());
      remote.clientNonce = clientNonce;
      let verificationTimer;
      try {
        const verified = await Promise.race([verifyPeer(remote), new Promise((_, reject) => {
          verificationTimer = setTimeout(() => reject(new Error('peer_verification_timeout')), 12000);
        })]);
        if (verified !== true) throw new Error('peer_verification_failed');
      } finally { clearTimeout(verificationTimer); }
      ws.send(handshake.writeMessage3());
      const { send, receive } = handshake.split(); this.wire = new NoiseWire(send, receive);
      for (const frame of this.inbox.splice(0)) this.dispatch(this.wire.accept(frame));
      if (this.closed) throw new Error('gateway_closed');
      this.ready = true;
    } catch (error) {
      handshake.destroy(); this.close('handshake_failed');
      // Never forward a ws Error/URL containing the token to a caller/logger.
      const allowed = new Set(['server_identity_mismatch', 'attestation_verifier_required', 'authorization_required', 'verified_peer_policy_required']);
      const safe = new Error(allowed.has(error.message) ? error.message : 'handshake_failed');
      if (safe.message === 'server_identity_mismatch' && /^[a-f0-9]{64}$/.test(error.candidateKeyHex ?? '')) safe.candidateKeyHex = error.candidateKeyHex;
      throw safe;
    }
  }
  nextHandshake() {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('handshake_timeout')); }, 12000);
      this.waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
  }
  request(method, params = {}) {
    if (!Object.hasOwn(ROUTES, method)) return Promise.reject(new Error('read_only_method_required'));
    return this.requestRoute(method, ROUTES[method], params);
  }
  // Explicit interaction-only entry point, never exposed through request().
  sendChat(params) {
    if (typeof params?.message !== 'string' || !params.message.trim() || Buffer.byteLength(params.message) > 32768) {
      const error = new Error('invalid_message'); error.deliveryState = 'not_sent'; return Promise.reject(error);
    }
    return this.requestRoute('chat.stream', ['POST', '/chat/stream', true],
      { message: params.message, capabilities: [] }, { command: true });
  }
  requestRoute(method, route, params = {}, { command = false } = {}) {
    if (!this.ready || this.closed) { const error = new Error('gateway_not_ready'); error.deliveryState = 'not_sent'; return Promise.reject(error); }
    if (this.pending.size >= 128) return Promise.reject(new Error('request_capacity'));
    const [verb, path, subscription] = route;
    let request;
    try { request = this.wire.request(verb, path, params); } catch { this.close('encode_failed'); return Promise.reject(new Error('encode_failed')); }
    return new Promise((resolve, reject) => {
      const entry = { method, subscription, command, commandAcked: false, resolve, reject, body: [], size: 0, status: null, decoder: null };
      const settle = value => {
        if (command && (typeof value?.message_id !== 'string' || !value.message_id)) return;
        entry.commandAcked = command; clearTimeout(entry.timer); resolve(value);
      };
      entry.timer = setTimeout(() => {
        reject(new Error(command ? 'delivery_unconfirmed' : 'request_timeout'));
        if (command) entry.discard = true; else this.close('request_timeout');
      }, 30000);
      if (subscription) entry.decoder = new SubscriptionDecoder({ onAck: settle,
        onEvent: (type, payload, meta) => this.emit('status-event', type, payload, { ...meta, source: method }),
        onChatEvent: (type, payload, meta) => this.emit('chat-event', type, payload, { ...meta, source: method }),
        onDiagnostic: shape => this.emit('diagnostic', { step: 'subscription_record_shape', method, ...shape }) });
      this.pending.set(request.streamId, entry);
      try { for (const frame of request.frames) this.socket.send(frame); }
      catch { this.close('gateway_send_failed'); }
    });
  }
  transcribePCM(pcm) {
    if (!this.ready || this.closed || !Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length < RATE*0.15*2 || pcm.length > RATE*MAX_SECONDS*2) return Promise.reject(new Error('invalid_audio_or_connection'));
    const request = this.wire.startDictation();
    return new Promise((resolve, reject) => {
      const entry = { method: 'voice.dictation', voice: true, status: null, resolve, reject, uploading: false,
        decoder: new DictationDecoder(text => { clearTimeout(entry.timer); resolve(text); }) };
      entry.timer = setTimeout(() => { reject(new Error('dictation_timeout')); this.close('dictation_timeout'); }, 60000);
      entry.onOpen = async () => {
        if (entry.uploading) return; entry.uploading = true;
        try {
          for (let offset = 0; offset < pcm.length; offset += 16384) {
            if (this.closed) throw new Error('dictation_closed');
            for (const frame of this.wire.bodyChunk(request.streamId, pcm.subarray(offset, offset+16384))) {
              await new Promise((done, fail) => this.socket.send(frame, error => error ? fail(new Error('dictation_send_failed')) : done()));
            }
          }
          if (!this.closed) for (const frame of this.wire.bodyChunk(request.streamId, Buffer.alloc(0), true)) this.socket.send(frame);
        } catch { reject(new Error('dictation_send_failed')); this.close('dictation_send_failed'); }
      };
      this.pending.set(request.streamId, entry);
      try { for (const frame of request.frames) this.socket.send(frame); }
      catch { this.close('dictation_send_failed'); }
    });
  }
  dispatch(frame) {
    if (!frame || this.closed) return;
    const entry = this.pending.get(frame.streamId);
    if (!entry) throw new Error('unknown_stream');
    if (entry.discard) {
      if (frame.kind === 'reset' || frame.value.endBody) this.pending.delete(frame.streamId);
      return;
    }
    if (frame.kind === 'reset') {
      if (entry.command) { clearTimeout(entry.timer); entry.reject(new Error('delivery_unconfirmed')); this.pending.delete(frame.streamId); }
      else this.close('subscription_reset');
      return;
    }
    let bytes, end;
    if (frame.kind === 'response') {
      entry.status = frame.value.status;
      if (entry.status < 200 || entry.status >= 300) {
        const reason = [401, 403].includes(entry.status) ? 'authorization_required' : 'rpc_rejected';
        const error = new Error(reason); error.httpStatus = entry.status; error.method = entry.method;
        try {
          const data = JSON.parse(Buffer.from(frame.value.body).toString());
          const message = typeof data.error === 'string' ? data.error : data.error?.message ?? '';
          error.requiredFields = ['agent_id','session_id','job_id','id'].filter(field => new RegExp(`\\b${field}\\b`).test(message));
        } catch {}
        clearTimeout(entry.timer); entry.reject(error);
        if ([401, 403].includes(entry.status)) this.close(reason);
        else if (frame.value.endBody) this.pending.delete(frame.streamId);
        else entry.discard = true;
        return;
      }
      bytes = frame.value.body; end = frame.value.endBody;
      if (entry.voice) void entry.onOpen();
      if (entry.subscription && !end && !entry.command) {
        // An open 2xx stream is already admitted. Some channels send no ACK
        // until the next scheduled event, which may be minutes later.
        clearTimeout(entry.timer);
        entry.resolve({ accepted: true, awaitingInitialRecord: !entry.decoder.acked });
      }
    } else {
      if (entry.status == null) throw new Error('body_before_response');
      bytes = frame.value.data; end = frame.value.endBody;
    }
    if (entry.voice) {
      entry.decoder.push(bytes, end);
    } else if (entry.subscription) {
      entry.decoder.push(bytes, end);
      // Muse permits a completed response containing the ACK followed by event
      // chunks on the same stream. A subsequent stream end requires resubscribe.
      if (entry.command && end) {
        clearTimeout(entry.timer); this.pending.delete(frame.streamId);
        if (!entry.commandAcked) entry.reject(new Error('delivery_unconfirmed'));
      } else if (end && frame.kind === 'bodyChunk') this.close('subscription_ended');
    } else {
      entry.size += bytes.length;
      if (entry.size > 4 * 1024 * 1024) throw new Error('response_limit');
      entry.body.push(Buffer.from(bytes));
      if (end) {
        const text = Buffer.concat(entry.body).toString('utf8');
        const value = text ? JSON.parse(text) : {};
        if (value?.ok === false || value?.error) throw new Error('rpc_error');
        clearTimeout(entry.timer); this.pending.delete(frame.streamId);
        entry.resolve(value?.result ?? value);
      }
    }
  }
  close(reason = 'client_closed') {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    this.waiter?.reject(new Error(reason)); this.waiter = null; this.inbox = [];
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    this.pending.clear(); this.wire?.destroy(); this.socket?.terminate(); this.emit('closed', reason);
  }
}
module.exports = { NativeGateway, gatewayURL, pinnedStandardVerifier, verifyStandardBinding, ROUTES };
