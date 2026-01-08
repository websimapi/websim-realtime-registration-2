import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { saveCharacter, getCharacter } from './db.js';

/*
  MMORPG Game Logic
  - Host authoritative
  - Chunk-based terrain
  - Simple Combat & Stats
*/

const CHUNK_SIZE = 64;
const RENDER_DISTANCE = 3;
const TICK_RATE = 20;

class Game {
  constructor(room, username, isHost, initialData) {
    this.room = room;
    this.username = username;
    this.isHost = isHost;
    this.data = initialData || this.createDefaultData();
    
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87CEEB);
    this.scene.fog = new THREE.Fog(0x87CEEB, 20, 100);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    document.body.appendChild(this.renderer.domElement);

    // Lights
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.position.set(50, 100, 50);
    this.sun.castShadow = true;
    this.scene.add(this.sun);
    this.ambient = new THREE.AmbientLight(0x404040);
    this.scene.add(this.ambient);

    // Terrain
    this.noise2D = createNoise2D();
    this.chunks = new Map();
    this.chunkMat = new THREE.MeshStandardMaterial({ 
      color: 0x33aa33, 
      flatShading: true,
      roughness: 0.8 
    });

    // Entities
    this.players = new Map(); // clientId -> Mesh
    this.playerData = new Map(); // clientId -> { pos, rot, action, hp, maxHp }
    
    // Controls
    this.keys = {};
    this.mouse = { x: 0, y: 0, left: false, right: false };

    // Audio
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    this.setupInputs();
    this.setupUI();
    
    // Start Loop
    this.lastTime = performance.now();
    this.loop();

    if(this.isHost) {
      this.startHostLoop();
      // Host is also a player, add self
      this.playerData.set(this.room.clientId, { 
        username: this.username,
        pos: this.data.pos, 
        rot: 0, 
        action: 'idle',
        hp: this.data.stats.hp,
        maxHp: this.data.stats.maxHp
      });
    }

    // Networking
    this.setupNetworking();

    // Initial Chunk Load
    this.updateChunks(this.data.pos.x, this.data.pos.z);
    
