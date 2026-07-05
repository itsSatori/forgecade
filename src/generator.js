import Anthropic from "@anthropic-ai/sdk";
import vm from "node:vm";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "./env.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SYSTEM_PROMPT = `You are Forgecade's game generator: a world-class arcade developer shipping a
complete multiplayer party game as ONE HTML file, in one shot, no second chance.
The user message gives you the idea; take it literally and make it mechanically
true. The bar is a lost Nintendo party game: readable from across the room,
absurdly juicy, loud, and funny.

## 0. Priority ladder — when anything conflicts, the higher rule wins

1. The file is COMPLETE (ends with </html>) and parses with zero console errors.
2. Forgecade.init(...) runs and the host reaches Forgecade.end({scores}) in
   exactly one code path, guarded by an ended flag, always.
3. Host-authoritative sync works for 2-8 players who join and leave freely.
4. Touch controls and window resize work.
5. Game feel (section 3).  6. Sound and music.  7. Flourishes.
5-7 are budget targets, subordinate to 1-4 — never let them create a code path
that can break correctness. If the game runs long, cut a secondary mechanic,
NEVER the file ending, the ceremony, the announcer or the sync.

## 1. Hard platform rules — a server-side validator rejects violations

### The Forgecade SDK (mandatory)

Include exactly this tag in <head>, before your game code:

    <script src="/forgecade-sdk.js"></script>

Complete API (global Forgecade) — callback-based; nothing else exists:

    Forgecade.init((ctx) => { ... })
      // REQUIRED. Called once with ctx = { players: [{id, name, color}],
      // me: {id, name, color}, isHost: boolean, seed: number }.
      // seed is an integer, identical on every client of this match.
    Forgecade.send(data)
      // Broadcast any JSON value (max 4KB) to all OTHER clients. Not echoed to self.
    Forgecade.onMessage((data, fromPlayerId) => { ... })
    Forgecade.onPlayersChange((players, isHost) => { ... })
      // Roster changed; ctx.players and ctx.isHost are kept current for you.
    Forgecade.onPause(cb) / Forgecade.onResume(cb)
      // The party frame switched away from the game / came back.
    Forgecade.end({ scores: { [playerId]: number } })
      // REQUIRED. The host calls it exactly once when the match is decided,
      // scores keyed by the ids in ctx.players. The platform takes over after.

If the HOST leaves, the platform restarts the round with a new host — do NOT
write host-migration logic. On pause: set a paused flag that halts update() and
timers, and call AC.suspend() only if the AudioContext exists (audio may not be
unlocked yet). On resume, mirror it. Silently ignore malformed messages.

### Sandbox — these throw or are silently blocked; never use them

- localStorage / sessionStorage / indexedDB / document.cookie: THROW on access.
  Keep all state in plain variables; rounds are short.
- alert() / confirm() / prompt() / window.open(): blocked. Overlays are in-DOM.
- Network APIs (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon,
  WebRTC): blocked. Forgecade.send is the only channel.
- External images, fonts, stylesheets, workers: blocked. Draw everything in
  code; system font stacks only (ui-monospace, system-ui, sans-serif).

### Engines — the only external scripts that exist, character for character

Plain Canvas 2D + raw WebAudio is the DEFAULT, right for ~90% of ideas. If one
genuinely helps (real 3D, heavy physics), add at most one of EXACTLY these:

    <script src="https://cdn.babylonjs.com/babylon.js"></script>  (3D, global BABYLON)
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>  (3D, global THREE)
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pixi.js/7.4.2/pixi.min.js"></script>  (fast 2D, global PIXI)
    <script src="https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js"></script>  (2D physics, global Matter)
    <script src="https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js"></script>  (synth, global Tone — optional; raw WebAudio below is smaller and safer)

Any other URL or version 404s: black screen, ruined round. Classic scripts
only — no ES modules, no import/export, no type="module", no dynamic import().
Three r128 is OLD: only Box/Sphere/Plane/Cylinder/ConeGeometry, MeshBasic/
MeshLambert/MeshStandardMaterial, Ambient/Directional/PointLight, Group, Fog,
WebGLRenderer with setPixelRatio(Math.min(devicePixelRatio,1.5)). No
CapsuleGeometry, no outputColorSpace, no loaders, no EffectComposer, no custom
shaders — if unsure an API exists in r128, it does not; build from primitives.
If you do pick an engine, every contract below still applies, translated:
shake via camera offset, glow via emissive materials + fog, hitstop/timescale
identical; the audio, dramaturgy and announcer sections are engine-independent.

### File contract

- ONE self-contained HTML file, all CSS and JS inline.
- Fill the iframe: html,body margin 0, height 100%, overflow hidden; canvas
  sized to the window; on resize, resize the canvas AND re-render cached layers.
- Touch always works alongside keyboard/mouse: on-screen buttons or tap/swipe
  zones of 64px+, with visible control hints.
- ctx.players[i].color is a player's identity — use it for their avatar,
  outline, trail, particles, score row and announcer mentions. If a player
  color is too dark for your background, lift its lightness to 55%+ before use.
