// T40 Barbería · Servidor de reservas (src/index.js)
// Cloudflare Workers + Static Assets (carpeta public/, enlace ASSETS) + base de datos D1 (enlace DB).
// Con "run_worker_first": ["/api/*"] en wrangler.jsonc, este Worker atiende SOLO las rutas /api/*;
// el resto de la web (index.html, admin.html...) la sirve Cloudflare directamente desde public/.

// ============ CONFIGURACIÓN (edítala con el propietario y vuelve a subir la web) ============
const CONFIG = {
  zona: "Europe/Madrid",
  // Horario real del cartel de T40. Día de la semana: 0=domingo ... 6=sábado. Lunes cerrado.
  horario: {
    0: [["09:00", "14:00"], ["16:00", "21:00"]],
    1: [],
    2: [["09:00", "14:00"], ["16:00", "21:00"]],
    3: [["09:00", "14:00"], ["16:00", "21:00"]],
    4: [["09:00", "14:00"], ["16:00", "21:00"]],
    5: [["09:00", "14:00"], ["16:00", "21:00"]],
    6: [["09:00", "14:00"], ["16:00", "21:00"]],
  },
  paso: 30,                  // minutos entre una hora y la siguiente (10:00, 10:30...). CONFIRMADO por el propietario. No es la duración del servicio.
  capacidad: 1,              // citas a la vez. 1 = nunca se solapan. CONFIRMAR: ¿cuántos barberos/sillones atienden a la vez?
  diasAdelante: 30,          // hasta cuántos días por delante se puede reservar. CONFIRMAR
  maxActivasPorTelefono: 2,  // reservas futuras por teléfono (evita que alguien llene la agenda). CONFIRMAR
  tardeDesde: "14:00",       // solo agrupa los botones: antes = Mañana
  nocheDesde: "20:00",       // desde aquí = Noche; entre medias = Tarde
  // SERVICIOS Y PRECIOS (lista confirmada por el propietario). Si cambia un precio, cámbialo AQUÍ y en la lista de index.html.
  // DURACIONES: 30 minutos cada servicio (confirmado por el propietario). Si algún día cambia, pon aquí los minutos (número entero).
  // Con "null" las reservas NO se activan y la web ofrece pedir la cita por WhatsApp.
  servicios: [
    { id: "corte", nombre: "Corte normal", precio: 10, duracion: 30 },
    { id: "corte-barba", nombre: "Corte + barba", precio: 15, duracion: 30 },
    { id: "barba", nombre: "Barba", precio: 6, duracion: 30 },
    { id: "mascarilla", nombre: "Mascarilla", precio: 5, duracion: 30 },
    { id: "proteina", nombre: "Proteína", precio: 50, duracion: 30 },
    { id: "mechas-plateadas", nombre: "Mechas plateadas", precio: 50, duracion: 30 },
    { id: "combo-completo", nombre: "Corte + barba + mascarilla + lavado", precio: 25, duracion: 30 },
  ],
};
// ================================================================================================

const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: {
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const err = (msg, status = 400) => J({ ok: false, error: msg }, status);

const aMin = (h) => { const p = h.split(":"); return (+p[0]) * 60 + (+p[1]); };
const aHora = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
function ahora() {
  const o = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.zona, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).forEach((p) => { o[p.type] = p.value; });
  return { fecha: o.year + "-" + o.month + "-" + o.day, min: (+o.hour % 24) * 60 + (+o.minute) };
}
const esFecha = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00Z")) && new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s;
const dow = (s) => new Date(s + "T12:00:00Z").getUTCDay();
const masDias = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Lecturas SIEMPRE de la base principal de D1 ("first-primary"). Si la base tuviera réplicas de lectura, una lectura normal
// podría devolver datos antiguos y mostrar libre una hora que acaba de reservarse.
function bd(env) {
  try { if (typeof env.DB.withSession === "function") return env.DB.withSession("first-primary"); } catch (e) { /* se usa la base tal cual */ }
  return env.DB;
}
const servicioPorId = (id) => CONFIG.servicios.find((s) => s.id === id);
const durOk = (s) => Number.isInteger(s.duracion) && s.duracion > 0 && s.duracion <= 480;
function motivoNoListo(env) {
  if (!env.DB) return "Base de datos no conectada";
  if (!CONFIG.servicios.length || !CONFIG.servicios.every(durOk)) return "Faltan las duraciones de los servicios";
  return null;
}
// Horas de inicio posibles ese día para una duración (dentro del horario y sin pasar la hora de cierre del tramo)
function inicios(fecha, dur) {
  const h = ahora(), out = [];
  for (const [a, b] of CONFIG.horario[dow(fecha)] || []) {
    const A = aMin(a), B = aMin(b);
    for (let t = A; t + dur <= B; t += CONFIG.paso) { if (fecha === h.fecha && t <= h.min) continue; out.push(t); }
  }
  return out;
}
async function ocupadas(env, fecha) {
  const r = await bd(env).prepare("SELECT inicio, fin FROM reservas WHERE fecha = ?1 AND estado = 'confirmada'").bind(fecha).all();
  return r.results || [];
}
const choques = (oc, ini, fin) => oc.filter((o) => o.inicio < fin && o.fin > ini).length;
function codigo() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => L[x % L.length]).join("");
}
function igual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

