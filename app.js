/* Lindblad Route Planner Local First 1.0
 * Static browser application: selected OLEX and RTZ files never leave the device.
 */
'use strict';

const APP_VERSION = '1.0.0';
const DB_NAME = 'lindblad-route-planner-local-first';
const DB_VERSION = 1;
const RECORD_SIZE = 18;
const MAX_PREVIEW_POINTS = 80000;
const els = {};
const state = {
  db: null,
  land: null,
  route: null,
  routes: [],
  rtzRoutes: [],
  olex: [],
  olexPoints: [],
  olexSpatial: new Map(),
  olexTileCache: new Map(),
  selectedWp: -1,
  history: [],
  future: [],
  assessment: null,
  map: { centerLat: -64.8, centerLon: -62.7, zoom: 5.5 },
  dragging: null,
  addMode: false,
  loadToken: 0,
  landReady: false,
  editingGuard: false
};

const q = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);
const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const rad = (v) => v * Math.PI / 180;
const deg = (v) => v * 180 / Math.PI;
const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const units = ['B','KB','MB','GB','TB']; let i = 0; let x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 10 || i === 0 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
};
const escapeHtml = (s) => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const xmlEscape = (s) => String(s ?? '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));

function toast(message, type = '') {
  let stack = document.querySelector('.toast-stack');
  if (!stack) { stack = document.createElement('div'); stack.className = 'toast-stack'; document.body.appendChild(stack); }
  const item = document.createElement('div'); item.className = `toast ${type}`; item.textContent = message; stack.appendChild(item);
  setTimeout(() => item.remove(), 5200);
}

function showMapMessage(message, duration = 4500) {
  els.mapMessage.textContent = message; els.mapMessage.classList.remove('hidden');
  clearTimeout(showMapMessage.timer); showMapMessage.timer = setTimeout(() => els.mapMessage.classList.add('hidden'), duration);
}

function confirmAction(title, text) {
  return new Promise(resolve => {
    els.confirmTitle.textContent = title; els.confirmText.textContent = text;
    const onClose = () => { els.confirmDialog.removeEventListener('close', onClose); resolve(els.confirmDialog.returnValue === 'ok'); };
    els.confirmDialog.addEventListener('close', onClose); els.confirmDialog.showModal();
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('routes')) db.createObjectStore('routes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('rtz')) db.createObjectStore('rtz', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('olex')) db.createObjectStore('olex', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode = 'readonly') { return state.db.transaction(store, mode).objectStore(store); }
function idbReq(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
const idbAll = (store) => idbReq(tx(store).getAll());
const idbGet = (store, key) => idbReq(tx(store).get(key));
const idbPut = (store, value) => idbReq(tx(store, 'readwrite').put(value));
const idbDelete = (store, key) => idbReq(tx(store, 'readwrite').delete(key));
const idbClear = (store) => idbReq(tx(store, 'readwrite').clear());

function newWaypoint(lat, lon, i = 0) {
  return { id: uid('wp'), name: `WP ${i + 1}`, lat, lon, radius: 0.1, speed: 10, portXtd: 0.1, starboardXtd: 0.1, wheelOver: 0, geometry: 'Loxodrome', remarks: '' };
}
function newRoute() {
  return {
    id: uid('route'), name: 'New Route', defaultSpeed: 10, draft: 6, clearance: 2,
    departure: new Date(Date.now() + 3600000).toISOString().slice(0,16), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), waypoints: []
  };
}

function normalizeRoute(route) {
  const out = { ...newRoute(), ...route };
  out.waypoints = (route?.waypoints || []).map((w, i) => ({ ...newWaypoint(Number(w.lat) || 0, Number(w.lon) || 0, i), ...w, lat: Number(w.lat), lon: Number(w.lon) }));
  return out;
}

function routeSnapshot() { return clone(state.route); }
function pushHistory() {
  if (!state.route) return;
  state.history.push(routeSnapshot());
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  updateUndoRedo();
}
function undo() {
  if (!state.history.length) return;
  state.future.push(routeSnapshot()); state.route = state.history.pop(); state.selectedWp = -1; afterRouteChange(false);
}
function redo() {
  if (!state.future.length) return;
  state.history.push(routeSnapshot()); state.route = state.future.pop(); state.selectedWp = -1; afterRouteChange(false);
}
function updateUndoRedo() { els.undoBtn.disabled = !state.history.length; els.redoBtn.disabled = !state.future.length; }

function haversineNM(aLat, aLon, bLat, bLon) {
  const p1 = rad(aLat), p2 = rad(bLat), dp = rad(bLat - aLat), dl = rad(bLon - aLon);
  const h = Math.sin(dp/2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}
function bearingDeg(aLat, aLon, bLat, bLon) {
  const p1 = rad(aLat), p2 = rad(bLat), dl = rad(bLon - aLon);
  return (deg(Math.atan2(Math.sin(dl)*Math.cos(p2), Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))) + 360) % 360;
}
function interpolate(a, b, f) { return { lat: a.lat + (b.lat-a.lat)*f, lon: a.lon + shortestLonDelta(a.lon,b.lon)*f }; }
function shortestLonDelta(a,b) { let d=b-a; while(d>180)d-=360; while(d<-180)d+=360; return d; }
function routeDistance(route = state.route) { let d = 0; for (let i=1;i<route.waypoints.length;i++) d += haversineNM(route.waypoints[i-1].lat, route.waypoints[i-1].lon, route.waypoints[i].lat, route.waypoints[i].lon); return d; }

function worldSize() { return 256 * Math.pow(2, state.map.zoom); }
function project(lat, lon) {
  const size = worldSize(); const clampedLat = clamp(lat, -85.05112878, 85.05112878);
  const x = (lon + 180) / 360 * size;
  const sin = Math.sin(rad(clampedLat));
  const y = (0.5 - Math.log((1+sin)/(1-sin))/(4*Math.PI)) * size;
  return {x,y};
}
function unproject(x,y) {
  const size = worldSize();
  return { lon: x / size * 360 - 180, lat: deg(Math.atan(Math.sinh(Math.PI * (1 - 2*y/size)))) };
}
function geoToScreen(lat, lon) {
  const c = project(state.map.centerLat, state.map.centerLon); const p = project(lat, lon); const size = worldSize();
  let dx = p.x - c.x; if (dx > size/2) dx -= size; if (dx < -size/2) dx += size;
  return { x: els.mapCanvas.clientWidth/2 + dx, y: els.mapCanvas.clientHeight/2 + (p.y - c.y) };
}
function screenToGeo(x,y) {
  const c = project(state.map.centerLat, state.map.centerLon); const size = worldSize();
  const p = unproject(c.x + x - els.mapCanvas.clientWidth/2, c.y + y - els.mapCanvas.clientHeight/2);
  while (p.lon > 180) p.lon -= 360; while (p.lon < -180) p.lon += 360; return p;
}
function visibleBbox() {
  const a = screenToGeo(0,0), b = screenToGeo(els.mapCanvas.clientWidth, els.mapCanvas.clientHeight);
  return { minLat: Math.min(a.lat,b.lat), maxLat: Math.max(a.lat,b.lat), minLon: Math.min(a.lon,b.lon), maxLon: Math.max(a.lon,b.lon) };
}
function metersPerPixel(lat = state.map.centerLat) { return Math.cos(rad(lat)) * 2 * Math.PI * 6378137 / worldSize(); }
function nmToPixels(nm, lat) { return nm * 1852 / metersPerPixel(lat); }

function resizeCanvas() {
  const dpr = Math.min(devicePixelRatio || 1, 2); const rect = els.mapCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width*dpr)), h = Math.max(1, Math.floor(rect.height*dpr));
  if (els.mapCanvas.width !== w || els.mapCanvas.height !== h) { els.mapCanvas.width=w; els.mapCanvas.height=h; }
  drawMap();
}

function drawMap() {
  const canvas = els.mapCanvas, ctx = canvas.getContext('2d'); const dpr = canvas.width / Math.max(1,canvas.clientWidth);
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  drawOceanGrid(ctx); if (els.showLandToggle.checked) drawLand(ctx); if (els.showOlexToggle.checked) drawOlex(ctx); if (els.showRtzToggle.checked) drawRtz(ctx); drawRoute(ctx);
  updateMapScale();
}
function drawOceanGrid(ctx) {
  const bbox = visibleBbox(); const step = state.map.zoom >= 8 ? 0.1 : state.map.zoom >= 6 ? 0.5 : state.map.zoom >= 4 ? 2 : state.map.zoom >= 2 ? 10 : 30;
  ctx.save(); ctx.strokeStyle='rgba(150,195,212,.08)'; ctx.lineWidth=1; ctx.beginPath();
  for (let lat=Math.ceil(bbox.minLat/step)*step; lat<=bbox.maxLat; lat+=step) { const a=geoToScreen(lat,bbox.minLon), b=geoToScreen(lat,bbox.maxLon); ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y); }
  for (let lon=Math.ceil(bbox.minLon/step)*step; lon<=bbox.maxLon; lon+=step) { const a=geoToScreen(bbox.minLat,lon), b=geoToScreen(bbox.maxLat,lon); ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y); }
  ctx.stroke(); ctx.restore();
}
function drawLand(ctx) {
  if (!state.land?.features) return;
  ctx.save(); ctx.fillStyle='#173c45'; ctx.strokeStyle='rgba(125,184,193,.38)'; ctx.lineWidth=1;
  for (const feature of state.land.features) {
    const g=feature.geometry; if (!g) continue; const polys=g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];
    for (const poly of polys) { ctx.beginPath(); for (const ring of poly) { let first=true; for (const coord of ring) { const p=geoToScreen(coord[1],coord[0]); if(first){ctx.moveTo(p.x,p.y);first=false;}else ctx.lineTo(p.x,p.y); } ctx.closePath(); } ctx.fill('evenodd'); ctx.stroke(); }
  }
  ctx.restore();
}
function depthColor(depth) {
  if (!Number.isFinite(depth)) return 'rgba(103,232,249,.38)';
  if (depth < 10) return 'rgba(251,113,133,.52)'; if (depth < 25) return 'rgba(251,191,36,.48)'; if (depth < 60) return 'rgba(45,212,191,.42)'; return 'rgba(103,232,249,.38)';
}
function drawOlex(ctx) {
  if (!state.olexPoints.length) return;
  const pts = state.olexPoints; ctx.save(); ctx.lineWidth = state.map.zoom > 10 ? 1.2 : .75;
  let previous=null; let pathColor='';
  for (const point of pts) {
    const p=geoToScreen(point.lat,point.lon); if(p.x<-10||p.y<-10||p.x>els.mapCanvas.clientWidth+10||p.y>els.mapCanvas.clientHeight+10){previous=null;continue;}
    const color=depthColor(point.minDepth);
    const close = previous && previous.dbId===point.dbId && previous.latKey===point.latKey && Math.abs(previous.lonKey-point.lonKey)<=3;
    if (!close || color!==pathColor) { if(pathColor)ctx.stroke(); ctx.beginPath(); ctx.strokeStyle=color; ctx.moveTo(p.x,p.y); pathColor=color; }
    else ctx.lineTo(p.x,p.y);
    previous=point;
  }
  if(pathColor)ctx.stroke();
  if (state.map.zoom >= 11) { ctx.fillStyle='rgba(207,250,254,.35)'; for(const point of pts.slice(0,30000)){const p=geoToScreen(point.lat,point.lon);ctx.fillRect(p.x-1,p.y-1,2,2);} }
  ctx.restore();
}
function drawRtz(ctx) {
  ctx.save(); ctx.setLineDash([6,5]); ctx.lineWidth=1.4; ctx.strokeStyle='rgba(251,191,36,.58)';
  for(const route of state.rtzRoutes.filter(r=>r.enabled!==false)){ if(route.waypoints.length<2)continue; ctx.beginPath(); route.waypoints.forEach((w,i)=>{const p=geoToScreen(w.lat,w.lon); i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});ctx.stroke(); }
  ctx.restore();
}
function drawRoute(ctx) {
  const wps=state.route?.waypoints||[]; if(!wps.length)return;
  ctx.save();
  if(wps.length>1){
    // Visual XTD envelope.
    ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='rgba(56,189,248,.10)';ctx.lineWidth=Math.max(4,nmToPixels(Math.max(...wps.map(w=>Math.max(w.portXtd||0,w.starboardXtd||0))),state.map.centerLat)*2);ctx.beginPath();wps.forEach((w,i)=>{const p=geoToScreen(w.lat,w.lon);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)});ctx.stroke();
    for(let i=1;i<wps.length;i++){const a=geoToScreen(wps[i-1].lat,wps[i-1].lon),b=geoToScreen(wps[i].lat,wps[i].lon);const status=state.assessment?.legs?.[i-1]?.status;ctx.strokeStyle=status==='supported'?'#22c55e':status==='review'?'#f59e0b':status==='critical'?'#ef4444':'#38bdf8';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
  }
  wps.forEach((w,i)=>{const p=geoToScreen(w.lat,w.lon);const selected=i===state.selectedWp;ctx.beginPath();ctx.arc(p.x,p.y,selected?7:5,0,Math.PI*2);ctx.fillStyle=selected?'#f8fafc':'#38bdf8';ctx.fill();ctx.lineWidth=selected?3:2;ctx.strokeStyle=selected?'#0ea5e9':'#e0f2fe';ctx.stroke();ctx.fillStyle='#eaf6fb';ctx.font='10px system-ui';ctx.fillText(w.name||`WP ${i+1}`,p.x+8,p.y-8);});
  ctx.restore();
}
function updateMapScale() {
  const mpp=metersPerPixel(); let px=100; let nm=mpp*px/1852; const nice=[.01,.02,.05,.1,.2,.5,1,2,5,10,20,50,100,200,500,1000]; let target=nice.reduce((best,v)=>Math.abs(v-nm)<Math.abs(best-nm)?v:best,nice[0]); px=target*1852/mpp; els.mapScale.textContent=`${target} NM ≈ ${Math.round(px)} px`;
}
function fitBounds(points) {
  if(!points.length)return; let minLat=Infinity,maxLat=-Infinity,minLon=Infinity,maxLon=-Infinity;
  for(const p of points){minLat=Math.min(minLat,p.lat);maxLat=Math.max(maxLat,p.lat);minLon=Math.min(minLon,p.lon);maxLon=Math.max(maxLon,p.lon);} state.map.centerLat=(minLat+maxLat)/2;state.map.centerLon=(minLon+maxLon)/2;
  const width=Math.max(.02,maxLon-minLon),height=Math.max(.02,maxLat-minLat);const zx=Math.log2(360*els.mapCanvas.clientWidth/(256*width*1.25));const zy=Math.log2(170*els.mapCanvas.clientHeight/(256*height*1.25));state.map.zoom=clamp(Math.min(zx,zy),1,16); drawMap(); scheduleOlexLoad();
}
function fitRoute() { if(state.route.waypoints.length)fitBounds(state.route.waypoints); else {const pts=state.rtzRoutes.flatMap(r=>r.waypoints);if(pts.length)fitBounds(pts);} }

