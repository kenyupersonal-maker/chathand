import {createHmac, timingSafeEqual} from 'node:crypto';

const RECEIPT = /^pr_[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };

// Native must sign these exact UTF-8 bytes after its input guard passes. The
// verifier deliberately has no signing endpoint or renderer-callable issuer.
export function permissionUndoProofMessage(receiptId, issuedAt, nonce) {
  if (!RECEIPT.test(receiptId) || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || !NONCE.test(nonce)) {
    fail('NATIVE_OWNER_PROOF_INVALID', '撤销凭据无效，请亲自在窗口重试。');
  }
  return `ChatHand.permissionUndo.v1\n${receiptId}\n${issuedAt}\n${nonce}`;
}

export class NativeOwnerProofVerifier {
  #key;
  #now;
  #maxAgeMs;
  #futureSkewMs;
  #used = new Map();
  #maxNonces;

  constructor({key = null, now = Date.now, maxAgeMs = 3000, futureSkewMs = 250, maxNonces = 1024} = {}) {
    // A legacy/native-detached service can still revoke. It cannot undo.
    this.#key = typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) ? Buffer.from(key, 'hex') : null;
    if (typeof now !== 'function' || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 10000 ||
        !Number.isSafeInteger(futureSkewMs) || futureSkewMs < 0 || futureSkewMs > 1000 ||
        !Number.isSafeInteger(maxNonces) || maxNonces < 1) throw new TypeError('Invalid owner-proof limits');
    this.#now = now;
    this.#maxAgeMs = maxAgeMs;
    this.#futureSkewMs = futureSkewMs;
    this.#maxNonces = maxNonces;
  }

  get configured() { return this.#key !== null; }

  verifyAndConsume(receiptId, proof) {
    if (!this.#key) fail('NATIVE_OWNER_AUTH_REQUIRED', '请在 ChatHand 原生窗口亲自撤销。');
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.v !== 1 || !SIGNATURE.test(proof.signature || '')) {
      fail('NATIVE_OWNER_PROOF_INVALID', '撤销凭据无效，请亲自在窗口重试。');
    }
    const message = permissionUndoProofMessage(receiptId, proof.issued_at, proof.nonce);
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || proof.issued_at > now + this.#futureSkewMs || now - proof.issued_at > this.#maxAgeMs) {
      fail('NATIVE_OWNER_PROOF_EXPIRED', '这次点击已过期，请亲自在窗口重试。');
    }
    const expected = createHmac('sha256', this.#key).update(message, 'utf8').digest();
    const received = Buffer.from(proof.signature, 'hex');
    if (!timingSafeEqual(expected, received)) fail('NATIVE_OWNER_PROOF_INVALID', '撤销凭据无效，请亲自在窗口重试。');
    for (const [nonce, expiresAt] of this.#used) if (now > expiresAt) this.#used.delete(nonce);
    if (this.#used.has(proof.nonce)) fail('NATIVE_OWNER_PROOF_USED', '这次点击已处理，请查看当前权限。');
    if (this.#used.size >= this.#maxNonces) fail('NATIVE_OWNER_PROOF_BUSY', '原生点击正在处理，请稍后再试。');
    // Keep a nonce until its signed timestamp can no longer pass the age test.
    this.#used.set(proof.nonce, proof.issued_at + this.#maxAgeMs);
    return Object.freeze({source: 'native_owner', receipt_id: receiptId});
  }
}