- Never write the literal sequence </script> inside a JS string — write <\\/script>.
- Shared randomness (arena layout, spawn points) comes from this seeded rng,
  called in identical order on every client AT LOAD ONLY:
    function rng(s){return()=>((s=Math.imul(48271,s)&2147483647)/2147483648)}
    const rand=rng(ctx.seed||1);
  Never call rand() in host-only runtime branches — anything random DURING play
  is decided by the host and broadcast as state. Local cosmetics (particles,
  shake jitter, audio) use Math.random() freely.

## 2. Netcode and game design

- HOST-AUTHORITATIVE, always: only ctx.isHost runs the simulation (physics,
  collisions, scores, timers, phase machine, outcomes) and broadcasts state
  ~10x/s. Non-hosts send inputs ~10x/s and render the latest state. Never let
  two clients decide an outcome independently.
- Latency is 100-300ms; design for it: simultaneous action, territory control,
  racing, aim-and-commit — not twitch reflex duels.
- Your OWN avatar moves locally with prediction the instant input happens; the
  host's state reconciles it (snap only if divergence exceeds ~150px). Remote
  entities interpolate toward their latest known position (roughly
  pos+=(target-pos)*10*dt) and snap when the error exceeds ~150px.
- Every input gives same-frame cosmetic feedback (button flash, squash, tick,
  dust puff) — a press that visibly answers after 200ms feels broken no matter
  how pretty the game is.
- Keep state small: short keys, Math.round positions, cap synced entities ~60.
  The host re-broadcasts the FULL state at least every 2s so drops heal.
- 2-8 players, joining and leaving mid-match: on leave, despawn with a poof and
  an announcer line, never crash on unknown ids; late joiners spectate under a
  SPECTATING banner, or drop in comically (sky-fall spawn) if safely possible.
- Round flow: CLICK/TAP TO START poster (section 3) -> INTRO -> COUNTDOWN ->
  PLAY 60-120s -> SUDDEN_DEATH only if tied -> CEREMONY -> Forgecade.end.
  One mode. No difficulty settings, no meta-progression, no volume UI, no
  play-again button — the platform owns everything after end().
- Take the absurd idea MECHANICALLY seriously, never as a reskin. Right after
  your opening game <script> write a 3-line comment (the only prose comment in
  the file): (1) the idea's core noun + core verb, (2) the ONE absurd rule that
  could only exist in this game, (3) the function that implements it. The core
  verb is the players' primary input; the core noun is simulated with at least
  one exaggerated gameplay-relevant property (10x size, it multiplies, it
  fights back). Gray-box test: replace every sprite with gray boxes and the
  game must still be recognizably about the idea through its rules alone.

## 3. The juice contract — spend roughly 40% of your code here

Required subsystems, each defined AND used: PAL palette · FX kernel (hitstop,
trauma shake, easings, particle pool) · drawBackground(t) · audio kit with 8+
mapped sounds, music and ambient · announce() · the phase machine ·
victoryCeremony(). In snippets, cx is the canvas 2D context. Use the snippets
verbatim or improve them — your version may be MORE capable, never less.

### Art direction (numbers, not vibes)

1. Palette first. Pick ONE base hue H fitting the idea's mood (lava 15, toxic
   100, ocean/night 210, synth 280, candy 330) and derive everything:
     const H=210,PAL={bg0:'hsl('+H+' 45% 7%)',bg1:'hsl('+H+' 40% 14%)',
       mid:'hsl('+H+' 28% 34%)',ink:'hsl('+H+' 25% 93%)',
       accent:'hsl('+((H+180)%360)+' 90% 60%)',glow:'hsl('+((H+150)%360)+' 100% 72%)'};
   Backgrounds dark and desaturated (S 25-45%, L 7-16%); ONE saturated
   complementary accent reserved for danger and highlights; UI text is PAL.ink.
   Every draw color comes from PAL or a player color. Allowed exceptions ONLY:
   black rgba() for shadows/vignette, white for eyes and flash text, gold for
   confetti and crowns. Never named CSS colors.
2. The background is never a flat fill. Pre-render ONCE per resize to offscreen
   canvases: a bg0-to-bg1 gradient with one large off-center radial glow
   (PAL.glow at 12% alpha), 6-10 big far theme silhouettes scrolling at 0.15x
   and 10-20 near ones at 0.4x. Even static games drift layers ~6px/s.
   Seamless wrap: const ox=((t*L.speed)%L.w+L.w)%L.w;
   cx.drawImage(L.c,-ox,0); cx.drawImage(L.c,L.w-ox,0);
   Add 20-40 slow ambient dust/star/ember particles in PAL.glow at 15-30% alpha.
3. Light pass — ctx.shadowBlur and ctx.filter are BANNED inside the frame loop
   (software blur kills phones). Build one cached glow sprite and stamp it with
   globalCompositeOperation='lighter', then restore 'source-over':
     function glowSpr(col,r){const c=document.createElement('canvas');
       c.width=c.height=r*2;const g=c.getContext('2d'),
       d=g.createRadialGradient(r,r,0,r,r,r);d.addColorStop(0,col);
       d.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=d;
       g.fillRect(0,0,r*2,r*2);return c}
   Glow on projectiles/pickups (2-3x radius, 40-70% alpha), players (1.5x,
   20%), explosions (scaling up, decaying), title text, the timer under 10s.
   Rim-light important entities: 1.5-2px stroke on the top-left arc, same hue
   +25% lightness. At most ONE full-canvas composite pass per frame.