function setupMapEvents() {
  const c=els.mapCanvas;
  c.addEventListener('wheel',e=>{e.preventDefault();const rect=c.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,before=screenToGeo(x,y);state.map.zoom=clamp(state.map.zoom+(e.deltaY<0?.35:-.35),1,18);const after=screenToGeo(x,y);state.map.centerLat+=before.lat-after.lat;state.map.centerLon+=shortestLonDelta(after.lon,before.lon);drawMap();scheduleOlexLoad();},{passive:false});
  c.addEventListener('pointerdown',e=>{const rect=c.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;const idx=hitWaypoint(x,y);c.setPointerCapture(e.pointerId);if(idx>=0){pushHistory();state.selectedWp=idx;state.dragging={type:'wp',idx};renderWaypointInspector();drawMap();}else{state.dragging={type:'pan',x:e.clientX,y:e.clientY,center:project(state.map.centerLat,state.map.centerLon)};}});
  c.addEventListener('pointermove',e=>{const rect=c.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,g=screenToGeo(x,y);els.cursorPosition.textContent=`${formatCoord(g.lat,true)}  ${formatCoord(g.lon,false)}`;if(!state.dragging)return;if(state.dragging.type==='wp'){const w=state.route.waypoints[state.dragging.idx];w.lat=clamp(g.lat,-85,85);w.lon=g.lon;afterRouteChange(true);}else{const dpr=1;const dx=e.clientX-state.dragging.x,dy=e.clientY-state.dragging.y;const center=unproject(state.dragging.center.x-dx*dpr,state.dragging.center.y-dy*dpr);state.map.centerLat=center.lat;state.map.centerLon=center.lon;drawMap();}});
  c.addEventListener('pointerup',()=>{if(state.dragging?.type==='wp')saveCurrentDraft();state.dragging=null;scheduleOlexLoad();});
  c.addEventListener('dblclick',e=>{const rect=c.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,g=screenToGeo(x,y);insertWaypointNear(g);});
  c.addEventListener('click',e=>{if(!state.addMode)return;const rect=c.getBoundingClientRect(),g=screenToGeo(e.clientX-rect.left,e.clientY-rect.top);pushHistory();state.route.waypoints.push(newWaypoint(g.lat,g.lon,state.route.waypoints.length));state.selectedWp=state.route.waypoints.length-1;state.addMode=false;els.addWaypointModeBtn.classList.remove('btn-accent');afterRouteChange();});
}
function hitWaypoint(x,y){let best=-1,dist=12;state.route.waypoints.forEach((w,i)=>{const p=geoToScreen(w.lat,w.lon),d=Math.hypot(p.x-x,p.y-y);if(d<dist){dist=d;best=i;}});return best;}
function insertWaypointNear(g){const wps=state.route.waypoints;if(wps.length<2){pushHistory();wps.push(newWaypoint(g.lat,g.lon,wps.length));state.selectedWp=wps.length-1;afterRouteChange();return;}let best=Infinity,idx=1;for(let i=1;i<wps.length;i++){const d=pointSegmentDistanceNM(g,wps[i-1],wps[i]);if(d<best){best=d;idx=i;}}pushHistory();wps.splice(idx,0,newWaypoint(g.lat,g.lon,idx));wps.forEach((w,i)=>{if(!w.name||/^WP \d+$/.test(w.name))w.name=`WP ${i+1}`;});state.selectedWp=idx;afterRouteChange();}
function pointSegmentDistanceNM(p,a,b){const lat0=rad((a.lat+b.lat+p.lat)/3);const x=(lon)=>rad(lon)*Math.cos(lat0)*3440.065,y=(lat)=>rad(lat)*3440.065;const ax=x(a.lon),ay=y(a.lat),bx=x(b.lon),by=y(b.lat),px=x(p.lon),py=y(p.lat);const dx=bx-ax,dy=by-ay,t=clamp(((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));}

function formatCoord(v,lat){const hemi=lat?(v>=0?'N':'S'):(v>=0?'E':'W');const a=Math.abs(v),d=Math.floor(a),m=(a-d)*60;return `${String(d).padStart(lat?2:3,'0')}° ${m.toFixed(3).padStart(6,'0')}′ ${hemi}`;}

function renderRouteInputs(){state.editingGuard=true;els.routeNameInput.value=state.route.name;els.defaultSpeedInput.value=state.route.defaultSpeed;els.draftInput.value=state.route.draft;els.clearanceInput.value=state.route.clearance;els.departureInput.value=state.route.departure||'';state.editingGuard=false;}
function renderWaypointInspector(){const i=state.selectedWp,w=state.route.waypoints[i],enabled=!!w;els.selectedWpTitle.textContent=enabled?`${i+1}. ${w.name}`:'No waypoint selected';els.deleteWaypointBtn.disabled=!enabled;els.waypointEditor.classList.toggle('disabled-editor',!enabled);for(const input of els.waypointEditor.querySelectorAll('input,select,textarea'))input.disabled=!enabled;if(!enabled)return;state.editingGuard=true;els.wpNameInput.value=w.name||'';els.wpLatInput.value=w.lat.toFixed(6);els.wpLonInput.value=w.lon.toFixed(6);els.wpRadiusInput.value=w.radius??0;els.wpSpeedInput.value=w.speed??state.route.defaultSpeed;els.wpPortXtdInput.value=w.portXtd??0;els.wpStarboardXtdInput.value=w.starboardXtd??0;els.wpWheelOverInput.value=w.wheelOver??0;els.wpGeometryInput.value=w.geometry||'Loxodrome';els.wpRemarksInput.value=w.remarks||'';state.editingGuard=false;}
function renderWaypointTable(){const body=els.waypointTableBody;body.innerHTML='';state.route.waypoints.forEach((w,i)=>{const tr=document.createElement('tr');if(i===state.selectedWp)tr.classList.add('selected');const leg=i?`${haversineNM(state.route.waypoints[i-1].lat,state.route.waypoints[i-1].lon,w.lat,w.lon).toFixed(1)} NM`:'—';tr.innerHTML=`<td>${i+1}</td><td>${escapeHtml(w.name)}</td><td>${formatCoord(w.lat,true)}<br>${formatCoord(w.lon,false)}</td><td>${leg}</td>`;tr.onclick=()=>{state.selectedWp=i;renderWaypointInspector();renderWaypointTable();drawMap();};body.appendChild(tr);});}
function afterRouteChange(dragging=false){state.route.updatedAt=new Date().toISOString();renderRouteInputs();renderWaypointInspector();renderWaypointTable();assessRoute();drawMap();if(!dragging)saveCurrentDraftDebounced();}
let draftTimer;function saveCurrentDraftDebounced(){clearTimeout(draftTimer);draftTimer=setTimeout(saveCurrentDraft,350);}async function saveCurrentDraft(){if(!state.route)return;await idbPut('settings',{key:'currentRoute',value:state.route});}

function bindEditors(){
  const routeMap=[['routeNameInput','name','text'],['defaultSpeedInput','defaultSpeed','number'],['draftInput','draft','number'],['clearanceInput','clearance','number'],['departureInput','departure','text']];
  routeMap.forEach(([id,key,type])=>els[id].addEventListener('change',()=>{if(state.editingGuard)return;pushHistory();state.route[key]=type==='number'?Number(els[id].value):els[id].value;afterRouteChange();}));
  const wpMap=[['wpNameInput','name','text'],['wpLatInput','lat','number'],['wpLonInput','lon','number'],['wpRadiusInput','radius','number'],['wpSpeedInput','speed','number'],['wpPortXtdInput','portXtd','number'],['wpStarboardXtdInput','starboardXtd','number'],['wpWheelOverInput','wheelOver','number'],['wpGeometryInput','geometry','text'],['wpRemarksInput','remarks','text']];
  wpMap.forEach(([id,key,type])=>els[id].addEventListener('change',()=>{if(state.editingGuard||state.selectedWp<0)return;pushHistory();state.route.waypoints[state.selectedWp][key]=type==='number'?Number(els[id].value):els[id].value;afterRouteChange();}));
}

function buildSpatialIndex(){state.olexSpatial.clear();for(const p of state.olexPoints){const ky=Math.floor(p.lat/.02),kx=Math.floor(p.lon/.02),key=`${ky}:${kx}`;let arr=state.olexSpatial.get(key);if(!arr){arr=[];state.olexSpatial.set(key,arr);}arr.push(p);}}
function nearestOlex(lat,lon,maxNM=1.5){let best=null,bd=maxNM;const ky=Math.floor(lat/.02),kx=Math.floor(lon/.02);for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const arr=state.olexSpatial.get(`${ky+dy}:${kx+dx}`)||[];for(const p of arr){const d=haversineNM(lat,lon,p.lat,p.lon);if(d<bd){bd=d;best=p;}}}return best?{point:best,distance:bd}:null;}
function nearestRtzDistance(lat,lon){let best=Infinity;for(const r of state.rtzRoutes.filter(x=>x.enabled!==false)){const step=Math.max(1,Math.floor(r.waypoints.length/500));for(let i=0;i<r.waypoints.length;i+=step){const w=r.waypoints[i],d=haversineNM(lat,lon,w.lat,w.lon);if(d<best)best=d;}}return best;}
function assessRoute(){const wps=state.route.waypoints;const total=routeDistance();const hasOlex=state.olex.some(o=>o.enabled!==false)&&state.olexPoints.length>0;let supported=0,review=0,critical=0,corridor=0;const legs=[];for(let i=1;i<wps.length;i++){const a=wps[i-1],b=wps[i],len=haversineNM(a.lat,a.lon,b.lat,b.lon),samples=Math.max(6,Math.min(80,Math.ceil(len/.25)));let s=0,r=0,c=0,h=0;for(let n=0;n<samples;n++){const p=interpolate(a,b,(n+.5)/samples);const near=hasOlex?nearestOlex(p.lat,p.lon,1.5):null;const required=(Number(state.route.draft)||0)+(Number(state.route.clearance)||0);if(near&&near.distance<=.45&&near.point.minDepth>=required)s++;else if(near&&near.point.minDepth>=required)r++;else c++;if(nearestRtzDistance(p.lat,p.lon)<=.35)h++;}supported+=len*s/samples;review+=len*r/samples;critical+=len*c/samples;corridor+=len*h/samples;const status=s>=r&&s>=c?'supported':r>=c?'review':'critical';legs.push({status,supported:s/samples,review:r/samples,critical:c/samples});}state.assessment={available:hasOlex,total,supported:total?supported/total:0,review:total?review/total:0,critical:total?critical/total:0,corridor:total?corridor/total:0,legs};renderSummary();}
function renderSummary(){const a=state.assessment||{};const d=routeDistance();els.sumDistance.textContent=state.route.waypoints.length>1?`${d.toFixed(1)} NM`:'—';els.sumWaypoints.textContent=String(state.route.waypoints.length);els.sumSupported.textContent=a.available?`${(a.supported*100).toFixed(1)}%`:'No data';els.sumReview.textContent=a.available?`${(a.review*100).toFixed(1)}%`:'No data';els.sumCritical.textContent=a.available?`${(a.critical*100).toFixed(1)}%`:'No data';els.sumCorridor.textContent=state.rtzRoutes.length?`${(a.corridor*100).toFixed(1)}%`:'No RTZ';const speed=Number(state.route.defaultSpeed)||0;els.sumEta.textContent=speed&&d?`${(d/speed).toFixed(1)} h`:'—';}

