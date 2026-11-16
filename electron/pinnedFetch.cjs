'use strict';
// HTTPS requests to devices with self-signed certificates, without giving up
// on authenticating the peer. Instead of `rejectUnauthorized:false` on every
// call (which lets anyone on the path read the admin password), the TLS
// connection is opened first, its certificate fingerprint is compared with the
// one we expect, and only then is the HTTP request written to that same socket.
// Nothing — not even headers — is sent to a peer whose certificate changed.
//
// Pure Node, no Electron: unit-testable against a local server.
const tls = require('node:tls');
const http = require('node:http');

class CertChangedError extends Error {
  constructor(expected, actual) {
    super('The controller presented a different certificate than the one trusted for it');
    this.code = 'CERT_CHANGED';
    this.expected = expected;
    this.actual = actual;
  }
}

// Open a TLS connection and resolve { socket, fingerprint } once the handshake
// is done. The certificate chain is NOT validated (self-signed is the norm);
// identity comes from the fingerprint pin the caller checks.
function tlsConnect(u, timeout) {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const socket = tls.connect({
      host,
      port: Number(u.port) || 443,
      rejectUnauthorized: false,
      ...(/^[\d.]+$|:/.test(host) ? {} : { servername: host }), // no SNI for IP literals
    });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeout, () => fail(new Error('Controller timed out')));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const fingerprint = cert && cert.fingerprint256 ? cert.fingerprint256 : '';
      if (!fingerprint) return fail(new Error('Controller presented no certificate'));
      socket.removeListener('error', fail);
      resolve({ socket, fingerprint });
    });
  });
}

// Fingerprint of whatever answers at this https URL — no HTTP is spoken.
async function peekFingerprint(urlLike, { timeout = 15000 } = {}) {
  const u = new URL(urlLike);
  if (u.protocol !== 'https:') return null;
  const { socket, fingerprint } = await tlsConnect(u, timeout);
  socket.destroy();
  return fingerprint;
}

/**
 * One HTTP request. For https, `expectedFp` is REQUIRED and must match the
 * peer's SHA-256 certificate fingerprint, else CertChangedError (before any
 * request bytes are written). Plain http is passed through unpinned.
 * @returns {Promise<{status:number, headers:object, text:string, fingerprint:string|null}>}
 */
async function pinnedRequest(urlLike, { method = 'GET', headers = {}, body = null, expectedFp = null, timeout = 15000 } = {}) {
  const u = new URL(urlLike);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Bad controller URL');
  let socket = null;
  let fingerprint = null;
  if (u.protocol === 'https:') {
    if (!expectedFp) throw new Error('No trusted certificate for this controller');
    ({ socket, fingerprint } = await tlsConnect(u, timeout));
    if (fingerprint !== expectedFp) { socket.destroy(); throw new CertChangedError(expectedFp, fingerprint); }
  }
  // `agent:false` would make Node build a default agent that opens its OWN
  // plain TCP connection and ignores a createConnection option — so the
  // verified socket is handed over through a one-shot agent instead.
  /** @type {any} */
  let agent = false;
  if (socket) {
    agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port) || (socket ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      headers: { Host: u.host, Connection: 'close', ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
      agent,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 32 * 1024 * 1024) req.destroy(new Error('Controller response too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), fingerprint }));
    });
    req.on('error', (err) => { if (socket) socket.destroy(); reject(err); });
    req.setTimeout(timeout, () => req.destroy(new Error('Controller timed out')));
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { pinnedRequest, peekFingerprint, CertChangedError };