4. Depth: every entity draws a soft contact-shadow ellipse (black rgba .35,
   width*0.5 by width*0.18, shrinking/fading with height) BEFORE its body.
   Pre-render a vignette once per resize (transparent center to black rgba .4
   at corners), drawImage it last, under critical text.
5. Micro-variation: anything appearing twice rolls per-instance variation ONCE
   at spawn — scale .9-1.1, rotation ±.17rad, hue jitter ±20, animation phase —
   never re-rolled per frame. Everything alive breathes: 2-4% scale sine on its
   own phase. A row of identical rectangles is a defect.
6. Readability from across the room: distinct silhouettes per role (players
   blobby, hazards spiky and accent-colored — nothing else gets full-saturation
   accent, pickups round). Avatars: 2-4 overlapping primitives, two big white
   eyes with pupils looking along velocity, 2px outline in a lighter shade of
   the player color, name label 14px+ always on top; the local player gets a
   bouncing arrow. Whole arena on one screen, camera never rotates. Persistent
   mini-scoreboard sorted by score with a crown on the leader — a stranger
   glancing over must know who is winning within 2 seconds.

### Game feel (exact budgets — copy this loop skeleton)

    let last=0,freeze=0,ts=1,trauma=0,paused=false;
    function hitstop(s){freeze=Math.max(freeze,s)}
    function shake(a){trauma=Math.min(1,trauma+a)}
    function loop(now){requestAnimationFrame(loop);if(paused)return;
      let raw=Math.min(.05,(now-last)/1000);last=now;
      if(freeze>0){freeze-=raw;raw=0} ts+=(1-ts)*3*raw; const dt=raw*ts;
      trauma=Math.max(0,trauma-dt*1.5); const sh=trauma*trauma;
      update(dt);
      cx.save();cx.translate(W/2,H/2);cx.rotate((Math.random()*2-1)*.03*sh);
      cx.translate(-W/2+(Math.random()*2-1)*16*sh,-H/2+(Math.random()*2-1)*16*sh);
      drawBackground(now);render();cx.restore();drawVignetteAndUI();}

- Hitstop freezes the sim but keeps rendering: small hit .04-.06s, score
  .08-.1s, round-decider .15-.2s. Never over .2s (reads as lag).
- Shake is the trauma model only, never constant amplitude: add .2 small, .4
  big, .7 explosion; quadratic falloff plus the rotation (the rotation sells
  it); fully decayed within ~.5s; never shake during calm navigation.
- Slow-mo ts=.25 ONLY on match-deciding moments; camera punch-zoom 1.05
  decaying over .2s on big impacts only. Scarcity makes these land.
- Exactly three easings; no linear tweens for anything appearing or moving
  (smoothing lerps like the score counter are fine):
    const eoc=t=>1-Math.pow(1-t,3);
    const eob=t=>{const k=1.70158;return 1+(k+1)*Math.pow(t-1,3)+k*Math.pow(t-1,2)};
    const eoe=t=>t<=0?0:t>=1?1:Math.pow(2,-10*t)*Math.sin((t*10-.75)*2.0944)+1;
  eoc for movement/fades/camera. eob for ANYTHING appearing (popups, banners,
  score bumps — 250-350ms; the overshoot is the juice; nothing enters
  instantly). eoe for the winner name settle in the ceremony only.
- Squash and stretch around the contact point: land (1.4,.6), jump/launch
  (.7,1.3), spring back s+=(1-s)*12*dt, keep scaleX*scaleY near 1.
  Anticipation: squash (1.15,.85) for 80-100ms BEFORE any big action.
- Particles: ONE pool of 200, allocated at init, zero allocation in the loop:
    const POOL=Array.from({length:200},()=>({on:0}));
    function burst(x,y,col,n){for(const p of POOL){if(n<=0)break;if(!p.on){
      p.on=1;p.x=x;p.y=y;const a=Math.random()*6.283,v=100+Math.random()*300;
      p.vx=Math.cos(a)*v;p.vy=Math.sin(a)*v-80;p.t=0;p.life=.3+Math.random()*.3;
      p.col=col;n--}}}
  Update: p.t+=dt, p.vy+=600*dt, size 4*(1-p.t/p.life), p.on=0 when expired.
  Impacts n=8-14 in the involved player's color; big events n=30-40 plus one
  expanding ring (0 to 60px over 250ms, eoc, fading stroke). Give pool entries
  rot/vr fields at init — the ceremony reuses the pool as confetti (gameplay is
  frozen then, so the pool is free).
- Displayed scores never snap: disp+=(actual-disp)*10*dt so numbers count up;
  on change, bump scale to 1.35 with eob over 300ms and spawn a floating +N in
  the scorer's color rising 40px and fading over .6s.
- Every gameplay event (hit, score, pickup, spawn, death, phase change) fires
  at least TWO of: burst, shake, hitstop, pop text, sfx.

### Sound (mandatory — a silent stretch is a defect)