function parseRtz(text, filename='route.rtz') {
  const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error(`Invalid RTZ/XML file: ${filename}`);
  const routeInfo=[...doc.getElementsByTagNameNS('*','routeInfo')][0];const name=routeInfo?.getAttribute('routeName')||routeInfo?.getAttribute('name')||filename.replace(/\.rtz$/i,'');
  const nodes=[...doc.getElementsByTagNameNS('*','waypoint')];const waypoints=[];
  nodes.forEach((node,i)=>{const pos=[...node.getElementsByTagNameNS('*','position')][0];if(!pos)return;const lat=Number(pos.getAttribute('lat')),lon=Number(pos.getAttribute('lon'));if(!Number.isFinite(lat)||!Number.isFinite(lon))return;const leg=[...node.getElementsByTagNameNS('*','leg')][0];const nameNode=[...node.getElementsByTagNameNS('*','name')][0];waypoints.push({id:uid('wp'),name:nameNode?.textContent?.trim()||node.getAttribute('name')||`WP ${i+1}`,lat,lon,radius:Number(node.getAttribute('radius')||leg?.getAttribute('turnRadius')||0),speed:Number(leg?.getAttribute('speedMin')||leg?.getAttribute('speedMax')||10),portXtd:Number(leg?.getAttribute('xtdPort')||0.1),starboardXtd:Number(leg?.getAttribute('xtdStarboard')||0.1),wheelOver:Number(leg?.getAttribute('wheelOverLine')||0),geometry:/greatcircle|orthodrome/i.test(leg?.getAttribute('geometryType')||'')?'Orthodrome':'Loxodrome',remarks:''});});
  if(waypoints.length<2)throw new Error(`No usable RTZ waypoints were found in ${filename}.`);
  return {id:uid('rtz'),name,filename,enabled:true,importedAt:new Date().toISOString(),waypoints};
}
async function importRtzFiles(files){for(const file of files){try{const route=parseRtz(await file.text(),file.name);await idbPut('rtz',route);state.rtzRoutes.push(route);toast(`Imported ${route.name}`,'success');}catch(e){toast(e.message,'error');}}renderRtzList();drawMap();assessRoute();}
function renderRtzList(){const box=els.rtzList;if(!state.rtzRoutes.length){box.className='library-list empty-list';box.textContent='No historical RTZ routes loaded.';return;}box.className='library-list';box.innerHTML='';for(const r of state.rtzRoutes){const item=document.createElement('div');item.className='library-item';item.innerHTML=`<div class="library-title-row"><div><div class="library-name">${escapeHtml(r.name)}</div><div class="library-meta">${r.waypoints.length} waypoints · ${r.enabled!==false?'visible':'hidden'}</div></div></div><div class="library-actions"><button data-a="toggle">${r.enabled!==false?'Hide':'Show'}</button><button data-a="open">Edit copy</button><button data-a="fit">Fit</button><button data-a="delete">Delete</button></div>`;item.querySelector('[data-a=toggle]').onclick=async()=>{r.enabled=r.enabled===false;await idbPut('rtz',r);renderRtzList();drawMap();scheduleOlexLoad();};item.querySelector('[data-a=open]').onclick=()=>openRtzAsRoute(r);item.querySelector('[data-a=fit]').onclick=()=>fitBounds(r.waypoints);item.querySelector('[data-a=delete]').onclick=async()=>{if(await confirmAction('Delete RTZ route?',`Remove ${r.name} from this browser?`)){await idbDelete('rtz',r.id);state.rtzRoutes=state.rtzRoutes.filter(x=>x.id!==r.id);renderRtzList();drawMap();}};box.appendChild(item);}}
function openRtzAsRoute(r){pushHistory();state.route=normalizeRoute({id:uid('route'),name:r.name,waypoints:clone(r.waypoints),defaultSpeed:10,draft:6,clearance:2});state.selectedWp=-1;state.history=[];state.future=[];afterRouteChange();fitRoute();}

