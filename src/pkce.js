'use strict';

const crypto = require('crypto');

// PKCE（OAuth 的防竊聽機制）：
// 產生一組隨機 verifier，把它的 SHA-256 雜湊（challenge）帶去授權頁；
// 換 token 時再出示原始 verifier 證明「發起授權的就是我」。

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function createState() {
  return base64url(crypto.randomBytes(32));
}

module.exports = { createPkcePair, createState, base64url };