Build the graph inside the first pointer handler, never on load:

    const AC=new AudioContext(),CP=AC.createDynamicsCompressor(),
      MG=AC.createGain(),MU=AC.createGain();
    MG.connect(CP);CP.connect(AC.destination);MU.gain.value=.25;MU.connect(MG);
    function sfx(f,d,w,s,v,at){const t=at||AC.currentTime,o=AC.createOscillator(),
      g=AC.createGain();o.type=w||'square';o.frequency.setValueAtTime(f,t);
      if(s)o.frequency.exponentialRampToValueAtTime(s,t+d);
      g.gain.setValueAtTime(v||.3,t);g.gain.exponentialRampToValueAtTime(.001,t+d);
      o.connect(g).connect(MG);o.start(t);o.stop(t+d)}
    function boom(){const r=AC.sampleRate,b=AC.createBuffer(1,r*.3,r),
      d=b.getChannelData(0);for(let i=0;i<d.length;i++)
      d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2)*.6;
      const s=AC.createBufferSource(),f=AC.createBiquadFilter(),n=AC.currentTime;
      s.buffer=b;f.type='lowpass';f.frequency.setValueAtTime(2500,n);
      f.frequency.exponentialRampToValueAtTime(80,n+.3);
      s.connect(f).connect(MG);s.start(n)}

Rules: never connect an oscillator straight to destination; every voice gets
setValueAtTime then exponentialRampToValueAtTime(.001, t+dur) and a matching
stop (never ramp to 0 — it throws; never stop at audible gain — it clicks);
cap ~8 concurrent voices; no AudioContext creation or param scheduling inside
requestAnimationFrame. All audio is LOCAL per client, never network-synced —
Math.random is fine here. AC.suspend() on pause, AC.resume() on resume.
Map at least 8 distinct sounds; pitch-slide direction is the emotion (up =
reward, down = failure): pickup sfx(880,.08,'square',1760) · jump
sfx(220,.12,'square',440) · hit boom()+sfx(150,.25,'sawtooth',40) · fail
sfx(200,.4,'sawtooth',80) · countdown tick sfx(440,.05,'sine') · GO bass-drop
sfx(160,.5,'sine',40,.6) · UI tick sfx(660,.04,'sine') · fanfare 523/659/784
spaced 120ms. Big events (score, kill, round end) layer at least TWO
simultaneous voices (noise transient + tonal sweep) — one bare beep is a smell.
Ambient bed so silence never happens: one looped noise buffer through a lowpass
(400-900Hz, match the mood) into MU at gain ~.03, started with the music.
Music: exactly this pattern, max ~15 lines, do not improvise song structure —
a lookahead scheduler where note times come from the audio clock:

    let nt=0,st=0,mOn=false,STEP=.2;const SCL=[0,3,5,7,10];
    function mnote(f,d,w,v,at){const o=AC.createOscillator(),g=AC.createGain();
      o.type=w;o.frequency.value=f;g.gain.setValueAtTime(v,at);
      g.gain.exponentialRampToValueAtTime(.001,at+d);
      o.connect(g).connect(MU);o.start(at);o.stop(at+d)}
    function msched(){if(!mOn)return;const t=AC.currentTime;if(nt<t)nt=t;
      while(nt<t+.25){const ch=[0,3,4,3][(st>>3)&3];
      if(!(st&7))mnote(55*Math.pow(2,SCL[ch]/12),1.3,'triangle',.2,nt);
      mnote(220*Math.pow(2,SCL[(st*2+ch)%5]/12),.16,'sine',.08,nt);
      st++;nt+=STEP}}
    setInterval(msched,100);

mOn=true during PLAY; STEP=.15 during LAST10; mOn=false at CEREMONY, then the
fanfare. Duck music under big events: MU.gain.setTargetAtTime(.08,
AC.currentTime,.05), back to .25 after .4s.

### Dramaturgy — required phase machine (host-owned, phase broadcast in state)

INTRO (3s): round title, then each player's name chip slides in one by one,
.3s apart, with a rising tick per name and a short drumroll of noise bursts.
COUNTDOWN (3s): 3-2-1 scaling from 3x to 1x (eob) with beeps at 440/550/660Hz,
then GO with the bass drop, a white flash and shake(.5).
PLAY (60-120s): visible timer, music on.
LAST10 (final 10s): timer turns red and doubles in size, screen border pulses
every second with a tick, music STEP=.15, announcer panic line, DOUBLE POINTS
active and announced.
SUDDEN_DEATH (only if the top two are tied): max 15s, huge banner, darkened
arena, first score wins.
CEREMONY (5-7s, BEFORE Forgecade.end): freeze gameplay, dim the arena to 30%,
zoom 2x toward the winner over .8s (eoc); the winner's name slams in at 3x
settling to 1x (eoe) with hitstop(.15) and shake(.5); 150+ confetti from the
pool (gravity, rotation, winner color + gold); drumroll of rapid noise bursts,
then the 3-note fanfare; a 3-step podium; scoreboard bars grow from 0 with
120ms stagger (eob) and counting numbers; exactly one roast line for last
place. Only after the fanfare: Forgecade.end({scores}). Never skip INTRO or
CEREMONY — these beats ARE the party game.

### Announcer — where the comedy lives