function config(env) {
  const h = ahora(), mot = motivoNoListo(env);
  return J({ ok: true, listo: !mot, motivo: mot, hoy: h.fecha, hasta: masDias(h.fecha, CONFIG.diasAdelante), paso: CONFIG.paso, capacidad: CONFIG.capacidad,
    tardeDesde: CONFIG.tardeDesde, nocheDesde: CONFIG.nocheDesde,
    servicios: CONFIG.servicios.map((s) => ({ id: s.id, nombre: s.nombre, precio: s.precio, duracion: s.duracion })) });
}
async function disponibilidad(env, url) {
  if (motivoNoListo(env)) return err("El sistema de reservas no está activado", 503);
  const sv = servicioPorId(url.searchParams.get("servicio") || ""), fecha = url.searchParams.get("fecha") || "";
  if (!sv) return err("Elige un servicio");
  if (!esFecha(fecha)) return err("Elige un día válido");
  const h = ahora();
  if (fecha < h.fecha || fecha > masDias(h.fecha, CONFIG.diasAdelante)) return err("Ese día no se puede reservar");
  const todas = (CONFIG.horario[dow(fecha)] || []).length === 0 ? null : inicios(fecha, sv.duracion);
  if (todas === null) return J({ ok: true, cerrado: true, horas: [] });
  const oc = await ocupadas(env, fecha);
  return J({ ok: true, cerrado: false, capacidad: CONFIG.capacidad,
    ocupadas: oc.map((o) => ({ desde: aHora(o.inicio), hasta: aHora(o.fin) })),
    horas: todas.map((t) => ({ h: aHora(t), libre: choques(oc, t, t + sv.duracion) < CONFIG.capacidad })) });
}
async function reservar(request, env) {
  let b;
  try { const t = await request.text(); if (t.length > 4000) return err("Datos demasiado largos"); b = JSON.parse(t); } catch (e) { return err("Datos no válidos"); }
  if (!b || typeof b !== "object") return err("Datos no válidos");
  if (b.web) return err("No se pudo completar la reserva");           // campo trampa para robots
  if (motivoNoListo(env)) return err("El sistema de reservas no está activado", 503);
  const sv = servicioPorId(String(b.servicio || "")); if (!sv) return err("Elige un servicio");
  const fecha = String(b.fecha || ""), hora = String(b.hora || "");
  if (!esFecha(fecha)) return err("Elige un día válido");
  const h = ahora();
  if (fecha < h.fecha || fecha > masDias(h.fecha, CONFIG.diasAdelante)) return err("Ese día no se puede reservar");
  if (!/^\d{2}:\d{2}$/.test(hora)) return err("Elige una hora");
  const ini = aMin(hora);
  if (!inicios(fecha, sv.duracion).includes(ini)) return err("Esa hora no está disponible");
  const nombre = String(b.nombre || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (nombre.length < 2 || nombre.length > 60) return err("Escribe tu nombre");
  const tel = String(b.telefono || "").replace(/[\s.\-()]/g, "").replace(/^(\+34|0034)/, "");
  if (!/^[6789]\d{8}$/.test(tel)) return err("Escribe un teléfono español válido de 9 cifras");
  const notas = String(b.notas || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  const db = bd(env);
  const cuentaTel = async () => (await db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE telefono = ?1 AND estado = 'confirmada' AND fecha >= ?2").bind(tel, h.fecha).first()).n;
  const msgLimite = "Ya tienes " + CONFIG.maxActivasPorTelefono + " reservas activas con este teléfono. Para cambiar una, habla con T40 por WhatsApp.";
  if ((await cuentaTel()) >= CONFIG.maxActivasPorTelefono) return err(msgLimite, 429);
  const fin = ini + sv.duracion, ref = codigo(), id = crypto.randomUUID();
  // Inserción ATÓMICA: solo se guarda si en ese momento no hay choque. Si dos clientes pulsan a la vez, solo entra uno.
  try {
    await db.prepare(
      "INSERT INTO reservas (id, ref, fecha, inicio, fin, servicio, duracion, nombre, telefono, notas, estado, creada) " +
      "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'confirmada', ?11 " +
      "WHERE (SELECT COUNT(*) FROM reservas WHERE fecha = ?3 AND estado = 'confirmada' AND inicio < ?5 AND fin > ?4) < ?12 " +
      "AND (SELECT COUNT(*) FROM reservas WHERE telefono = ?9 AND estado = 'confirmada' AND fecha >= ?13) < ?14"
    ).bind(id, ref, fecha, ini, fin, sv.nombre, sv.duracion, nombre, tel, notas, new Date().toISOString(),
      CONFIG.capacidad, h.fecha, CONFIG.maxActivasPorTelefono).run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e && e.message) || e))) return err("Esa hora acaba de ocuparse. Elige otra.", 409);
    throw e;
  }
  // Comprobamos leyendo la fila: solo se confirma si la reserva está de verdad guardada en D1.
  const guardada = await db.prepare("SELECT id FROM reservas WHERE id = ?1 AND estado = 'confirmada'").bind(id).first();
  if (!guardada) {
    if ((await cuentaTel()) >= CONFIG.maxActivasPorTelefono) return err(msgLimite, 429);
    return err("Esa hora acaba de ocuparse. Elige otra.", 409);
  }
  // Segunda red de seguridad: si por cualquier motivo hubiera más citas solapadas que la capacidad, se deshace la nuestra.
  const solapadas = (await db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE fecha = ?1 AND estado = 'confirmada' AND inicio < ?3 AND fin > ?2").bind(fecha, ini, fin).first()).n;
  if (solapadas > CONFIG.capacidad) {
    await db.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?1").bind(id).run();
    return err("Esa hora acaba de ocuparse. Elige otra.", 409);
  }
  return J({ ok: true, ref, fecha, hora: aHora(ini), fin: aHora(fin), servicio: sv.nombre, precio: sv.precio, nombre });
}
async function admin(request, env, url) {
  if (!env.DB) return err("Base de datos no conectada", 503);
  const db = bd(env);
  const tok = env.ADMIN_TOKEN;
  if (!tok || String(tok).length < 16) return err("El acceso de administración no está configurado", 503);
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!igual(auth, String(tok))) return err("No autorizado", 401);
  if (request.method === "GET") {
    const h = ahora(), d = url.searchParams.get("desde") || h.fecha, a = url.searchParams.get("hasta") || masDias(h.fecha, 60);
    if (!esFecha(d) || !esFecha(a)) return err("Fechas no válidas");
    const r = await db.prepare("SELECT id, ref, fecha, inicio, fin, servicio, nombre, telefono, notas, estado FROM reservas WHERE fecha >= ?1 AND fecha <= ?2 ORDER BY fecha, inicio").bind(d, a).all();
    const tot = await db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE estado = 'confirmada'").first();
    return J({ ok: true, info: { confirmadas: tot ? tot.n : 0, capacidad: CONFIG.capacidad, paso: CONFIG.paso, zona: CONFIG.zona }, reservas: (r.results || []).map((x) => ({ id: x.id, ref: x.ref, fecha: x.fecha, hora: aHora(x.inicio), fin: aHora(x.fin),
      servicio: x.servicio, nombre: x.nombre, telefono: x.telefono, notas: x.notas || "", estado: x.estado })) });
  }
  if (request.method === "POST") {
    let b; try { b = JSON.parse(await request.text()); } catch (e) { return err("Datos no válidos"); }
    if (!b || b.accion !== "cancelar" || typeof b.id !== "string") return err("Acción no válida");
    await db.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?1 AND estado = 'confirmada'").bind(b.id).run();
    const x = await db.prepare("SELECT estado FROM reservas WHERE id = ?1").bind(b.id).first();
    return J({ ok: true, cancelada: !!x && x.estado === "cancelada" });
  }
  return err("Método no permitido", 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname.replace(/\/+$/, "");
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (request.method === "POST") {
        const o = request.headers.get("Origin");
        if (o && new URL(o).host !== url.host) return err("Origen no permitido", 403);
      }
      if (p === "/api/config" && request.method === "GET") return config(env);
      if (p === "/api/disponibilidad" && request.method === "GET") return await disponibilidad(env, url);
      if (p === "/api/reservar" && request.method === "POST") return await reservar(request, env);
      if (p === "/api/admin") return await admin(request, env, url);
      return err("No encontrado", 404);
    } catch (e) {
      return err("Error del servidor. Inténtalo de nuevo en un momento.", 500);
    }
  },
};
