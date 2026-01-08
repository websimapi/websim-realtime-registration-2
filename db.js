/*
 A very small IndexedDB wrapper for storing users.
 Each user record:
  { username: string (primary key), salt: base64 string, derivedKey: base64 string }
*/
const DB_NAME = 'realtime-registration-db';
const STORE_USERS = 'users';
const STORE_SESSIONS = 'sessions';
const STORE_CHARACTERS = 'characters';
let dbPromise = null;

export function openUserDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // Version 3 adds characters store
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = (e) => {
      const db = r.result;
      if(!db.objectStoreNames.contains(STORE_USERS)){
        db.createObjectStore(STORE_USERS, { keyPath: 'username' });
      }
      if(!db.objectStoreNames.contains(STORE_SESSIONS)){
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'token' });
      }
      if(!db.objectStoreNames.contains(STORE_CHARACTERS)){
        db.createObjectStore(STORE_CHARACTERS, { keyPath: 'username' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

async function tx(storeName, mode='readonly'){
  const db = await openUserDB();
  const t = db.transaction(storeName, mode);
  return { store: t.objectStore(storeName), done: new Promise((res,rej)=>{t.oncomplete=res; t.onerror=()=>rej(t.error);}) };
}

export async function hasUser(username){
  const { store } = await tx(STORE_USERS);
  return new Promise((resolve, reject) => {
    const req = store.get(username);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addUser(user){
  const { store } = await tx(STORE_USERS, 'readwrite');
  return new Promise((resolve,reject) => {
    const req = store.add(user);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getUser(username){
  const { store } = await tx(STORE_USERS);
  return new Promise((resolve,reject) => {
    const req = store.get(username);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addSession(session){
  const { store } = await tx(STORE_SESSIONS, 'readwrite');
  return new Promise((resolve,reject) => {
    const req = store.add(session);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(token){
  const { store } = await tx(STORE_SESSIONS);
  return new Promise((resolve,reject) => {
    const req = store.get(token);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSessions(){
  const { store } = await tx(STORE_SESSIONS);
  return new Promise((resolve,reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(token){
  const { store } = await tx(STORE_SESSIONS, 'readwrite');
  return new Promise((resolve,reject) => {
    const req = store.delete(token);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateSession(session){
  const { store } = await tx(STORE_SESSIONS, 'readwrite');
  return new Promise((resolve,reject) => {
    const req = store.put(session);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCharacter(charData){
  const { store } = await tx(STORE_CHARACTERS, 'readwrite');
  return new Promise((resolve,reject) => {
    const req = store.put(charData); // upsert
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCharacter(username){
  const { store } = await tx(STORE_CHARACTERS);
  return new Promise((resolve,reject) => {
    const req = store.get(username);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}