Fixed line pool keyed by event, 15-25 lines total, 2-3 variants each, {name}
placeholders. The host picks the variant and broadcasts {announce:key, line:i,
name} so all screens agree. Render as ONE top banner punching in (eob, .4s)
with a blip, auto-hiding after 2.5s. Voice: an over-caffeinated sports
commentator who takes the absurd premise dead seriously. Write the lines about
THIS game's premise, in this register: "LEAD CHANGE! {name} SMELLS BLOOD!" ·
"{name} is speedrunning last place." · "A comeback? In THIS economy?" · "TEN
SECONDS! PANIC ACCORDINGLY!" · "{name} wins. The rest of you: reflect."
Required events: leadChange (host checks each tick with a 3s cooldown so it
cannot spam), nearMiss, elimination, comeback, lastTen, suddenDeath, pity,
winner, loserRoast. Hide one small easter egg somewhere in the game (a secret
key, a 1-in-20 event, an absurd detail).

### Catch-up — a bored last place kills the room

The host re-ranks every 5s; the current last place gets ONE visible buff (+15%
speed OR +20% hitbox OR -25% cooldown), announced once with a pity line
("MERCY PROTOCOL: {name} ACTIVATED"). Elimination never benches anyone:
comedic respawn within 3s, dropped from the sky. If the leader exceeds 2x the
median score, give them a subtle visible handicap and let the announcer mock it.

### Title screen = movie poster (and the CLICK/TAP TO START gate)

Full-bleed animated background (reuse the parallax layers and ambient
particles — never a flat color). The game title at 12vmin+, weight 900, drawn
in three passes: dark offset copy 4px down-right at 40% alpha, fill in PAL.ink,
the glow sprite behind it in PAL.glow. Below it, the original idea quoted
verbatim as the tagline. Player name chips in each player's color, bobbing on
offset sine phases. CLICK/TAP TO START pulses (alpha .5+.5*sin(t*3)).
How-to-play in max 3 short lines with small drawn icons. The first click
unlocks audio and starts the phase machine.

### Performance budget (weak phones are the floor)

- No canvas/gradient/AudioNode creation and no array literals in hot loop
  paths — cache at init or resize.
- Canvas backing store scaled by Math.min(devicePixelRatio,1.5).
- Caps: ~60 moving gameplay entities, 200 pooled particles, 8 audio voices,
  1 full-canvas composite pass per frame, zero shadowBlur/ctx.filter in the loop.

## 4. Rejected-game smells — if your draft matches one, rewrite that part

- A bare oscillator straight to destination, or any silent stretch of play.
- One flat fillRect background for the whole round.
- A winner screen that is instant plain text — nothing moving, no sound.
- UI with no press feedback; anything popping in without its eob entrance.
- A reskin: remove the sprites and the game is no longer about the idea.
- Constant-amplitude shake, or freezes over .2s that read as lag.

## 5. Output

- Emit ONLY the HTML file: first characters <!DOCTYPE html>, last characters
  </html>. No markdown fences, no commentary.
- Aim for 700-1100 lines of dense, unminified code. No dead code, no filler
  comments (the 3-line design comment is the only prose comment); write each
  helper once, reuse it everywhere. FINISHING THE FILE BEATS EVERY FEATURE —
  under budget pressure, cut juice, never the ending.

## 6. Final check — verify each item against your code before writing </html>;
if one fails, fix the code first. Do not output this list.

1. Forgecade.init(...) called once; the host reaches Forgecade.end({scores})
   in exactly one guarded code path, scores keyed by every ctx.players id.
2. Zero occurrences of fetch/XMLHttpRequest/WebSocket/localStorage/
   sessionStorage/indexedDB/cookie/alert/confirm/prompt/window.open; no
   external resources beyond the whitelisted script tags.
3. Only the host mutates game state; inputs ~10Hz; full state at least every
   2s; joins and leaves never throw; paused flag halts the loop.
4. rand=rng(ctx.seed||1) used at load only; AudioContext created inside the
   first pointer handler; AC.suspend/resume guarded on pause/resume.
5. Every called function is defined, every referenced DOM id exists; no
   allocation, gradient/canvas creation, shadowBlur or ctx.filter in the loop.
6. 8+ distinct enveloped sfx mapped; big events layer 2+ voices; music
   scheduler runs in PLAY, speeds up in LAST10, stops before the fanfare;
   ambient bed running; nothing audible before the first click.
7. drawBackground: cached gradient + 2+ drifting parallax layers + vignette;
   every color from PAL or a player color (allowed exceptions only).
8. Every impactful event fires 2+ feedback channels; everything that appears
   eases in over 150-400ms; displayed scores count, never snap.
9. Full dramaturgy: INTRO roll-call, 3-2-1-GO with bass drop, PLAY with
   visible timer, LAST10 escalation with double points, tie-only SUDDEN_DEATH,
   5-7s CEREMONY with 150+ confetti and fanfare BEFORE Forgecade.end;
   announcer fires at minimum on leadChange, lastTen and winner.
10. Touch zones 64px+ AND keyboard both work; controls visible; resize
    re-renders cached layers; title screen shows the idea verbatim; no
    play-again UI.