async function importEditableRtz(file){try{const r=parseRtz(await file.text(),file.name);openRtzAsRoute(r);toast('RTZ opened as an editable route.','success');}catch(e){toast(e.message,'error');}}
function followNearestRtz(){if(state.route.waypoints.length<2||!state.rtzRoutes.length){toast('Load an RTZ library and create route endpoints first.','error');return;}const start=state.route.waypoints[0],end=state.route.waypoints.at(-1);let best=null,score=Infinity,reverse=false;for(const r of state.rtzRoutes){const a=r.waypoints[0],b=r.waypoints.at(-1),s1=haversineNM(start.lat,start.lon,a.lat,a.lon)+haversineNM(end.lat,end.lon,b.lat,b.lon),s2=haversineNM(start.lat,start.lon,b.lat,b.lon)+haversineNM(end.lat,end.lon,a.lat,a.lon);if(Math.min(s1,s2)<score){score=Math.min(s1,s2);best=r;reverse=s2<s1;}}if(!best)return;pushHistory();const points=clone(reverse?[...best.waypoints].reverse():best.waypoints);points[0]={...points[0],lat:start.lat,lon:start.lon,name:start.name};points[points.length-1]={...points.at(-1),lat:end.lat,lon:end.lon,name:end.name};state.route.waypoints=points;state.selectedWp=-1;afterRouteChange();fitRoute();toast(`Route aligned to ${best.name}.`,'success');}

