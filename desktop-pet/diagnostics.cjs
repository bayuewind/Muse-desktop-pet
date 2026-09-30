'use strict';
const os = require('node:os');
const STAGES = new Set(['browser_start', 'readiness', 'metadata', 'target', 'vm_policy', 'cookies',
  'session', 'assignment', 'token', 'gateway', 'peer_identity', 'ping', 'browser_cleanup',
  'vault_save', 'source_start', 'account', 'login_probe', 'proxy_resolve', 'network_request']);
const CODES = new Set(['unknown_error', 'supported_browser_missing', 'source_unavailable', 'pairing_cancelled',
  'vm_identity_missing', 'invalid_gateway_target', 'attestation_verifier_required', 'cookie_import_failed',
  'muse_session_cookie_missing', 'auth_network_error', 'authorization_required', 'auth_service_error',
  'auth_invalid_response', 'invalid_session_cookie_update', 'vm_assignment_unavailable', 'vm_identity_unverified',
  'vm_assignment_changed', 'assignment_unverified', 'gateway_token_missing', 'invalid_credentials',
  'handshake_failed', 'gateway_transport_failed', 'gateway_closed', 'gateway_rejected', 'gateway_open_timeout',
  'handshake_timeout', 'peer_verification_timeout', 'peer_verification_failed', 'server_identity_mismatch',
  'verified_peer_policy_required', 'gateway_protocol_error', 'request_timeout', 'rpc_error',
  'os_encryption_unavailable', 'credential_encryption_failed', 'unsafe_vault_path', 'unsafe_login_profile',
  'login_probe_timeout', 'account_pairing_failed', 'login_window_failed', 'login_cleanup_failed',
  'account_cleanup_failed', 'EACCES', 'EPERM', 'ENOSPC', 'EBUSY', 'proxy_resolution_failed',
  'proxy_resolution_timeout', 'proxy_configuration_invalid', 'proxy_type_unsupported', 'network_response_limit']);
const PHASES = new Set(['signed_out', 'opening_login', 'awaiting_login', 'verifying_login', 'connected',
  'clearing', 'cleanup_failed']);
const DETECTION = new Set(['idle', 'watching', 'verifying', 'timed_out', 'window_closed', 'check_failed',
  'verification_failed']);
const READINESS = new Set(['closed', 'loading', 'other_origin', 'http_error', 'metadata_missing',
  'policy_missing', 'ready']);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'TimeoutError', 'AbortError']);
function safeFailure(stage, error) {
  const result = { stage: STAGES.has(stage) ? stage : 'account',
    code: CODES.has(error?.message) ? error.message : CODES.has(error?.code) ? error.code : 'unknown_error' };
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) result.httpStatus = error.httpStatus;
  if (NETWORK_CODES.has(error?.networkCode)) result.networkCode = error.networkCode;
  return result;
}
function safeVersion(value) { return typeof value === 'string' && /^\d+(?:\.\d+){0,3}(?:-[a-z0-9.]+)?$/i.test(value) ? value : 'unknown'; }
// Explicit field selection keeps arbitrary errors, URLs and account data out of reports.
class LoginDiagnostics {
  constructor({ version, electron = process.versions.electron, node = process.versions.node } = {}) {
    this.runtime = { appVersion: safeVersion(version), electron: safeVersion(electron), node: safeVersion(node),
      platform: process.platform, arch: process.arch, osRelease: safeVersion(os.release()) };
    this.events = []; this.startedAt = new Date().toISOString();
  }
  record(value = {}) {
    const event = { stage: STAGES.has(value.stage) ? value.stage : 'account' };
    if (['started', 'passed', 'failed', 'state'].includes(value.status)) event.status = value.status;
    if (['https', 'wss'].includes(value.transport)) event.transport = value.transport;
    if (value.proxySource === 'system') event.proxySource = 'system';
    if (['direct', 'http_proxy', 'https_proxy', 'socks_proxy'].includes(value.route)) event.route = value.route;
    if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) event.httpStatus = value.httpStatus;
    if (value.code !== undefined) Object.assign(event, safeFailure(event.stage,
      { message: value.code, httpStatus: value.httpStatus, networkCode: value.networkCode }));
    if (PHASES.has(value.phase)) event.phase = value.phase;
    if (DETECTION.has(value.detection)) event.detection = value.detection;
    if (READINESS.has(value.readiness)) event.readiness = value.readiness;
    if (['standard', 'unsupported', 'missing'].includes(value.policy)) event.policy = value.policy;
    if (['chrome', 'edge', 'other'].includes(value.browser)) event.browser = value.browser;
    if (value.browserVersion !== undefined) event.browserVersion = safeVersion(value.browserVersion);
    for (const key of ['vmIdentityMatched', 'vmNameMatches', 'endpointMatches']) {
      if (typeof value[key] === 'boolean') event[key] = value[key];
    }
    const signature = JSON.stringify(event);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.events.push({ at: new Date().toISOString(), ...event });
    if (this.events.length > 150) this.events.shift();
  }
  report(accounts) {
    return { schema: 1, generatedAt: new Date().toISOString(), startedAt: this.startedAt,
      scope: 'current_process_only', privacy: 'No cookies, tokens, account identifiers, URLs, paths or chat content.',
      runtime: { ...this.runtime },
      account: { phase: PHASES.has(accounts?.phase) ? accounts.phase : 'unknown',
        detection: DETECTION.has(accounts?.loginDetection) ? accounts.loginDetection : 'unknown',
        lastFailure: accounts?.lastFailure ? safeFailure(accounts.lastFailure.stage,
          { message: accounts.lastFailure.code, httpStatus: accounts.lastFailure.httpStatus, networkCode: accounts.lastFailure.networkCode }) : null },
      events: this.events.map(event => ({ ...event })) };
  }
}
function networkCode(error) {
  for (const value of [error?.cause?.code, error?.code, error?.name]) {
    if (NETWORK_CODES.has(value)) return value;
  }
  return undefined;
}
module.exports = { LoginDiagnostics, safeFailure, networkCode };
