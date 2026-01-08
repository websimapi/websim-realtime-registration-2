/*
 Derive a password hash (base64) using PBKDF2 with SHA-256.
 Parameters:
  - password: string
  - saltB64: base64 string of salt bytes
 Returns base64 string of derived key (32 bytes)
*/
export async function derivePasswordHash(password, saltB64){
  const enc = new TextEncoder();
  const passKey = await crypto.subtle.importKey('raw', enc.encode(password), {name:'PBKDF2'}, false, ['deriveBits']);
  const salt = base64ToArrayBuffer(saltB64);
  const derived = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, passKey, 256);
  return arrayBufferToBase64(derived);
}

export function generateSecureToken(length=32){
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

export async function calculateHMAC(keyB64, dataString){
  const enc = new TextEncoder();
  const keyBuf = base64ToArrayBuffer(keyB64);
  const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(dataString));
  return arrayBufferToBase64(signature);
}

function base64ToArrayBuffer(b64){
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for(let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buf){
  const bin = String.fromCharCode(...new Uint8Array(buf));
  return btoa(bin);
}