async function saveRoute(){state.route.updatedAt=new Date().toISOString();await idbPut('routes',clone(state.route));const idx=state.routes.findIndex(r=>r.id===state.route.id);if(idx>=0)state.routes[idx]=clone(state.route);else state.routes.push(clone(state.route));renderRouteLibrary();await saveCurrentDraft();toast('Route saved in this browser.','success');}
function renderRouteLibrary(){const box=els.routeLibrary;if(!state.routes.length){box.className='library-list empty-list';box.textContent='No saved route plans.';return;}box.className='library-list';box.innerHTML='';[...state.routes].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).forEach(r=>{const item=document.createElement('div');item.className=`library-item ${r.id===state.route.id?'active':''}`;item.innerHTML=`<div class="library-title-row"><div><div class="library-name">${escapeHtml(r.name)}</div><div class="library-meta">${r.waypoints.length} waypoints · ${routeDistance(r).toFixed(1)} NM</div></div></div><div class="library-actions"><button data-a="open">Open</button><button data-a="copy">Duplicate</button><button data-a="delete">Delete</button></div>`;item.querySelector('[data-a=open]').onclick=()=>{state.route=normalizeRoute(clone(r));state.history=[];state.future=[];state.selectedWp=-1;afterRouteChange();fitRoute();renderRouteLibrary();};item.querySelector('[data-a=copy]').onclick=async()=>{const copy=normalizeRoute({...clone(r),id:uid('route'),name:`${r.name} copy`,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});await idbPut('routes',copy);state.routes.push(copy);renderRouteLibrary();};item.querySelector('[data-a=delete]').onclick=async()=>{if(await confirmAction('Delete saved route?',`Delete ${r.name} from this browser?`)){await idbDelete('routes',r.id);state.routes=state.routes.filter(x=>x.id!==r.id);renderRouteLibrary();}};box.appendChild(item);});}