    // Start Music
    // this.playMusic(); // Disabled for now to not be annoying immediately
  }

  createDefaultData() {
    return {
      username: this.username,
      pos: { x: 0, y: 10, z: 0 },
      stats: { level: 1, xp: 0, hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
      inventory: [],
      quests: []
    };
  }

  setupInputs() {
    window.addEventListener('keydown', e => this.keys[e.code] = true);
    window.addEventListener('keyup', e => this.keys[e.code] = false);
    window.addEventListener('mousemove', e => {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });
    window.addEventListener('mousedown', e => {
      if(e.button === 0) this.mouse.left = true;
      if(e.button === 2) this.mouse.right = true;
      // Raycast attack
      if(e.button === 0) this.performAttack();
    });
    window.addEventListener('mouseup', e => {
      if(e.button === 0) this.mouse.left = false;
      if(e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
    
    // Inventory toggle
    const invBtn = document.getElementById('toggle-inv-btn');
    const invDiv = document.getElementById('hud-inventory');
    if(invBtn) invBtn.onclick = () => {
      invDiv.style.display = invDiv.style.display === 'none' ? 'flex' : 'none';
    };
    window.addEventListener('keydown', e => {
      if(e.code === 'KeyI') invDiv.style.display = invDiv.style.display === 'none' ? 'flex' : 'none';
    });
  }

  setupNetworking() {
    // We hook into the existing room.onmessage but preserving the auth handler
    const prevOnMsg = this.room.onmessage;
    this.room.onmessage = (evt) => {
      if(prevOnMsg) prevOnMsg(evt);
      const d = evt.data;
      if(!d) return;

      if(d.type === 'game:state' && !this.isHost) {
        this.handleServerState(d);
      } else if (d.type === 'game:input' && this.isHost) {
        this.handleClientInput(d, evt.fromClientId);
      }
    };
  }

  setupUI() {
    this.ui = {
      hp: document.getElementById('hp-bar'),
      mp: document.getElementById('mp-bar'),
      lvl: document.getElementById('stat-level'),
      xp: document.getElementById('stat-xp')
    };
    this.updateUI();
  }

  updateUI() {
    const s = this.data.stats;
    if(this.ui.hp) this.ui.hp.style.width = `${(s.hp/s.maxHp)*100}%`;
    if(this.ui.mp) this.ui.mp.style.width = `${(s.mp/s.maxMp)*100}%`;
    if(this.ui.lvl) this.ui.lvl.textContent = s.level;
    if(this.ui.xp) this.ui.xp.textContent = s.xp;
  }

  // --- Terrain Generation ---
  getHeight(x, z) {
    // FBM Noise for mountains/hills
    let y = 0;
    y += this.noise2D(x * 0.01, z * 0.01) * 10;
    y += this.noise2D(x * 0.05, z * 0.05) * 2;
    // Biomes: if low, simpler
    return y > 0 ? y : y * 0.5; 
  }

  generateChunk(cx, cz) {
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, 32, 32);
    geo.rotateX(-Math.PI / 2);
    
    const pos = geo.attributes.position;
    for(let i=0; i < pos.count; i++){
      const x = pos.getX(i) + cx * CHUNK_SIZE;
      const z = pos.getZ(i) + cz * CHUNK_SIZE;
      pos.setY(i, this.getHeight(x, z));
    }
    geo.computeVertexNormals();
    
    const mesh = new THREE.Mesh(geo, this.chunkMat);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  updateChunks(px, pz) {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);
    
    // Load needed
    for(let x = cx - RENDER_DISTANCE; x <= cx + RENDER_DISTANCE; x++) {
      for(let z = cz - RENDER_DISTANCE; z <= cz + RENDER_DISTANCE; z++) {
        const key = `${x},${z}`;
        if(!this.chunks.has(key)) {
          this.chunks.set(key, this.generateChunk(x, z));
        }
      }
    }
    
    // Unload far
    for(const [key, mesh] of this.chunks) {
      const [kx, kz] = key.split(',').map(Number);
      if(Math.abs(kx - cx) > RENDER_DISTANCE + 1 || Math.abs(kz - cz) > RENDER_DISTANCE + 1) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(key);
      }
    }
  }

  // --- Player Mesh ---
  createPlayerMesh(color=0xff0000) {
    const group = new THREE.Group();
    
    // Body
    const bodyGeo = new THREE.BoxGeometry(1, 1.5, 0.5);
    const bodyMat = new THREE.MeshStandardMaterial({ color: color });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 2.25;
    body.castShadow = true;
    group.add(body);

    // Head
    const headGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffccaa });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 3.6;
    group.add(head);

    // Arms
    const armGeo = new THREE.BoxGeometry(0.3, 1.2, 0.3);
    const leftArm = new THREE.Mesh(armGeo, bodyMat);
    leftArm.position.set(-0.8, 2.25, 0);
    group.add(leftArm);
    const rightArm = new THREE.Mesh(armGeo, bodyMat);
    rightArm.position.set(0.8, 2.25, 0);
    group.add(rightArm);
    
    // Legs
    const legGeo = new THREE.BoxGeometry(0.35, 1.5, 0.35);
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const leftLeg = new THREE.Mesh(legGeo, pantsMat);
    leftLeg.position.set(-0.3, 0.75, 0);
    group.add(leftLeg);
    const rightLeg = new THREE.Mesh(legGeo, pantsMat);
    rightLeg.position.set(0.3, 0.75, 0);
    group.add(rightLeg);

    group.userData = { leftArm, rightArm, leftLeg, rightLeg };
    return group;
  }

  updatePlayerVisuals(id, state, dt) {
    let mesh = this.players.get(id);
    if(!mesh) {
      mesh = this.createPlayerMesh(id === this.room.clientId ? 0x00ff00 : 0xff0000);
      this.scene.add(mesh);
      this.players.set(id, mesh);
    }
    
    // Lerp position
    mesh.position.lerp(new THREE.Vector3(state.pos.x, state.pos.y, state.pos.z), 0.3);
    mesh.rotation.y = state.rot;

    // Animation (Walk cycle if moving)
    const speed = new THREE.Vector3(state.pos.x, 0, state.pos.z).distanceTo(new THREE.Vector3(mesh.position.x, 0, mesh.position.z));
    if(speed > 0.05) {
      const time = performance.now() * 0.01;
      mesh.userData.leftLeg.rotation.x = Math.sin(time) * 0.5;
      mesh.userData.rightLeg.rotation.x = Math.sin(time + Math.PI) * 0.5;
      mesh.userData.leftArm.rotation.x = Math.sin(time + Math.PI) * 0.5;
      mesh.userData.rightArm.rotation.x = Math.sin(time) * 0.5;
    } else {
      mesh.userData.leftLeg.rotation.x = 0;
      mesh.userData.rightLeg.rotation.x = 0;
      mesh.userData.leftArm.rotation.x = 0;
      mesh.userData.rightArm.rotation.x = 0;
    }
  }

  // --- Logic Loops ---

  performAttack() {
    // Visual effect
    const pMesh = this.players.get(this.room.clientId);
    if(pMesh) {
       pMesh.userData.rightArm.rotation.x = -Math.PI/2; // Raise arm
       setTimeout(() => pMesh.userData.rightArm.rotation.x = 0, 200);
    }
    // Send to host
    if(!this.isHost) {
      this.room.send({ 
        type: 'game:input', 
        action: 'attack',
        move: this.getCurrentInputMove(),
        rot: this.camera.rotation.y
      });
    } else {
      // Host logic for self attack
      // Check distance to enemies (simplified)
    }
    this.playAudio('woosh');
  }

  playAudio(type){
    // simple synth
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(this.audioCtx.destination);
    if(type === 'woosh'){
      osc.frequency.setValueAtTime(400, this.audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(100, this.audioCtx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.1, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.2);
      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.2);
    }
  }

  getCurrentInputMove() {
    const move = { x: 0, z: 0 };
    if(this.keys['KeyW']) move.z = -1;
    if(this.keys['KeyS']) move.z = 1;
    if(this.keys['KeyA']) move.x = -1;
    if(this.keys['KeyD']) move.x = 1;
    return move;
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Day/Night Cycle
    const timeOfDay = (now * 0.0001) % (Math.PI * 2);
    this.sun.position.set(Math.cos(timeOfDay)*100, Math.sin(timeOfDay)*100, 50);
    this.sun.intensity = Math.max(0, Math.sin(timeOfDay));
    this.scene.background.setHSL(0.6, 0.5, Math.max(0.05, Math.sin(timeOfDay)*0.5));

    // Client Side Prediction / Interpolation
    for(const [id, state] of this.playerData) {
      this.updatePlayerVisuals(id, state, dt);
    }

    // Camera follow local player
    const myState = this.playerData.get(this.room.clientId);
    if(myState) {
      // Input processing for local movement (Client prediction)
      if(!this.isHost) { // If host, we do this in host loop
        const move = this.getCurrentInputMove();
        if(move.x !== 0 || move.z !== 0) {
           // Basic move relative to camera
           // Simplified: Just world axis for now to avoid complex math in snippet
           myState.pos.x += move.x * 10 * dt;
           myState.pos.z += move.z * 10 * dt;
           // Clamp to terrain
           myState.pos.y = this.getHeight(myState.pos.x, myState.pos.z) + 1.5;
           
           // Send input
           this.room.send({ type: 'game:input', move, rot: 0 });
        }
      }
      
      const target = new THREE.Vector3(myState.pos.x, myState.pos.y + 5, myState.pos.z + 10);
      this.camera.position.lerp(target, 0.1);
      this.camera.lookAt(myState.pos.x, myState.pos.y + 2, myState.pos.z);
      
      this.updateChunks(myState.pos.x, myState.pos.z);
    }

    this.renderer.render(this.scene, this.camera);
  }

  // --- HOST LOGIC ---
  startHostLoop() {
    setInterval(() => {
      // Process inputs + physics
      const snapshot = {
        players: [],
        time: Date.now()
      };

      for(const [id, p] of this.playerData) {
        // If it's me (host), process my input directly
        if(id === this.room.clientId) {
           const move = this.getCurrentInputMove();
           p.pos.x += move.x * 0.5; // speed per tick
           p.pos.z += move.z * 0.5;
           p.pos.y = this.getHeight(p.pos.x, p.pos.z); // snap to ground
        }
        
        // Save to DB periodically (simplified: every tick is too much, but good for demo resilience)
        if(Math.random() < 0.01) {
           saveCharacter({ 
             username: p.username, 
             pos: p.pos, 
             stats: { hp: p.hp, maxHp: p.maxHp, level: 1, xp: 0, mp: 50, maxMp: 50 } 
           });
        }

        snapshot.players.push({ 
          id, 
          pos: p.pos, 
          rot: p.rot, 
          hp: p.hp, 
          maxHp: p.maxHp 
        });
      }

      this.room.send({ type: 'game:state', ...snapshot });
    }, 1000 / TICK_RATE);
  }

  handleClientInput(data, clientId) {
    if(!this.playerData.has(clientId)) {
      // Fetch or init? For now, assume they joined and we should have had them.
      // But we need to init them if missing.
      // This is a gap in the snippet: syncing joining players.
      // Fixed: The 'presence' subscription in app.js can trigger an 'add player' here.
      // For now, auto-add if input received.
      this.playerData.set(clientId, { 
        pos: {x:0, y:10, z:0}, 
        rot: 0, 
        hp: 100, maxHp: 100,
        username: 'Unknown'
      });
    }

    const p = this.playerData.get(clientId);
    if(data.move) {
      p.pos.x += data.move.x * 0.5;
      p.pos.z += data.move.z * 0.5;
      p.pos.y = this.getHeight(p.pos.x, p.pos.z);
    }
    if(data.rot) p.rot = data.rot;
  }

  handleServerState(data) {
    if(!data.players) return;
    data.players.forEach(p => {
      if(p.id === this.room.clientId) {
        // Server reconciliation: if distance is too big, snap. Else ignore to prevent jitter
        const local = this.playerData.get(this.room.clientId);
        if(local) {
           const dist = Math.hypot(local.pos.x - p.pos.x, local.pos.z - p.pos.z);
           if(dist > 5) {
             local.pos = p.pos; // Hard snap if desync
           }
        }
      } else {
        this.playerData.set(p.id, p);
      }
    });
  }
}

export async function initGame(username, room, isHost) {
  document.getElementById('app').style.display = 'none'; // Hide Auth UI
  document.getElementById('game-container').style.display = 'block'; // Show Game UI
  
  // Load data
  let data = await getCharacter(username);
  if(!data) {
    // Default spawn
    data = {
      username,
      pos: { x: 0, y: 10, z: 0 },
      stats: { level: 1, xp: 0, hp: 100, maxHp: 100, mp: 50, maxMp: 50 }
    };
  }

  new Game(room, username, isHost, data);
}