'use strict';

const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 210000;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function randomToken(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value || '')));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password, iterations = PASSWORD_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(String(password), salt, iterations);
  return `pbkdf2-sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function verifyPassword(password, stored) {
  const [algorithm, rawIterations, rawSalt, rawHash] = String(stored || '').split('$');
  if (algorithm !== 'pbkdf2-sha256') return false;
  const iterations = Number(rawIterations);
  if (!Number.isSafeInteger(iterations) || iterations < 100000 || !rawSalt || !rawHash) return false;
  try {
    const actual = await derivePassword(String(password), base64ToBytes(rawSalt), iterations);
    return timingSafeEqual(actual, base64ToBytes(rawHash));
  } catch (_) {
    return false;
  }
}

async function clientPasswordProof(password, name, phone, iterations = PASSWORD_ITERATIONS) {
  const salt = encoder.encode(`shenzhen-tutor-v1|${String(name || '').trim()}|${String(phone || '').trim()}`);
  return bytesToBase64(await derivePassword(String(password || ''), salt, iterations))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function proofCredential(passwordProof, pepper) {
  if (!passwordProof || !pepper) throw new Error('password proof and AUTH_PEPPER are required');
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(pepper)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(String(passwordProof)));
  return `proof-hmac-sha256$${bytesToBase64(new Uint8Array(digest))}`;
}

async function verifyProofCredential(passwordProof, stored, pepper) {
  if (!String(stored || '').startsWith('proof-hmac-sha256$')) return false;
  const expected = await proofCredential(passwordProof, pepper);
  return timingSafeEqual(encoder.encode(expected), encoder.encode(String(stored)));
}

function cookieValue(request, name) {
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function sessionCookie(token, maxAge = 60 * 60 * 24 * 30) {
  return `tutor_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

module.exports = { hashPassword, verifyPassword, clientPasswordProof, proofCredential, verifyProofCredential, sha256, randomToken, cookieValue, sessionCookie };