function renderOlexList(){const box=els.olexList;if(!state.olex.length){box.className='library-list empty-list';box.textContent='No local OLEX database selected.';return;}box.className='library-list';box.innerHTML='';for(const db of state.olex){const item=document.createElement('div');item.className='library-item';item.innerHTML=`<div class="library-title-row"><div><div class="library-name">${escapeHtml(db.name)}</div><div class="library-meta">${db.records.toLocaleString()} records · ${db.tiles.length} tiles<br>${fmtBytes(db.sourceSizeBytes)} source · local browser index</div></div></div><div class="library-actions"><button data-a="toggle">${db.enabled!==false?'Disable':'Enable'}</button><button data-a="fit">Fit</button><button data-a="delete">Delete index</button></div>`;item.querySelector('[data-a=toggle]').onclick=async()=>{db.enabled=db.enabled===false;await idbPut('olex',db);renderOlexList();scheduleOlexLoad();};item.querySelector('[data-a=fit]').onclick=()=>fitBounds([{lat:db.minLat,lon:db.minLon},{lat:db.maxLat,lon:db.maxLon}]);item.querySelector('[data-a=delete]').onclick=async()=>{if(await confirmAction('Delete local OLEX index?',`Delete the browser index for ${db.name}? The original source file on your computer is not changed.`)){await deleteOlexOpfs(db.id);await idbDelete('olex',db.id);state.olex=state.olex.filter(x=>x.id!==db.id);state.olexTileCache.clear();renderOlexList();scheduleOlexLoad();updateStorage();}};box.appendChild(item);}}
async function deleteOlexOpfs(id){try{const root=await navigator.storage.getDirectory(),olex=await root.getDirectoryHandle('olex');await olex.removeEntry(id,{recursive:true});}catch(_) {}}

async function indexOlexFiles(files){for(const file of files){const id=uid('olex');els.indexProgress.classList.remove('hidden');els.indexProgressTitle.textContent=`Indexing ${file.name}`;els.indexProgressDetail.textContent='The source file stays on this computer. Keep this tab open until indexing finishes.';els.indexProgressBar.style.width='0%';try{const manifest=await runOlexWorker(file,id);manifest.enabled=true;await idbPut('olex',manifest);state.olex.push(manifest);renderOlexList();toast(`${file.name} indexed locally.`,'success');fitBounds([{lat:manifest.minLat,lon:manifest.minLon},{lat:manifest.maxLat,lon:manifest.maxLon}]);}catch(e){await deleteOlexOpfs(id);toast(`OLEX indexing failed: ${e.message}`,'error');}finally{els.indexProgress.classList.add('hidden');await updateStorage();}}}
function runOlexWorker(file,id){return new Promise((resolve,reject)=>{const worker=new Worker('olex-worker.js');worker.onmessage=e=>{const m=e.data||{};if(m.type==='progress'){let pct=m.progress;if(!Number.isFinite(pct)&&m.totalBytes)pct=m.bytesRead/m.totalBytes;els.indexProgressPct.textContent=Number.isFinite(pct)?`${Math.min(100,pct*100).toFixed(1)}%`:'Working';els.indexProgressBar.style.width=Number.isFinite(pct)?`${Math.min(100,pct*100)}%`:'15%';els.indexProgressDetail.textContent=`${m.phase}${m.records?` · ${Number(m.records).toLocaleString()} records`:''}${m.totalBytes?` · ${fmtBytes(m.bytesRead)} / ${fmtBytes(m.totalBytes)}`:''}`;}else if(m.type==='complete'){worker.terminate();resolve(m.result);}else if(m.type==='error'){worker.terminate();reject(new Error(m.message));}};worker.onerror=e=>{worker.terminate();reject(new Error(e.message||'OLEX worker failed.'));};worker.postMessage({type:'index',file,id,name:file.name.replace(/\.olxidx\.gz$|\.gz$/i,'')});});}

function tileKey(lat,lon){const sign=v=>`${v>=0?'+':'-'}${String(Math.abs(v)).padStart(3,'0')}`;return `${sign(Math.floor(Math.min(89.999999,lat)))}_${sign(Math.floor(Math.min(179.999999,lon)))}`;}
async function opfsTileFile(dbId,tileFile){const root=await navigator.storage.getDirectory(),olex=await root.getDirectoryHandle('olex'),db=await olex.getDirectoryHandle(dbId),tiles=await db.getDirectoryHandle('tiles'),h=await tiles.getFileHandle(tileFile);return h.getFile();}
async function readTileSamples(db,tile,maxRecords){const cacheKey=`${db.id}:${tile.id}:${maxRecords}`;if(state.olexTileCache.has(cacheKey))return state.olexTileCache.get(cacheKey);const file=await opfsTileFile(db.id,tile.file);const total=Math.floor(file.size/RECORD_SIZE);if(!total)return[];const target=Math.min(maxRecords,total);const records=[];const parse=(buffer,globalStart=0,stride=1)=>{const u=new Uint8Array(buffer);const aligned=Math.floor(u.byteLength/RECORD_SIZE)*RECORD_SIZE;for(let off=0;off<aligned;off+=RECORD_SIZE*stride){const v=new DataView(u.buffer,u.byteOffset+off,RECORD_SIZE),latKey=v.getInt32(0,true),lonKey=v.getInt32(4,true);records.push({dbId:db.id,latKey,lonKey,lat:latKey*db.latRes,lon:lonKey*db.lonRes,count:v.getUint16(8,true),minDepth:v.getFloat32(10,true),meanDepth:v.getFloat32(14,true)});if(records.length>=target)return false;}return true;};
  if(file.size<=8*1024*1024||total<=target*4){const stride=Math.max(1,Math.floor(total/target));parse(await file.arrayBuffer(),0,stride);}else{const windows=Math.min(16,Math.max(4,Math.ceil(target/1200))),windowRecords=Math.max(200,Math.ceil(target/windows)),windowBytes=Math.min(512*1024,windowRecords*RECORD_SIZE*4);for(let i=0;i<windows&&records.length<target;i++){let start=Math.floor((file.size-windowBytes)*(i/(Math.max(1,windows-1))));start-=start%RECORD_SIZE;const buf=await file.slice(start,Math.min(file.size,start+windowBytes)).arrayBuffer();const n=Math.floor(buf.byteLength/RECORD_SIZE),stride=Math.max(1,Math.floor(n/windowRecords));parse(buf,start,stride);}}
  state.olexTileCache.set(cacheKey,records);if(state.olexTileCache.size>120)state.olexTileCache.delete(state.olexTileCache.keys().next().value);return records;}
