import { openUserDB, hasUser, addUser, getUser, addSession, getSession, getAllSessions, deleteSession, updateSession } from "./db.js";
import { derivePasswordHash, calculateHMAC, generateSecureToken } from "./crypto.js";
import { initGame } from "./game.js";

/*
  High level:
  - Security enforced: HTTPS required, strict creator ID verification.
  - Host (creator) manages users in IndexedDB.
  - Challenge-Response Auth with PBKDF2 + HMAC.
  - Session tokens issued upon successful login.
*/

export async function initApp(){
  function isValidUsername(username){
    return /^[a-zA-Z0-9_-]{3,32}$/.test(username);
  }

  // 1. Enforce Transport Security
  if(location.protocol !== 'https:' && location.hostname !== 'localhost'){
    document.body.innerHTML = "<h1 style='color:red;padding:20px'>⚠️ Security Error: HTTPS required for secure transport.</h1>";
    throw new Error("Insecure context");
  }

  // Security diagnostics
  console.log("🔐 Security Status:");
  console.log("- Protocol:", location.protocol);

  // ensure DB exists (hosts will actually create users; clients don't need it)
  await openUserDB();

  // 2. Verify Ownership using Websim API
  const projectOwner = await window.websim.getCreator();
  const currentUser = await window.websim.getCurrentUser();
  const isHost = projectOwner.id === currentUser.id;
  
  console.log("Creator:", projectOwner.username);
  console.log(isHost ? "You are the creator of this page!" : "You are a visitor.");

  const room = new WebsimSocket();
  await room.initialize();

  console.log("- WebsimSocket transport:", room._transport || "unknown (managed by platform)");

  const statusEl = document.getElementById("creator-status");
  const localRoleEl = document.getElementById("local-role");
  const eventsLog = document.getElementById("events-log");

  function logEvent(text){
    eventsLog.textContent = text;
  }

  // This will be updated dynamically to route requests correctly
  let currentCreatorClientId = projectOwner.clientId;

  // update creator online status whenever peers change
  async function updateCreatorStatus(){
    // Refresh creator info to get the latest clientId if they just joined
    const latestCreator = await window.websim.getCreator();
    currentCreatorClientId = latestCreator.clientId;

    const creatorOnline = isHost || !!currentCreatorClientId;

    statusEl.textContent = creatorOnline ? `Creator online` : `Creator offline`;
    statusEl.className = creatorOnline ? "creator-online" : "creator-offline";
    
    if (isHost) {
      localRoleEl.textContent = "You are the creator (host).";
    } else {
      localRoleEl.textContent = creatorOnline ? "Creator is active. You can register/login." : "Creator is offline.";
    }
  }

  await updateCreatorStatus();
  const unsubPresence = room.subscribePresence(() => updateCreatorStatus());

  // Check for existing session
  const storedToken = sessionStorage.getItem('authToken');
  if(storedToken && (isHost || currentCreatorClientId)){
    console.log("[CLIENT] Validating stored session...");
    const target = isHost ? room.clientId : currentCreatorClientId;
    if(target){
       room.requestPresenceUpdate(target, { type: 'validate-session', sessionToken: storedToken });
    }
  }
  room.onmessage = (evt) => {
    // listen for host responses
    const d = evt.data;
    if(d && d.type === "auth:response" && d.targetClientId === room.clientId){
      // show message to user
      if(d.success){
        if(d.event === 'register') {
          document.getElementById("reg-note").textContent = "Registered ✓";
        } else if(d.event === 'login') {
          document.getElementById("log-note").textContent = "Login success ✓";
          if(d.sessionToken){
            console.log("Session Token Received:", d.sessionToken);
            sessionStorage.setItem('authToken', d.sessionToken);
            console.log("✅ Session token stored");
          }
          document.getElementById("logout-btn").style.display = "block";
          
          // Start Game
          setTimeout(() => initGame(pendingLoginUsername, room, isHost), 1000);

        } else if(d.event === 'session-validate') {
          if(d.success){
             logEvent(`Session restored: ${d.username}`);
             document.getElementById("log-note").textContent = `Logged in as ${d.username}`;
             document.getElementById("logout-btn").style.display = "block";
             
             // Start Game
             setTimeout(() => initGame(d.username, room, isHost), 1000);

          } else {
             logEvent("Session expired or invalid");
             sessionStorage.removeItem('authToken');
          }
        }
        logEvent(d.message || "Success");
      } else {
        if(d.event === 'register') {
          document.getElementById("reg-note").textContent = d.message;
        } else if(d.event === 'login') {
          document.getElementById("log-note").textContent = d.message;
        }
        logEvent(d.message || "Failed");
      }
    }
  };

  // If this client is the creator, start host handler
  if(isHost){
    document.getElementById("local-role").textContent = "Host: validating and storing registrations locally.";
    
    // Auto-login host into game if they want? 
    // Usually host should just be a server, but here host is also a player.
    // We wait for them to use the login form or session restore.

    // Periodic cleanup of expired sessions
    setInterval(async () => {
      try {
        const allSessions = await getAllSessions();
        const now = Date.now();
        let removedCount = 0;
        for(const session of allSessions){
          if(session.expiry < now){
            await deleteSession(session.token);
            removedCount++;
          }
        }
        if(removedCount > 0) {
          console.log(`[HOST] Cleanup: Removed ${removedCount} expired session(s).`);
        }
      } catch (err) {
        console.error('[HOST] Session cleanup failed:', err);
      }
    }, 300000); // Every 5 minutes
    
    // Store pending login challenges: clientId -> { username, challenge, timestamp }
    const loginChallenges = new Map();

    // Brute Force Protection
    const loginAttempts = new Map(); // username -> { count, lockUntil }
    function checkLoginAttempts(username){
      const record = loginAttempts.get(username);
      if(record && Date.now() < record.lockUntil){
        return { locked: true, message: `Too many failed attempts. Try again in ${Math.ceil((record.lockUntil - Date.now())/60000)} minutes.` };
      }
      return { locked: false };
    }
    function recordFailedLogin(username){
      const record = loginAttempts.get(username) || { count: 0, lockUntil: 0 };
      record.count++;
      if(record.count >= 5){
        record.lockUntil = Date.now() + 900000; // 15 min
      }
      loginAttempts.set(username, record);
    }
    
    // Rate Limiting
    const rateLimits = new Map(); // clientId -> { count, resetTime }

    room.subscribePresenceUpdateRequests(async (updateRequest, fromClientId) => {
      try{
        // diagnostic: log every incoming update request on host
        console.log('[HOST] Received presence update request from', fromClientId, 'payload=', updateRequest);

        // Rate Limit Check
        const now = Date.now();
        const rateRecord = rateLimits.get(fromClientId) || { count: 0, resetTime: now + 60000 };
        if(now > rateRecord.resetTime){
          rateRecord.count = 0;
          rateRecord.resetTime = now + 60000;
        }
        rateRecord.count++;
        rateLimits.set(fromClientId, rateRecord);
        if(rateRecord.count > 10){ // Max 10 requests per minute
           room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, message: 'Rate limit exceeded' });
           return;
        }

        if(!updateRequest || !updateRequest.type) return;

        // REGISTRATION
        if(updateRequest.type === 'register'){
          const { username, salt, derivedKey } = updateRequest;
          if(!isValidUsername(username)){
             room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'register', message: 'Invalid username format' });
             return;
          }
          if(!username || !salt || !derivedKey){
            room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'register', message: 'Invalid payload' });
            return;
          }
          const exists = await hasUser(username);
          if(exists){
            room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'register', message: 'Username taken' });
            return;
          }
          // Store the derivedKey. Host never sees password.
          await addUser({ username, salt, derivedKey });
          console.log('[HOST] Stored new user:', username);
          room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: true, event: 'register', message: 'Registration successful' });
        
        // LOGIN STEP 1: INITIALIZATION
        } else if(updateRequest.type === 'login-init'){
          const { username } = updateRequest;
          const user = await getUser(username);
          if(!user){
             room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'login', message: 'Unknown user' });
             return;
          }
          // Generate a random challenge (nonce)
          const challengeArr = crypto.getRandomValues(new Uint8Array(32));
          const challenge = arrayBufferToBase64(challengeArr.buffer);
          
          loginChallenges.set(fromClientId, { username, challenge, timestamp: Date.now() });
          setTimeout(() => loginChallenges.delete(fromClientId), 60000); // 1 min expiry
          
          // Send back salt and challenge
          console.log('[HOST] Sending login challenge to', fromClientId);
          room.send({ 
            type: 'auth:challenge', 
            echo: true, 
            targetClientId: fromClientId, 
            salt: user.salt, 
            challenge 
          });

        // LOGIN STEP 2: VERIFICATION (Challenge-Response)
        } else if(updateRequest.type === 'login-verify'){
          const { response } = updateRequest;
          const record = loginChallenges.get(fromClientId);
          
          if(!record){
            room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'login', message: 'Session expired' });
            return;
          }
          
          const { username, challenge } = record;

          const lockStatus = checkLoginAttempts(username);
          if(lockStatus.locked){
             room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'login', message: lockStatus.message });
             return;
          }

          const user = await getUser(username); 
          
          if(!user){
             room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'login', message: 'User not found' });
             return; 
          }

          // Verify HMAC: HMAC(storedKey, challenge) === response
          const expected = await calculateHMAC(user.derivedKey, challenge);
          
          if(expected === response){
            console.log('[HOST] Login verified for', username);
            // Issue Session Token
            const sessionToken = generateSecureToken();
            
            // Store session in DB (with activity tracking)
            await addSession({ token: sessionToken, username, expiry: Date.now() + 3600*1000, lastActivity: Date.now() });
            console.log('[HOST] Session persisted in DB');
            
            loginAttempts.delete(username); // Clear failures on success

            room.send({ 
              type: 'auth:response', 
              echo: true, 
              targetClientId: fromClientId, 
              success: true, 
              event: 'login', 
              sessionToken,
              message: 'Login successful' 
            });
          } else {
            console.log('[HOST] Login failed (bad signature) for', username);
            recordFailedLogin(username);
            room.send({ type: 'auth:response', echo: true, targetClientId: fromClientId, success: false, event: 'login', message: 'Invalid credentials' });
          }
          
          loginChallenges.delete(fromClientId);

        // VALIDATE SESSION
        } else if(updateRequest.type === 'validate-session'){
          const { sessionToken } = updateRequest;
          const session = await getSession(sessionToken);
          
          if(!session || session.expiry < Date.now()){
            room.send({ 
              type: 'auth:response', 
              echo: true, 
              targetClientId: fromClientId, 
              success: false, 
              event: 'session-validate',
              message: 'Invalid or expired session' 
            });
            return;
          }
          
          // Update Activity
          session.lastActivity = Date.now();
          await updateSession(session);

          room.send({ 
            type: 'auth:response', 
            echo: true, 
            targetClientId: fromClientId, 
            success: true, 
            event: 'session-validate',
            username: session.username,
            message: 'Session valid' 
          });
        }
      } catch (err){
        console.error('[HOST] Error handling presence update request:', err);
        room.send({ type: 'auth:response', echo: false, targetClientId: fromClientId, success: false, message: 'Host error' });
      }
    });
  }

  // UI handlers for non-host clients and also host (host can register locally by using UI too — but host will still go through the same request mechanism; since requestPresenceUpdate targets creator and host === creator, the host handler will receive requests from itself as well — that's fine).
  const regBtn = document.getElementById("reg-submit");
  const logBtn = document.getElementById("log-submit");
  const logoutBtn = document.getElementById("logout-btn");

  logoutBtn.addEventListener("click", () => {
    sessionStorage.removeItem('authToken');
    document.getElementById("log-note").textContent = "";
    logoutBtn.style.display = "none";
    logEvent("Logged out");
  });

  regBtn.addEventListener("click", async () => {
    clearNotes();
    if(!currentCreatorClientId && !isHost){
      document.getElementById("reg-note").textContent = "Creator offline — registration unavailable";
      return;
    }
    const username = document.getElementById("reg-username").value.trim();
    const password = document.getElementById("reg-password").value;
    
    // Validation
    if(!isValidUsername(username)){
       document.getElementById("reg-note").textContent = "Username: 3-32 chars, alphanumeric only";
       return;
    }
    if(password.length < 8){
      document.getElementById("reg-note").textContent = "Password must be 8+ chars";
      return;
    }
    if(!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)){
      document.getElementById("reg-note").textContent = "Password needs uppercase, lowercase, and number";
      return;
    }

    if(!username || !password){
      document.getElementById("reg-note").textContent = "Missing username or password";
      return;
    }
    // client creates salt and derivedKey (PBKDF2)
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = arrayBufferToBase64(salt.buffer);
    const derivedKey = await derivePasswordHash(password, saltB64);
    // send register request to creator
    try{
      const target = isHost ? room.clientId : currentCreatorClientId;
      console.log('[CLIENT] Sending register request to host', target);
      room.requestPresenceUpdate(target, { type: 'register', username, salt: saltB64, derivedKey });
      document.getElementById("reg-note").textContent = "Registration request sent — waiting for host...";
    } catch(e){
      console.error('[CLIENT] Failed to send register request', e);
      document.getElementById("reg-note").textContent = "Failed to send request";
    }
  });

  // Login flow (Secure Challenge-Response):
  // 1) Client -> Host: 'login-init' { username }
  // 2) Host -> Client: 'auth:challenge' { salt, challenge }
  // 3) Client -> Host: 'login-verify' { response: HMAC(PBKDF2(pass, salt), challenge) }
  // 4) Host -> Client: 'auth:response' { success }
  
  let pendingLoginUsername = null;
  const originalOnMessage = room.onmessage;
  
  room.onmessage = (evt) => {
    if(originalOnMessage) originalOnMessage(evt);
    const d = evt.data;
    
    // Handle Challenge
    if(d && d.type === "auth:challenge" && d.targetClientId === room.clientId){
      handleLoginChallenge(d);
    }
  };

  async function handleLoginChallenge(data){
     const { salt, challenge } = data;
     const password = document.getElementById("log-password").value;
     
     if(!pendingLoginUsername || !password){
       return;
     }

     try {
       document.getElementById("log-note").textContent = "Computing proof...";
       // 1. Re-derive the auth key (shared secret)
       const derivedKey = await derivePasswordHash(password, salt);
       
       // 2. Sign the challenge (HMAC)
       const response = await calculateHMAC(derivedKey, challenge);
       
       // 3. Send back proof
       const target = isHost ? room.clientId : currentCreatorClientId;
       console.log('[CLIENT] Sending challenge response to host', target);
       room.requestPresenceUpdate(target, { 
         type: 'login-verify', 
         response 
       });
       document.getElementById("log-note").textContent = "Verifying...";
     } catch(e) {
       console.error("Error processing challenge", e);
       document.getElementById("log-note").textContent = "Crypto error";
     }
  }

  logBtn.addEventListener("click", async () => {
    clearNotes();
    if(!currentCreatorClientId && !isHost){
      document.getElementById("log-note").textContent = "Creator offline — login unavailable";
      return;
    }
    const username = document.getElementById("log-username").value.trim();
    const password = document.getElementById("log-password").value;
    if(!username || !password){
      document.getElementById("log-note").textContent = "Missing username or password";
      return;
    }
    
    pendingLoginUsername = username;
    
    try{
      const target = isHost ? room.clientId : currentCreatorClientId;
      console.log('[CLIENT] Initiating login for', username, 'targeting', target);
      room.requestPresenceUpdate(target, { type: 'login-init', username });
      document.getElementById("log-note").textContent = "Requesting challenge...";
    } catch(err){
      console.error('[CLIENT] Failed to initiate login', err);
      document.getElementById("log-note").textContent = "Connection failed";
      pendingLoginUsername = null;
    }
  });

  function clearNotes(){
    document.getElementById("reg-note").textContent = "";
    document.getElementById("log-note").textContent = "";
  }

  // Utility for base64
  function arrayBufferToBase64(buf){
    const bin = String.fromCharCode(...new Uint8Array(buf));
    return btoa(bin);
  }
}