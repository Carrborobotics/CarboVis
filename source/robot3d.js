// ===== Robot 3D: CAD parts + joints driven by logged / live signals =====
// Frame: WPILib robot frame (X forward, Y left, Z up, meters). Three.js is Y-up, so everything lives under
// a root group rotated -90° about X. Parts are exported from CAD *in assembly position*; each joint moves
// its part (and its children) about a pivot in that same frame.
const Robot3D = (() => {
  const UNIT_TO_RAD = { deg: Math.PI / 180, rad: 1, rot: 2 * Math.PI, raw: 1 };
  const UNIT_TO_M = { m: 1, in: 0.0254, mm: 0.001, raw: 1 };
  const FILE_SCALE = { mm: 0.001, in: 0.0254, m: 1 };
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- storage (IndexedDB; falls back to memory) ----------
  const DB_NAME = 'frc7763-robot3d';
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise(res => {
      try {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => res(null);
      } catch { res(null); }
    });
    return dbp;
  }
  const mem = new Map();
  async function kvGet(k) { const db = await idb(); if (!db) return mem.get(k); return new Promise(res => { try { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); } catch { res(mem.get(k)); } }); }
  async function kvSet(k, v) { mem.set(k, v); const db = await idb(); if (!db) return; return new Promise(res => { try { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; } catch { res(); } }); }
  async function kvDel(k) { mem.delete(k); const db = await idb(); if (!db) return; return new Promise(res => { try { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = res; } catch { res(); } }); }

  // ---------- sample robot (primitives only, so it needs no files) ----------
  function sampleConfig() {
    const P = (name, prims, extra = {}) => ({ id: uid(), name, prims, parent: null, joint: { type: 'fixed' }, canId: null, ...extra });
    const box = (size, pos, color) => ({ shape: 'box', size, pos, color });
    const cyl = (r, len, pos, axis, color) => ({ shape: 'cyl', r, len, pos, axis, color });
    const parts = [];
    const chassis = P('Chassis', [box([0.66, 0.66, 0.08], [0, 0, 0.09], '#5b6670'), box([0.80, 0.10, 0.12], [0, 0.38, 0.09], '#2a5bd7'), box([0.80, 0.10, 0.12], [0, -0.38, 0.09], '#2a5bd7'), box([0.10, 0.66, 0.12], [0.38, 0, 0.09], '#2a5bd7'), box([0.10, 0.66, 0.12], [-0.38, 0, 0.09], '#2a5bd7')]);
    parts.push(chassis);
    const corners = [['FL', 0.26, 0.26, 1, 2], ['FR', 0.26, -0.26, 3, 4], ['BL', -0.26, 0.26, 7, 8], ['BR', -0.26, -0.26, 5, 6]];
    for (const [n, x, y, d, s] of corners) {
      parts.push(P(`Wheel ${n}`, [cyl(0.05, 0.04, [x, y, 0.05], 'y', '#222')], { parent: chassis.id }));
      parts.push(P(`Drive ${n}`, [cyl(0.03, 0.09, [x, y + (y > 0 ? -0.06 : 0.06), 0.19], 'z', '#2b2f33')], { parent: chassis.id, canId: d }));
      parts.push(P(`Steer ${n}`, [cyl(0.022, 0.05, [x + (x > 0 ? -0.06 : 0.06), y, 0.17], 'z', '#2b2f33')], { parent: chassis.id, canId: s }));
    }
    const turret = P('Turret', [cyl(0.19, 0.03, [-0.05, 0, 0.30], 'z', '#7d8a96'), box([0.22, 0.26, 0.16], [-0.05, 0, 0.40], '#9aa6b1')],
      { parent: chassis.id, joint: { type: 'revolute', axis: [0, 0, 1], pivot: [-0.05, 0, 0.30], signal: 'Mechanisms/Turret/Position', unit: 'deg', scale: 1, zero: 0, invert: false, test: 30, min: -180, max: 180 } });
    parts.push(turret);
    parts.push(P('Turret motor', [cyl(0.03, 0.08, [-0.18, 0.12, 0.25], 'z', '#2b2f33')], { parent: chassis.id, canId: 21 }));
    const hood = P('Hood', [box([0.04, 0.24, 0.14], [0.06, 0, 0.47], '#c7cfd6')],
      { parent: turret.id, joint: { type: 'revolute', axis: [0, 1, 0], pivot: [0.06, 0, 0.42], signal: 'Mechanisms/Arm/Position', unit: 'deg', scale: 0.4, zero: 0, invert: true, test: 20, min: -90, max: 90 } });
    parts.push(hood);
    parts.push(P('Flywheel L', [cyl(0.03, 0.08, [-0.05, 0.17, 0.43], 'y', '#2b2f33')], { parent: turret.id, canId: 22 }));
    parts.push(P('Flywheel R', [cyl(0.03, 0.08, [-0.05, -0.17, 0.43], 'y', '#2b2f33')], { parent: turret.id, canId: 23 }));
    parts.push(P('Kicker', [cyl(0.025, 0.07, [-0.15, 0.08, 0.36], 'y', '#2b2f33')], { parent: turret.id, canId: 24 }));
    parts.push(P('Hood motor', [cyl(0.022, 0.05, [-0.15, -0.08, 0.36], 'y', '#2b2f33')], { parent: turret.id, canId: 25 }));
    const rack = P('Intake rack', [box([0.18, 0.56, 0.05], [0.42, 0, 0.12], '#d9a441')],
      { parent: chassis.id, joint: { type: 'prismatic', axis: [1, 0, 0], pivot: [0, 0, 0], signal: 'Mechanisms/Climber/Position', unit: 'm', scale: 0.5, zero: 0, invert: false, test: 0.1, min: 0, max: 0.3 } });
    parts.push(rack);
    parts.push(P('Intake motor', [cyl(0.025, 0.07, [0.42, 0.24, 0.17], 'y', '#2b2f33')], { parent: rack.id, canId: 42 }));
    return { version: 1, sample: true, model: { units: 'm', up: 'z', yaw: 0 }, parts };
  }

  function create(api) {
    const { THREE, GLTFLoader, STLLoader, OrbitControls } = Vendor;
    const { h, S, Core } = api;
    let cfg = null, files = new Map(); // fileId -> {name, type, data(ArrayBuffer)}
    let view = null; // {renderer, scene, camera, controls, root, nodes: Map(partId -> {node, meshes, mats})}
    let selected = null, picking = null, root = null, loading = null;

    const save = () => { if (cfg) kvSet('config', JSON.parse(JSON.stringify(cfg))); };

    async function load() {
      if (loading) return loading;
      loading = (async () => {
        const c = await kvGet('config');
        if (c && Array.isArray(c.parts)) {
          cfg = c;
          for (const p of cfg.parts) if (p.file && !files.has(p.file)) { const f = await kvGet('file:' + p.file); if (f) files.set(p.file, f); }
        } else cfg = sampleConfig();
      })();
      return loading;
    }

    // ----- geometry -----
    function primMesh(pr) {
      let geo;
      if (pr.shape === 'box') geo = new THREE.BoxGeometry(...pr.size);
      else { geo = new THREE.CylinderGeometry(pr.r, pr.r, pr.len, 28); if (pr.axis === 'x') geo.rotateZ(Math.PI / 2); else if (pr.axis === 'z') geo.rotateX(Math.PI / 2); }
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: pr.color || '#8a949c', roughness: 0.6, metalness: 0.15 }));
      m.position.set(...pr.pos);
      return m;
    }
    const parsed = new Map(); // fileId -> Object3D template
    function fileObject(fileId) {
      if (parsed.has(fileId)) return Promise.resolve(parsed.get(fileId));
      const f = files.get(fileId);
      if (!f) return Promise.resolve(null);
      return new Promise(res => {
        try {
          if (f.type === 'stl') {
            const geo = new STLLoader().parse(f.data); geo.computeVertexNormals();
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#9aa4ad', roughness: 0.55, metalness: 0.2 }));
            const g = new THREE.Group(); g.add(mesh); parsed.set(fileId, g); res(g);
          } else {
            // .gltf files reference their .bin / textures by name: serve those from what was imported with it
            const manager = new THREE.LoadingManager(); const urls = [];
            manager.setURLModifier(url => { const name = decodeURIComponent(url.split(/[\\/]/).pop()); const r = f.res && f.res[name]; if (!r) return url; const u = URL.createObjectURL(new Blob([r])); urls.push(u); return u; });
            const done = obj => { urls.forEach(u => URL.revokeObjectURL(u)); if (obj) obj.updateMatrixWorld(true); parsed.set(fileId, obj); res(obj); };
            const src = f.type === 'gltf' ? new TextDecoder().decode(f.data) : f.data;
            new GLTFLoader(manager).parse(src, '', gltf => done(gltf.scene), () => done(null));
          }
        } catch { res(null); }
      });
    }
    // CAD export fix-up: units, up axis and yaw, so the model sits in the WPILib robot frame.
    function modelFix(obj, p) {
      const m = { ...(cfg.model || { units: 'm', up: 'z', yaw: 0 }), ...(p && p.fix ? p.fix : {}) };
      if (Array.isArray(m.rotations)) {
        // AdvantageScope convention: rotations applied in order about the robot axes, then a position offset
        const outer = new THREE.Group(), q = new THREE.Quaternion();
        for (const r of m.rotations) {
          const ax = new THREE.Vector3(r.axis === 'x' ? 1 : 0, r.axis === 'y' ? 1 : 0, r.axis === 'z' ? 1 : 0);
          q.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, (+r.degrees || 0) * Math.PI / 180));
        }
        outer.quaternion.copy(q);
        const pos = m.position || [0, 0, 0]; outer.position.set(+pos[0] || 0, +pos[1] || 0, +pos[2] || 0);
        const wrap = new THREE.Group(); wrap.scale.setScalar(FILE_SCALE[m.units] || 1); wrap.add(obj); outer.add(wrap);
        return outer;
      }
      const wrap = new THREE.Group();
      wrap.scale.setScalar(FILE_SCALE[m.units] || 1);
      if (m.up === 'y') wrap.rotation.x = Math.PI / 2; // Y-up file -> Z-up robot frame
      const outer = new THREE.Group(); outer.rotation.z = (m.yaw || 0) * Math.PI / 180;
      wrap.add(obj); outer.add(wrap); return outer;
    }

    async function buildScene() {
      if (!view) return;
      if (root) { view.scene.remove(root); root.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
      root = new THREE.Group(); root.rotation.x = -Math.PI / 2; view.scene.add(root); view.root = root;
      view.nodes = new Map();
      const byId = new Map(cfg.parts.map(p => [p.id, p]));
      // parents before children
      const order = []; const seen = new Set();
      const visit = p => { if (seen.has(p.id)) return; seen.add(p.id); if (p.parent && byId.has(p.parent)) visit(byId.get(p.parent)); order.push(p); };
      cfg.parts.forEach(visit);
      for (const p of order) {
        const node = new THREE.Group(); node.name = p.name; node.matrixAutoUpdate = false;
        (p.parent && view.nodes.has(p.parent) ? view.nodes.get(p.parent).node : root).add(node);
        const holder = new THREE.Group(); node.add(holder);
        if (p.prims) for (const pr of p.prims) holder.add(primMesh(pr));
        if (p.file) {
          const tmpl = await fileObject(p.file);
          if (tmpl) {
            let obj = tmpl;
            if (p.nodePath) { for (const k of p.nodePath) obj = obj && obj.children[k]; obj = obj || tmpl; }
            const copy = obj.clone(true);
            if (obj !== tmpl) { copy.matrixAutoUpdate = false; copy.matrix.copy(obj.matrixWorld); }
            holder.add(modelFix(copy, p));
          }
        }
        // own materials so one part can be tinted without touching another
        const mats = [];
        holder.traverse(o => { if (o.isMesh) { o.material = Array.isArray(o.material) ? o.material.map(x => x.clone()) : o.material.clone(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => { if (mt.emissive) mats.push(mt); }); o.userData.partId = p.id; } });
        view.nodes.set(p.id, { node, holder, mats, part: p });
      }
      if (!view.framed) { frame(); view.framed = true; }
    }
    function frame() {
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
      view.controls.target.copy(c);
      view.camera.position.copy(c).add(new THREE.Vector3(size * 0.9, size * 0.55, size * 0.9));
      view.camera.near = size / 200; view.camera.far = size * 50; view.camera.updateProjectionMatrix();
      view.controls.update();
    }

    // ----- joints -----
    const tmpM = new THREE.Matrix4(), tmpA = new THREE.Matrix4(), tmpB = new THREE.Matrix4(), axisV = new THREE.Vector3();
    function jointValue(p, t) {
      const j = p.joint; if (!j || j.type === 'fixed') return { q: 0 };
      let raw = NaN, src = 'test';
      if (j.signal && S.log) {
        const e = Core.findEntry(S.log, j.signal);
        if (e && e.v && e.t.length && t != null) { raw = Core.valueAt(e.t, e.v, t); if (isFinite(raw)) src = 'log'; }
      }
      if (!isFinite(raw)) raw = +j.test || 0;
      const k = j.type === 'revolute' ? UNIT_TO_RAD[j.unit] ?? 1 : UNIT_TO_M[j.unit] ?? 1;
      return { q: (raw - (+j.zero || 0)) * (+j.scale || 1) * k * (j.invert ? -1 : 1), raw, src };
    }
    function applyJoints(t) {
      for (const { node, part: p } of view.nodes.values()) {
        const j = p.joint || { type: 'fixed' };
        if (j.type === 'fixed') { node.matrix.identity(); }
        else {
          const { q } = jointValue(p, t);
          axisV.set(...(j.axis || [0, 0, 1])).normalize();
          if (j.type === 'revolute') {
            const [px, py, pz] = j.pivot || [0, 0, 0];
            tmpA.makeTranslation(px, py, pz); tmpM.makeRotationAxis(axisV, q); tmpB.makeTranslation(-px, -py, -pz);
            node.matrix.copy(tmpA).multiply(tmpM).multiply(tmpB);
          } else node.matrix.makeTranslation(axisV.x * q, axisV.y * q, axisV.z * q);
        }
        node.matrixWorldNeedsUpdate = true;
      }
    }
    function applyTints(t, now) {
      let flashing = false;
      for (const { part: p, mats } of view.nodes.values()) {
        let c = null, a = 0;
        if (p.canId != null && S.sum) {
          const m = S.sum.motors.find(x => x.canId === +p.canId);
          if (m) {
            const st = api.motorStateAt(m.name, t);
            const tint = api.stateTint(st, now);
            if (tint) { c = tint.c; a = tint.a; flashing = flashing || !!tint.flash; }
          }
        }
        const sel = p.id === selected;
        for (const mt of mats) {
          if (c) { mt.emissive.setRGB(c[0] / 255, c[1] / 255, c[2] / 255); mt.emissiveIntensity = 0.25 + a * 1.4; }
          else if (sel) { mt.emissive.set('#3fa7b3'); mt.emissiveIntensity = 0.35; }
          else { mt.emissive.set('#000000'); mt.emissiveIntensity = 0; }
        }
      }
      return flashing;
    }

    // ----- view -----
    function mountView(container) {
      if (view && view.container === container) return;
      if (view) { view.renderer.dispose(); view.ro.disconnect(); }
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      container.replaceChildren(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      scene.add(new THREE.HemisphereLight('#ffffff', '#445566', 1.6));
      const sun = new THREE.DirectionalLight('#ffffff', 1.8); sun.position.set(3, 6, 4); scene.add(sun);
      const grid = new THREE.GridHelper(4, 16, '#6b7a86', '#3a444c'); scene.add(grid);
      const ro = new ResizeObserver(() => resize()); ro.observe(container);
      view = { container, renderer, scene, camera, controls, grid, ro, nodes: new Map(), framed: false };
      renderer.domElement.addEventListener('pointerdown', e => { view.down = [e.clientX, e.clientY]; });
      renderer.domElement.addEventListener('pointerup', e => { if (view.down && Math.hypot(e.clientX - view.down[0], e.clientY - view.down[1]) < 5) onClick(e); });
      resize();
      buildScene();
    }
    function resize() {
      if (!view) return;
      const w = view.container.clientWidth, hh = view.container.clientHeight;
      if (!w || !hh) return;
      view.renderer.setSize(w, hh, false); view.renderer.domElement.style.width = '100%'; view.renderer.domElement.style.height = '100%';
      view.camera.aspect = w / hh; view.camera.updateProjectionMatrix();
    }
    function themeColors() {
      const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark') || document.documentElement.dataset.theme === 'dark';
      view.scene.background = new THREE.Color(dark ? '#14181a' : '#e9edee');
    }
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    function onClick(e) {
      const r = view.renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, view.camera);
      const hits = ray.intersectObject(root, true).filter(x => x.object.isMesh);
      if (!hits.length) return;
      const hit = hits[0];
      if (picking) {
        const local = root.worldToLocal(hit.point.clone());
        const p = cfg.parts.find(x => x.id === picking);
        if (p) { p.joint.pivot = [local.x, local.y, local.z].map(v => Math.round(v * 1000) / 1000); save(); }
        picking = null; api.onChange();
        return;
      }
      let o = hit.object; while (o && !o.userData.partId) o = o.parent;
      if (o) { selected = o.userData.partId; api.onChange(); }
    }
    function render(t, now) {
      if (!view || !view.container.isConnected) return false;
      themeColors();
      applyJoints(t);
      const flashing = applyTints(t, now);
      view.controls.update();
      view.renderer.render(view.scene, view.camera);
      return flashing;
    }

    // ----- editing -----
    async function addFiles(fileList) {
      const list = [...fileList];
      const byName = new Map(list.map(f => [f.name, f]));
      const added = [];
      // An AdvantageScope robot folder: config.json + model.glb (+ model_0.glb, model_1.glb … components)
      let asCfg = null;
      const cfgFile = list.find(f => /\.json$/i.test(f.name));
      if (cfgFile) { try { const j = JSON.parse(await cfgFile.text()); if (Array.isArray(j.rotations) || Array.isArray(j.components)) asCfg = j; } catch { /* not a config */ } }
      const models = list.filter(f => /\.(glb|gltf|stl)$/i.test(f.name));
      const skipped = list.filter(f => !/\.(glb|gltf|stl|json|bin|png|jpe?g|webp|ktx2)$/i.test(f.name));
      skipped.forEach(f => api.toast(`${f.name}: export as .glb or .stl from your CAD.`));
      if (!models.length) { api.toast('Choose a .glb, .gltf or .stl file (with its .bin for .gltf).'); return; }
      if (cfg.sample) cfg = { version: 1, model: { units: 'm', up: 'y', yaw: 0 }, parts: [] };
      if (asCfg) cfg.model = { units: 'm', rotations: asCfg.rotations || [], position: asCfg.position || [0, 0, 0], source: 'AdvantageScope' };
      else if (!cfg.parts.length) { const ext0 = models[0].name.split('.').pop().toLowerCase(); cfg.model = { units: ext0 === 'stl' ? 'mm' : 'm', up: ext0 === 'stl' ? 'z' : 'y', yaw: 0 }; }
      for (const f of models) {
        const ext = f.name.split('.').pop().toLowerCase();
        const rec = { name: f.name, type: ext, data: await f.arrayBuffer() };
        if (ext === 'gltf') {
          const j = JSON.parse(new TextDecoder().decode(rec.data));
          const needs = [...(j.buffers || []), ...(j.images || [])].map(b => b.uri).filter(u => u && !u.startsWith('data:')).map(u => decodeURIComponent(u.split('/').pop()));
          const missing = needs.filter(n => !byName.has(n));
          if (missing.length) { api.toast(`${f.name} needs ${missing.join(', ')}. Select it together with the .gltf, or export a single .glb instead.`); continue; }
          rec.res = {}; for (const n of needs) rec.res[n] = await byName.get(n).arrayBuffer();
        }
        const id = uid(); files.set(id, rec); await kvSet('file:' + id, rec);
        const base = f.name.replace(/\.[^.]+$/, '');
        const comp = asCfg && /^model_(\d+)\.glb$/i.test(f.name) ? (asCfg.components || [])[+f.name.match(/_(\d+)\./)[1]] : null;
        if (comp) { const p = newPart(`Component ${f.name.match(/_(\d+)\./)[1]}`, id); p.fix = { rotations: comp.zeroedRotations || [], position: comp.zeroedPosition || [0, 0, 0] }; added.push(p); continue; }
        if (ext !== 'stl') {
          // an assembly: skip single-child wrappers, then make one part per sub-assembly / part
          const tmpl = await fileObject(id);
          let node = tmpl, path = [], depth = 0;
          while (node && node.children.length === 1 && depth++ < 5) { node = node.children[0]; path.push(0); }
          const kids = node ? node.children : [];
          if (kids.length > 1 && kids.length <= 80) {
            const seen = new Map();
            kids.forEach((k, i) => { let nm = k.name && !/^id\d+$/.test(k.name) ? k.name.replace(/_/g, ' ').replace(/\s*(<\d+>|\d+)$/, '').trim() || `${base} piece` : `${base} piece`; const c = (seen.get(nm) || 0) + 1; seen.set(nm, c); const p = newPart(c > 1 ? `${nm} ${c}` : nm, id); p.nodePath = [...path, i]; added.push(p); });
            continue;
          }
        }
        added.push(newPart(base, id));
      }
      cfg.parts.push(...added);
      save(); if (view) view.framed = false; await buildScene(); api.onChange();
      if (added.length) api.toast(`Added ${added.length} part${added.length > 1 ? 's' : ''}${asCfg ? ' with the AdvantageScope orientation' : ''}. Set a joint on each part that moves.`);
    }
    const newPart = (name, file) => ({ id: uid(), name, file, parent: null, joint: { type: 'fixed' }, canId: null });

    function partEditor(p) {
      const j = p.joint || (p.joint = { type: 'fixed' });
      const up = () => { save(); api.onChange(); };
      const rebuild = async () => { save(); await buildScene(); api.onChange(); };
      const num = (val, onset, step = 'any', id) => h('input', { type: 'number', step, value: val ?? '', id, onchange: e => { const v = e.target.value === '' ? null : parseFloat(e.target.value); onset(v); up(); } });
      const signals = api.numericSignals();
      const parentOpts = cfg.parts.filter(x => x.id !== p.id && !isDescendant(x.id, p.id));
      const AX = [['+X fwd', [1, 0, 0]], ['+Y left', [0, 1, 0]], ['+Z up', [0, 0, 1]], ['−X', [-1, 0, 0]], ['−Y', [0, -1, 0]], ['−Z', [0, 0, -1]]];
      const axisKey = (j.axis || [0, 0, 1]).join(',');
      const motorOpts = S.sum ? S.sum.motors.filter(m => m.canId != null).sort((a, b) => a.canId - b.canId) : [];
      const rows = [
        h('label', null, 'Name', h('input', { type: 'text', value: p.name, id: 'p-name-' + p.id, onchange: e => { p.name = e.target.value; up(); } })),
        h('label', null, 'Moves with', h('select', { class: 'sel', id: 'p-par-' + p.id, onchange: e => { p.parent = e.target.value || null; rebuild(); } }, h('option', { value: '' }, 'Robot (chassis frame)'), ...parentOpts.map(x => h('option', { value: x.id, selected: x.id === p.parent }, x.name)))),
        h('label', null, 'Joint', h('select', { class: 'sel', id: 'p-jt-' + p.id, onchange: e => { j.type = e.target.value; if (j.type !== 'fixed') { j.axis = j.axis || [0, 0, 1]; j.pivot = j.pivot || [0, 0, 0]; j.unit = j.unit || (j.type === 'revolute' ? 'deg' : 'm'); j.scale = j.scale ?? 1; j.zero = j.zero ?? 0; j.test = j.test ?? 0; } up(); } },
          ...[['fixed', 'Fixed'], ['revolute', 'Rotates (revolute)'], ['prismatic', 'Slides (prismatic)']].map(([v, l]) => h('option', { value: v, selected: v === j.type }, l)))),
      ];
      if (j.type !== 'fixed') {
        rows.push(
          h('label', null, 'Axis (robot frame)', h('select', { class: 'sel', id: 'p-ax-' + p.id, onchange: e => { j.axis = e.target.value.split(',').map(Number); up(); } }, ...AX.map(([l, v]) => h('option', { value: v.join(','), selected: v.join(',') === axisKey }, l)))),
          j.type === 'revolute' ? h('div', { class: 'r3-pivot' }, h('span', null, 'Pivot point (m)'), h('div', { class: 'r3-xyz' }, ...[0, 1, 2].map(k => num((j.pivot || [0, 0, 0])[k], v => { j.pivot = [...(j.pivot || [0, 0, 0])]; j.pivot[k] = v ?? 0; }, 0.001, `p-pv${k}-${p.id}`))),
            h('button', { class: 'btn small', onclick: () => { picking = p.id; api.toast('Click the model where this part pivots.'); } }, picking === p.id ? 'Click the model…' : 'Pick on model')) : null,
          h('label', null, 'Driven by signal', h('input', { type: 'text', list: 'r3-signals', value: j.signal || '', id: 'p-sig-' + p.id, placeholder: 'e.g. Turret/Degrees', onchange: e => { j.signal = e.target.value.trim(); up(); } })),
          h('div', { class: 'r3-grid' },
            h('label', null, 'Signal unit', h('select', { class: 'sel', id: 'p-un-' + p.id, onchange: e => { j.unit = e.target.value; up(); } }, ...(j.type === 'revolute' ? ['deg', 'rad', 'rot', 'raw'] : ['m', 'in', 'mm', 'raw']).map(u => h('option', { value: u, selected: u === j.unit }, u)))),
            h('label', null, 'Scale', num(j.scale ?? 1, v => { j.scale = v ?? 1; }, 'any', 'p-sc-' + p.id)),
            h('label', null, 'Zero (signal at CAD pose)', num(j.zero ?? 0, v => { j.zero = v ?? 0; }, 'any', 'p-z-' + p.id)),
            h('label', { class: 'r3-check' }, h('input', { type: 'checkbox', checked: !!j.invert, id: 'p-inv-' + p.id, onchange: e => { j.invert = e.target.checked; up(); } }), 'Invert')),
          h('label', null, `Preview value (used when the signal has no data)`, h('div', { class: 'r3-slider' },
            h('input', { type: 'range', id: 'p-test-' + p.id, min: j.min ?? (j.type === 'revolute' ? -180 : 0), max: j.max ?? (j.type === 'revolute' ? 180 : 1), step: 'any', value: j.test ?? 0, oninput: e => { j.test = parseFloat(e.target.value); api.onPreview(); }, onchange: () => save() }),
            h('span', { class: 'mono' }, fmtNum(j.test ?? 0)))),
        );
      }
      rows.push(h('label', null, 'Motor on this part (CAN ID)', h('select', { class: 'sel', id: 'p-can-' + p.id, onchange: e => { p.canId = e.target.value === '' ? null : +e.target.value; up(); } },
        h('option', { value: '' }, '— none —'), ...(p.canId != null && !motorOpts.some(m => m.canId === p.canId) ? [h('option', { value: p.canId, selected: true }, `CAN ${p.canId} (not in this log)`)] : []),
        ...motorOpts.map(m => h('option', { value: m.canId, selected: m.canId === p.canId }, `CAN ${m.canId} · ${m.name}`)))));
      rows.push(h('div', { class: 'r3-row' }, h('button', { class: 'linkbtn danger', onclick: async () => { cfg.parts = cfg.parts.filter(x => x.id !== p.id); cfg.parts.forEach(x => { if (x.parent === p.id) x.parent = p.parent; }); selected = null; await rebuild(); } }, 'Remove part')));
      void signals;
      return h('div', { class: 'r3-editor' }, ...rows.filter(Boolean));
    }
    const fmtNum = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
    function isDescendant(id, ancestor) { let p = cfg.parts.find(x => x.id === id); const seen = new Set(); while (p && p.parent && !seen.has(p.id)) { seen.add(p.id); if (p.parent === ancestor) return true; p = cfg.parts.find(x => x.id === p.parent); } return false; }

    async function exportSetup() {
      const out = { ...JSON.parse(JSON.stringify(cfg)), files: {} };
      for (const p of cfg.parts) if (p.file && files.has(p.file) && !out.files[p.file]) {
        const f = files.get(p.file); const u8 = new Uint8Array(f.data); let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        out.files[p.file] = { name: f.name, type: f.type, b64: btoa(s) };
      }
      return new Blob([JSON.stringify(out)], { type: 'application/json' });
    }
    async function importSetup(file) {
      const j = JSON.parse(await file.text());
      if (!Array.isArray(j.parts)) throw new Error('That file isn\'t a robot setup.');
      for (const [id, f] of Object.entries(j.files || {})) {
        const bin = atob(f.b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const rec = { name: f.name, type: f.type, data: u8.buffer }; files.set(id, rec); parsed.delete(id); await kvSet('file:' + id, rec);
      }
      delete j.files; cfg = j; save(); if (view) view.framed = false; await buildScene(); api.onChange();
    }
    async function reset(toSample) {
      for (const id of files.keys()) await kvDel('file:' + id);
      files.clear(); parsed.clear(); cfg = sampleConfig(); if (!toSample) cfg = { version: 1, model: { units: 'mm', up: 'z', yaw: 0 }, parts: [] };
      selected = null; save(); if (view) view.framed = false; await buildScene(); api.onChange();
    }
    async function setModel(k, v) { cfg.model = { ...(cfg.model || {}), [k]: v }; save(); if (view) view.framed = false; await buildScene(); api.onChange(); }

    return {
      load, mountView, render, buildScene, addFiles, partEditor, exportSetup, importSetup, reset, setModel,
      get cfg() { return cfg; }, get selected() { return selected; }, set selected(v) { selected = v; },
      get picking() { return picking; }, jointValue, frame: () => view && frame(),
    };
  }
  return { create, sampleConfig };
})();
if (typeof module !== 'undefined') module.exports = Robot3D;