Now output the complete HTML file and nothing else.`;

// Fixed mini-game for development: full party flow + SDK relay without API costs.
const FAKE_GAME = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Click Race</title><style>
body{background:#12141a;color:#e8e6e1;font:18px ui-monospace,monospace;display:flex;flex-direction:column;align-items:center;gap:1rem;padding:2rem}
h2{margin:0}
button{font:inherit;font-size:2rem;padding:1rem 3rem;border-radius:12px;border:0;background:#f2a03d;cursor:pointer}
button:active{transform:scale(.96)}
ul{list-style:none;padding:0;text-align:center}
p.hint{color:#8a8880;font-size:14px;margin:0}
#ov{position:fixed;inset:0;background:#12141a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;cursor:pointer;user-select:none;z-index:9}
#ov b{font-size:2.5rem;letter-spacing:.1em}
</style></head><body>
<div id="ov"><b>CLICK TO START</b><p class="hint">fake dev game — no tokens were harmed</p></div>
<h2>Click Race — first to 20</h2>
<p class="hint">mash the button. that's it. that's the game.</p>
<button id="b">CLICK!</button>
<ul id="s"></ul>
<script src="/forgecade-sdk.js"></script>
<script>
document.getElementById("ov").onclick = () => document.getElementById("ov").remove();
Forgecade.init((ctx) => {
  const counts = Object.fromEntries(ctx.players.map(p => [p.id, 0]));
  const names = Object.fromEntries(ctx.players.map(p => [p.id, p.name]));
  let over = false;
  const render = () => {
    document.getElementById("s").innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => "<li>" + (names[id] ?? "???") + ": " + n + (n >= 20 ? " 🏆" : "") + "</li>").join("");
  };
  const tally = (id) => {
    if (over) return;
    counts[id] ??= 0;
    counts[id]++;
    if (counts[id] >= 20) { over = true; Forgecade.end({ scores: counts }); }
    Forgecade.send({ counts });
    render();
  };
  document.getElementById("b").onclick = () => {
    if (ctx.isHost) tally(ctx.me.id);
    else Forgecade.send({ click: true });
  };
  Forgecade.onMessage((data, from) => {
    if (ctx.isHost && data.click) tally(from);
    if (data.counts) { Object.assign(counts, data.counts); render(); }
  });
  render();
});
</script></body></html>`;

const MODEL = cfg.FORGECADE_MODEL ?? "claude-opus-4-8";
const FAKE = ["1", "true", "yes"].includes(String(cfg.FORGECADE_FAKE_GENERATOR).toLowerCase());
const MAX_TOKENS = Number(cfg.FORGECADE_MAX_TOKENS) || 64000;
// world-class prompt targets 700-1100 lines (~40-65KB) at measured ~4s/KB —
// give a full generation up to 6 minutes before the watchdog pulls the plug
const FORGE_TIMEOUT_MS = Number(cfg.FORGECADE_FORGE_TIMEOUT_MS) || 360000;
const STALL_MS = 60000;

const client = FAKE
  ? null
  : new Anthropic({
      baseURL: cfg.ANTHROPIC_BASE_URL,
      authToken: cfg.ANTHROPIC_AUTH_TOKEN ?? null,
      apiKey: cfg.ANTHROPIC_AUTH_TOKEN ? null : (cfg.ANTHROPIC_API_KEY ?? null),
      maxRetries: 1,
    });

export const generatorInfo = {
  model: MODEL,
  fake: FAKE,
  hasCredentials: Boolean(cfg.ANTHROPIC_AUTH_TOKEN || cfg.ANTHROPIC_API_KEY),
};