let olexLoadTimer;function scheduleOlexLoad(){clearTimeout(olexLoadTimer);olexLoadTimer=setTimeout(loadOlexViewport,280);}
async function loadOlexViewport(){const token=++state.loadToken;const enabled=state.olex.filter(d=>d.enabled!==false);if(!enabled.length||!els.showOlexToggle.checked){state.olexPoints=[];buildSpatialIndex();assessRoute();drawMap();return;}const bbox=visibleBbox();let jobs=[];for(const db of enabled){const tiles=db.tiles.filter(t=>t.maxLat>=bbox.minLat&&t.minLat<=bbox.maxLat&&t.maxLon>=bbox.minLon&&t.minLon<=bbox.maxLon);for(const tile of tiles)jobs.push({db,tile});}if(jobs.length>64){const c={lat:state.map.centerLat,lon:state.map.centerLon};jobs.sort((a,b)=>haversineNM(c.lat,c.lon,(a.tile.minLat+a.tile.maxLat)/2,(a.tile.minLon+a.tile.maxLon)/2)-haversineNM(c.lat,c.lon,(b.tile.minLat+b.tile.maxLat)/2,(b.tile.minLon+b.tile.maxLon)/2));jobs=jobs.slice(0,64);showMapMessage('Wide view: showing a representative subset of local OLEX tiles. Zoom in for more detail.');}const per=Math.max(250,Math.floor(MAX_PREVIEW_POINTS/Math.max(1,jobs.length)));const points=[];for(const job of jobs){if(token!==state.loadToken)return;try{points.push(...await readTileSamples(job.db,job.tile,per));}catch(e){console.warn('Could not read OLEX tile',job.tile.file,e);}}if(token!==state.loadToken)return;points.sort((a,b)=>a.dbId.localeCompare(b.dbId)||a.latKey-b.latKey||a.lonKey-b.lonKey);state.olexPoints=points.slice(0,MAX_PREVIEW_POINTS);buildSpatialIndex();assessRoute();drawMap();}