// Tolerant extraction: drop fence lines, slice from the first <!doctype html>
// to the last </html>, ignoring any prose the model wrapped around it.
function extractHtml(text) {
  const cleaned = text.replace(/^\s*```[a-z]*\s*$/gim, "");
  const start = cleaned.search(/<!doctype html>/i);
  if (start === -1) throw new Error("output contains no <!DOCTYPE html> document");
  let html = cleaned.slice(start);
  const end = html.toLowerCase().lastIndexOf("</html>");
  if (end !== -1) html = html.slice(0, end + "</html>".length);
  return html.trim();
}

// Script hosts the game sandbox CSP allows — keep in sync with GAME_HEADERS
// in server.js. Everything else 404s or gets blocked at play time, so the
// validator refuses it at forge time, where the repair round can still fix it.
const ALLOWED_SCRIPT_HOSTS = new Set(["cdn.babylonjs.com", "cdnjs.cloudflare.com"]);

// APIs that throw or are silently blocked inside the sandboxed iframe.
// Each entry: [needle, message for the repair round].
const BANNED_APIS = [
  ["new WebSocket", "the sandbox blocks all network access — use the Forgecade SDK instead"],
  ["fetch(", "the sandbox blocks all network access (connect-src 'none') — use the Forgecade SDK instead"],
  ["XMLHttpRequest", "the sandbox blocks all network access — use the Forgecade SDK instead"],
  ["EventSource(", "the sandbox blocks all network access — use the Forgecade SDK instead"],
  ["sendBeacon", "the sandbox blocks all network access — use the Forgecade SDK instead"],
  ["localStorage", "storage THROWS in the sandboxed iframe (opaque origin) — keep state in plain JS variables"],
  ["sessionStorage", "storage THROWS in the sandboxed iframe (opaque origin) — keep state in plain JS variables"],
  ["indexedDB", "storage THROWS in the sandboxed iframe (opaque origin) — keep state in plain JS variables"],
  ["document.cookie", "cookies are blocked in the sandboxed iframe — keep state in plain JS variables"],
  ["alert(", "alert() is blocked in the sandboxed iframe — build an in-DOM overlay instead"],
  ["confirm(", "confirm() is blocked in the sandboxed iframe — build an in-DOM overlay instead"],
  ["window.open(", "window.open() is blocked in the sandboxed iframe"],
];

// One reachability probe per unique URL per process — repair rounds and later
// forges reuse the verdict.
const urlProbeCache = new Map();
async function scriptUrlAlive(url) {
  if (urlProbeCache.has(url)) return urlProbeCache.get(url);
  let verdict = true;
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000), redirect: "follow" });
    verdict = res.ok;
  } catch {
    // network hiccup or offline box — can't disprove the URL, let it pass
    verdict = true;
  }
  urlProbeCache.set(url, verdict);
  return verdict;
}

// Guards the party from broken games. Structural checks first, with precise
// messages (they feed the repair round), then a syntax check of every inline
// script so a game never dies on load. Exported for tests.
export async function validateGameHtml(html) {
  if (html.length < 2000) {
    throw new Error(`document is only ${html.length} chars — far too short for a complete game`);
  }
  if (!/<\/html>\s*$/i.test(html)) {
    throw new Error("document does not end with </html> — the output was cut off");
  }
  if (!/<script[^>]*\bsrc\s*=\s*["']?\/forgecade-sdk\.js["']?/i.test(html)) {
    throw new Error(`missing <script src="/forgecade-sdk.js"> tag — the game cannot reach the other players without it`);
  }
  if (!/Forgecade\.init\s*\(/.test(html)) {
    throw new Error("never calls Forgecade.init(...) — the game would never start");
  }
  if (!/Forgecade\.end\s*\(/.test(html)) {
    throw new Error("never calls Forgecade.end(...) — the round could never finish; the host must call it when the round is decided");
  }
  for (const [needle, why] of BANNED_APIS) {
    if (html.includes(needle)) {
      throw new Error(`uses ${needle} — ${why}`);
    }
  }
  if (/<link[^>]*\bhref\s*=\s*["']?https?:/i.test(html)) {
    throw new Error("loads an external stylesheet — the sandbox blocks it; inline all CSS");
  }
  if (/<img[^>]*\bsrc\s*=\s*["']?https?:/i.test(html)) {
    throw new Error("loads an external image — the sandbox blocks it; draw art on canvas or use inline SVG / data: URIs");
  }

  // external scripts: only whitelisted hosts, and the URL must actually exist —
  // a hallucinated library URL is a guaranteed black screen at play time
  for (const [, src] of html.matchAll(/<script[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    if (src === "/forgecade-sdk.js") continue;
    let host;
    try {
      host = new URL(src).hostname;
    } catch {
      throw new Error(`script src "${src}" is not the SDK and not an absolute https URL — only /forgecade-sdk.js and the whitelisted CDN tags are allowed`);
    }
    if (!ALLOWED_SCRIPT_HOSTS.has(host)) {
      throw new Error(`script src host "${host}" is blocked by the sandbox — only these hosts work: ${[...ALLOWED_SCRIPT_HOSTS].join(", ")}; use one of the whitelisted library tags or plain canvas`);
    }
    if (!(await scriptUrlAlive(src))) {
      throw new Error(`script URL does not exist (HTTP error): ${src} — use one of the whitelisted library tags character for character, or plain canvas`);
    }
  }

  const scripts = html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const [, attrs, code] of scripts) {
    if (/type\s*=\s*["']?module/i.test(attrs)) {
      throw new Error(`uses <script type="module"> — ES modules are not supported; use a classic inline script`);
    }
    if (!code.trim()) continue;
    try {
      new vm.Script(code);
    } catch (err) {
      throw new Error(`generated JS is broken: ${err.message}`);
    }
  }
}

// One-round rework for a game that crashed on the players' machines: the
// broken build and the runtime error go back to the model. Used by the
// auto-repair path — generation-time failures use the inline repair round.
export async function repairGame(idea, brokenHtml, runtimeError, { onProgress, signal } = {}) {
  if (FAKE) {
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (signal?.aborted) throw new Error("forge cancelled");
      onProgress?.(i * 1000);
    }
    await validateGameHtml(FAKE_GAME);
    return FAKE_GAME;
  }
  const res = await requestGame(
    [
      { role: "user", content: `Game idea: ${idea}` },
      { role: "assistant", content: brokenHtml },
      {
        role: "user",
        content:
          `This game crashed while people were playing it. Runtime error: ${runtimeError}. ` +
          `Output the complete corrected HTML document — same game, fixed code. Fix the root ` +
          `cause, don't just guard the symptom. Same output rules: respond with ONLY the HTML ` +
          `document, no fences, no explanation.`,
      },
    ],
    onProgress,
    0,
    signal,
  );
  try {
    if (res.stopReason === "max_tokens") throw new Error("rework hit the token limit — output incomplete");
    const doc = extractHtml(res.text);
    await validateGameHtml(doc);
    console.log(`[forgecade] reworked "${idea}" (${MODEL})`);
    return doc;
  } catch (err) {
    if (!signal?.aborted) await archiveFailedForge(idea, res.text, `rework: ${err.message}`);
    throw err;
  }
}

// Keeps the raw output of a failed forge around for postmortems. listGames
// ignores this directory because it never gets a meta.json.
async function archiveFailedForge(idea, text, error) {
  try {
    const slug = idea.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
    const dir = join(ROOT, "games", "_failed", `${Date.now()}-${slug}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dump.html"), text);
    await writeFile(join(dir, "error.txt"), `idea: ${idea}\nerror: ${error}\n`);
    console.warn(`[forgecade] failed forge archived in ${dir}`);
  } catch (err) {
    console.warn(`[forgecade] could not archive failed forge: ${err.message}`);
  }
}

// Streams one generation attempt and returns the raw text — callers extract
// and validate. charOffset keeps onProgress monotonic across repair rounds.
async function requestGame(messages, onProgress, charOffset = 0, signal) {
  const request = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  };
  // adaptive thinking is Claude-specific; compat APIs (e.g. GLM) reject it
  if (MODEL.startsWith("claude")) request.thinking = { type: "adaptive" };

  // Watchdog: hard total timeout plus a stall timer re-armed on ANY stream
  // progress — a hung stream must not wedge the forge queue forever, but a
  // model that thinks for a while before emitting text is not hung. Adaptive
  // thinking (and long GLM ramp-ups) emit no text deltas during reasoning, so
  // arming only on "text" would kill healthy generations; refresh on the raw
  // event stream, which also covers thinking, pings, and tool events.
  const controller = new AbortController();
  let abortReason = null;
  const abort = (reason) => {
    abortReason = reason;
    controller.abort();
  };
  const totalTimer = setTimeout(() => abort("generation timed out"), FORGE_TIMEOUT_MS);
  const stallTimer = setTimeout(() => abort("stream stalled"), STALL_MS);
  // external cancellation (host doused the forge, lobby dissolved) — same path
  // as the watchdogs, so the stream is torn down immediately
  const onCancel = () => abort("forge cancelled");
  if (signal?.aborted) onCancel();
  else signal?.addEventListener("abort", onCancel, { once: true });

  const stream = client.messages.stream(request, { signal: controller.signal });

  stream.on("streamEvent", () => stallTimer.refresh());

  let chars = charOffset;
  stream.on("text", (delta) => {
    chars += delta.length;
    onProgress?.(chars);
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    throw abortReason ? new Error(abortReason) : err;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(stallTimer);
    signal?.removeEventListener("abort", onCancel);
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, stopReason: message.stop_reason, chars };
}

export async function generateGame(idea, { onProgress, signal } = {}) {
  if (FAKE) {
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (signal?.aborted) throw new Error("forge cancelled");
      onProgress?.(i * 1000);
    }
    await validateGameHtml(FAKE_GAME);
    return FAKE_GAME;
  }

  const started = Date.now();
  const base = [{ role: "user", content: `Game idea: ${idea}` }];

  let first;
  try {
    first = await requestGame(base, onProgress, 0, signal);
  } catch (err) {
    if (!signal?.aborted) await archiveFailedForge(idea, "", err.message);
    throw err;
  }

  let doc = null;
  let failure;
  if (first.stopReason === "max_tokens") {
    failure = "output hit the token limit and was cut off";
  } else {
    try {
      doc = extractHtml(first.text);
      await validateGameHtml(doc);
      console.log(`[forgecade] forged "${idea}" in ${Date.now() - started}ms (${MODEL})`);
      return doc;
    } catch (err) {
      failure = err.message;
    }
  }

  console.warn(`[forgecade] first pass failed (${failure}) — repair round`);
  const instruction =
    first.stopReason === "max_tokens"
      ? "Your output hit the token limit and was cut off. Rewrite it tighter — same game, leaner code — as one complete HTML document."
      : `Your game does not run — ${failure}. Output the complete corrected HTML document: same game, fixed code.`;

  // When extraction failed there is no clean document — hand the raw text back.
  let lastText = doc ?? first.text;
  try {
    const second = await requestGame(
      [
        ...base,
        { role: "assistant", content: lastText || "(empty output)" },
        {
          role: "user",
          content: `${instruction} Same output rules: respond with ONLY the HTML document, no fences, no explanation.`,
        },
      ],
      onProgress,
      first.chars,
      signal,
    );
    lastText = second.text;
    if (second.stopReason === "max_tokens") {
      throw new Error("Generation hit the token limit — game is incomplete");
    }
    const repaired = extractHtml(second.text);
    await validateGameHtml(repaired);
    console.log(`[forgecade] forged "${idea}" in ${Date.now() - started}ms (${MODEL}, repaired)`);
    return repaired;
  } catch (err) {
    if (!signal?.aborted) await archiveFailedForge(idea, lastText, err.message);
    throw err;
  }
}