function exportRtz(){if(state.route.waypoints.length<2){toast('The route needs at least two waypoints.','error');return;}const r=state.route;const wps=r.waypoints.map((w,i)=>`      <waypoint id="${i+1}" radius="${Number(w.radius||0).toFixed(3)}"><position lat="${w.lat.toFixed(8)}" lon="${w.lon.toFixed(8)}"/><name>${xmlEscape(w.name)}</name><leg geometryType="${w.geometry==='Orthodrome'?'GreatCircle':'Loxodrome'}" speedMin="${Number(w.speed||r.defaultSpeed).toFixed(2)}" xtdPort="${Number(w.portXtd||0).toFixed(3)}" xtdStarboard="${Number(w.starboardXtd||0).toFixed(3)}" wheelOverLine="${Number(w.wheelOver||0).toFixed(3)}"/></waypoint>`).join('\n');const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<route xmlns="http://www.cirm.org/RTZ/1/2" version="1.2"><routeInfo routeName="${xmlEscape(r.name)}"/><waypoints>\n${wps}\n</waypoints></route>\n`;downloadBlob(`${safeName(r.name)}.rtz`,new Blob([xml],{type:'application/xml'}));}
function exportJson(){downloadBlob(`${safeName(state.route.name)}.json`,new Blob([JSON.stringify(state.route,null,2)],{type:'application/json'}));}
function exportCsv(){const lines=['number,name,latitude,longitude,turn_radius_nm,speed_kn,xtd_port_nm,xtd_starboard_nm,wheel_over_nm,geometry,remarks'];state.route.waypoints.forEach((w,i)=>lines.push([i+1,w.name,w.lat,w.lon,w.radius,w.speed,w.portXtd,w.starboardXtd,w.wheelOver,w.geometry,w.remarks].map(csv).join(',')));downloadBlob(`${safeName(state.route.name)}.csv`,new Blob([lines.join('\n')],{type:'text/csv'}));}
function csv(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function safeName(s){return String(s||'route').replace(/[^a-z0-9._-]+/gi,'_').replace(/^_+|_+$/g,'')||'route';}
function downloadBlob(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}
async function backup(){const payload={format:'lindblad-route-planner-local-backup-v1',createdUTC:new Date().toISOString(),routes:await idbAll('routes'),rtz:await idbAll('rtz'),currentRoute:state.route};downloadBlob(`Lindblad_Route_Planner_Backup_${new Date().toISOString().slice(0,10)}.json`,new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));}
async function restore(file){try{const p=JSON.parse(await file.text());if(p.format!=='lindblad-route-planner-local-backup-v1')throw new Error('Unsupported backup format.');for(const r of p.routes||[])await idbPut('routes',normalizeRoute(r));for(const r of p.rtz||[])await idbPut('rtz',r);if(p.currentRoute)state.route=normalizeRoute(p.currentRoute);state.routes=await idbAll('routes');state.rtzRoutes=await idbAll('rtz');renderRouteLibrary();renderRtzList();afterRouteChange();toast('Local backup restored.','success');}catch(e){toast(`Restore failed: ${e.message}`,'error');}}

async function updateStorage(){if(!navigator.storage?.estimate){els.storageUsage.textContent='Unavailable';return;}const {usage=0,quota=0}=await navigator.storage.estimate();els.storageUsage.textContent=`${fmtBytes(usage)} / ${fmtBytes(quota)}`;els.storageBar.style.width=`${quota?Math.min(100,usage/quota*100):0}%`;}
async function requestPersistent(){if(!navigator.storage?.persist){toast('Persistent browser storage is not supported here.','error');return;}const granted=await navigator.storage.persist();toast(granted?'Persistent local storage granted.':'The browser did not grant persistent storage.','success');updateStorage();}
async function clearAll(){if(!await confirmAction('Clear all local planner data?','This deletes saved routes, imported RTZ routes and all local OLEX indexes for this site. Original files on your computer are not changed.'))return;for(const s of ['routes','rtz','olex','settings'])await idbClear(s);try{const root=await navigator.storage.getDirectory();await root.removeEntry('olex',{recursive:true});}catch(_){}state.routes=[];state.rtzRoutes=[];state.olex=[];state.olexPoints=[];state.route=newRoute();state.history=[];state.future=[];state.selectedWp=-1;renderAll();updateStorage();toast('Local planner data cleared.','success');}

function cacheEls(){['compatWarning','addOlexBtn','olexInput','olexList','indexProgress','indexProgressTitle','indexProgressPct','indexProgressBar','indexProgressDetail','addRtzBtn','rtzInput','rtzList','routeLibrary','newRouteBtn','storageUsage','storageBar','requestPersistentBtn','clearLocalBtn','importEditableRtzBtn','editableRtzInput','followRtzBtn','addWaypointModeBtn','undoBtn','redoBtn','zoomOutBtn','zoomInBtn','fitBtn','showOlexToggle','showRtzToggle','showLandToggle','assessBtn','saveRouteBtn','mapWrap','mapCanvas','mapScale','cursorPosition','mapMessage','sumDistance','sumWaypoints','sumSupported','sumReview','sumCritical','sumCorridor','sumEta','routeNameInput','defaultSpeedInput','draftInput','clearanceInput','departureInput','selectedWpTitle','deleteWaypointBtn','waypointEditor','wpNameInput','wpLatInput','wpLonInput','wpRadiusInput','wpSpeedInput','wpPortXtdInput','wpStarboardXtdInput','wpWheelOverInput','wpGeometryInput','wpRemarksInput','appendWaypointBtn','waypointTableBody','exportRtzBtn','exportJsonBtn','exportCsvBtn','backupBtn','restoreInput','restoreBtn','confirmDialog','confirmTitle','confirmText'].forEach(id=>els[id]=q(id));}
function bindButtons(){els.addOlexBtn.onclick=()=>els.olexInput.click();els.olexInput.onchange=()=>{indexOlexFiles([...els.olexInput.files]);els.olexInput.value='';};els.addRtzBtn.onclick=()=>els.rtzInput.click();els.rtzInput.onchange=()=>{importRtzFiles([...els.rtzInput.files]);els.rtzInput.value='';};els.newRouteBtn.onclick=()=>{state.route=newRoute();state.history=[];state.future=[];state.selectedWp=-1;afterRouteChange();renderRouteLibrary();};els.importEditableRtzBtn.onclick=()=>els.editableRtzInput.click();els.editableRtzInput.onchange=()=>{const f=els.editableRtzInput.files[0];if(f)importEditableRtz(f);els.editableRtzInput.value='';};els.followRtzBtn.onclick=followNearestRtz;els.addWaypointModeBtn.onclick=()=>{state.addMode=!state.addMode;els.addWaypointModeBtn.classList.toggle('btn-accent',state.addMode);showMapMessage(state.addMode?'Click the map to add a waypoint.':'Add-waypoint mode cancelled.',2200);};els.undoBtn.onclick=undo;els.redoBtn.onclick=redo;els.zoomInBtn.onclick=()=>{state.map.zoom=clamp(state.map.zoom+.5,1,18);drawMap();scheduleOlexLoad();};els.zoomOutBtn.onclick=()=>{state.map.zoom=clamp(state.map.zoom-.5,1,18);drawMap();scheduleOlexLoad();};els.fitBtn.onclick=fitRoute;els.showOlexToggle.onchange=()=>{drawMap();scheduleOlexLoad();};els.showRtzToggle.onchange=()=>drawMap();els.showLandToggle.onchange=()=>drawMap();els.assessBtn.onclick=()=>{assessRoute();toast('Route assessment refreshed.','success');};els.saveRouteBtn.onclick=saveRoute;els.deleteWaypointBtn.onclick=()=>{if(state.selectedWp<0)return;pushHistory();state.route.waypoints.splice(state.selectedWp,1);state.selectedWp=-1;afterRouteChange();};els.appendWaypointBtn.onclick=()=>{pushHistory();const last=state.route.waypoints.at(-1),lat=last?last.lat:state.map.centerLat,lon=last?last.lon+.05:state.map.centerLon;state.route.waypoints.push(newWaypoint(lat,lon,state.route.waypoints.length));state.selectedWp=state.route.waypoints.length-1;afterRouteChange();};els.exportRtzBtn.onclick=exportRtz;els.exportJsonBtn.onclick=exportJson;els.exportCsvBtn.onclick=exportCsv;els.backupBtn.onclick=backup;els.restoreBtn.onclick=()=>els.restoreInput.click();els.restoreInput.onchange=()=>{const f=els.restoreInput.files[0];if(f)restore(f);els.restoreInput.value='';};els.requestPersistentBtn.onclick=requestPersistent;els.clearLocalBtn.onclick=clearAll;}
function renderAll(){renderOlexList();renderRtzList();renderRouteLibrary();renderRouteInputs();renderWaypointInspector();renderWaypointTable();updateUndoRedo();assessRoute();drawMap();}

async function init(){cacheEls();bindButtons();bindEditors();setupMapEvents();if(!('indexedDB'in window)||!navigator.storage?.getDirectory||!('DecompressionStream'in window)){els.compatWarning.classList.remove('hidden');els.compatWarning.textContent='Large local OLEX indexing requires a current Chrome or Edge browser with IndexedDB, Origin Private File System and DecompressionStream support.';}state.db=await openDb();state.routes=(await idbAll('routes')).map(normalizeRoute);state.rtzRoutes=await idbAll('rtz');state.olex=await idbAll('olex');const current=await idbGet('settings','currentRoute');state.route=normalizeRoute(current?.value||state.routes[0]||newRoute());try{state.land=await fetch('assets/land.geojson').then(r=>r.json());state.landReady=true;}catch(e){console.warn('Land layer unavailable',e);}renderAll();resizeCanvas();window.addEventListener('resize',resizeCanvas);await updateStorage();if(navigator.storage?.persisted){const persisted=await navigator.storage.persisted();if(!persisted)showMapMessage('For large OLEX indexes, click “Request persistent local storage” before importing.',7000);}if('serviceWorker'in navigator)navigator.serviceWorker.register('./service-worker.js').catch(console.warn);if(state.route.waypoints.length)fitRoute();else showMapMessage('Import an RTZ route or click “Add waypoint” to begin. OLEX files stay on this computer.',6500);scheduleOlexLoad();}

init().catch(error=>{console.error(error);document.body.innerHTML=`<div style="padding:30px;color:white;font-family:system-ui"><h1>Planner could not start</h1><p>${escapeHtml(error.message)}</p><p>Use a current Chrome or Edge browser over HTTPS.</p></div>`;});
