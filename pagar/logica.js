// Lógica pura de /pagar/ y /pago/ (ADR-0033, 2026-11-08; brief § 7.0, § 7.1 y
// § 7.2, con A.3 y A.4; addendum § 2 y § 2bis, que manda).
//
// Aquí no hay DOM: pagar.js y pago.js conectan esto con la página, y
// app-clinica/tests/landing.pagar.test.ts lo prueba con vitest. Lo que se
// decide aquí lo ve la persona que paga: a qué cuenta va el pago, cuánto
// cuesta, hasta cuándo queda su licencia y qué pasó con su pago. Por eso los
// textos viven junto a las reglas que los eligen, y no repartidos en el DOM.
//
// Tres funciones copian a propósito las de supabase/functions/_shared/mp.ts:
// correoMpValido, enmascararCorreo y urlDePagoValida. La página no puede
// importar TypeScript, y si aceptara un correo que el servidor rechaza, la
// persona vería el error recién después de pulsar «Suscribirme». Los tests
// comparan las dos versiones caso por caso.
//
// Ninguna función escribe en la página: devuelven texto plano, que el DOM pone
// con textContent. Ningún texto sale de la URL: lo que llega en la query solo
// elige entre textos fijos (así nadie arma un enlace que muestre su propio
// mensaje en arkheapp.cl).

// ————— Constantes —————

/** El proyecto de Supabase de Arkhé: el mismo de la app y el único host que la CSP deja llamar. */
export const SUPABASE_URL = "https://nsddheueksmwqflutddl.supabase.co";

/**
 * La clave pública («anon key») del proyecto, la misma de
 * app-clinica/src/cloud/config.ts. Es pública por diseño: va en todo cliente,
 * y lo que protege cada cuenta es el JWT de la persona y lo que comprueba cada
 * función. Un test exige que sea igual a la de la app, para que una rotación
 * no deje esta página atrás.
 */
export const CLAVE_PUBLICA =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZGRoZXVla3Ntd3FmbHV0ZGRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4Nzc4NTYsImV4cCI6MjEwNjQ1Mzg1Nn0.k34Ch0-g1LB3gDA8wJe0oNY9M8SJkWZOHIBHLxxncH0";

/** A dónde vuelve Google: tiene que estar en las Redirect URLs de Supabase Auth (C4 del brief). */
export const VUELTA_GOOGLE = "https://arkheapp.cl/pagar/";

/** Versión de /condiciones/ que se acepta aquí. La que se guarda en el cobro la fija el servidor (CONDICIONES_VIGENTES). */
export const VERSION_CONDICIONES = "2026-11-08";

/**
 * Versión de /privacidad/ que se acepta antes de entrar con Google. Va a
 * crear-pago al cotizar y al pagar, y el servidor la guarda como constancia
 * (tabla `aceptaciones`) solo si es la suya (VERSION_PRIVACIDAD de precio.ts):
 * un test exige que las tres sean la misma, la de aquí, la del servidor y la
 * que publica /privacidad/.
 */
export const VERSION_PRIVACIDAD = "2026-11-08";

/**
 * Los precios publicados en arkheapp.cl, IVA incluido. Solo se muestran antes
 * de entrar: con sesión manda la cotización del servidor, que es lo que se
 * cobra (la página nunca manda un monto).
 */
export const PRECIOS = Object.freeze({ anual: 199900, mensual: 19990 });

/** Lo que /pagar/ guarda en sessionStorage, y /pago/ lee. Solo mientras la pestaña está abierta. */
export const CLAVES = Object.freeze({
  pkce: "arkhe.pagar.pkce", // { verificador, plan, creado }: vive solo durante el viaje a Google
  sesion: "arkhe.pagar.sesion", // { token, vence, correo }: sin refresh token (brief § 7.1)
  cobro: "arkhe.pagar.cobro", // { id, plan, tipo, creado }: el cobro que se fue a pagar
  plan: "arkhe.pagar.plan", // el plan elegido
  privacidad: "arkhe.pagar.privacidad", // { version, en }: qué aviso aceptó y cuándo
  elegirCuenta: "arkhe.pagar.elegir", // true después de «Cambiar»: Google muestra el selector de cuentas
});

/** Cuánto se espera al servidor antes de decir «Sin conexión». */
export const PLAZO_MS = 20000;

/** Una sesión que vence en menos de esto ya no sirve: la llamada llegaría vencida. */
export const MARGEN_SESION_MS = 60000;

/**
 * El sondeo de /pago/ (brief § 7.2; 2bis, «Primer cobro y retorno»): cada 4 s
 * durante 2 min mientras se espera el pago. Una suscripción ya autorizada
 * (`suscrita`) no se espera a ese ritmo, porque su primer cobro llega
 * alrededor de una hora después: se pregunta cada minuto, y solo con la
 * página a la vista, hasta los 75 min.
 */
export const SONDEO = Object.freeze({
  rapidoMs: 4000,
  rapidoHastaMs: 2 * 60000,
  lentoMs: 60000,
  lentoHastaMs: 75 * 60000,
});

// ————— Ayudantes —————

function esObjeto(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un UUID (el id de un cobro) en minúsculas, o null. */
export function uuid(v) {
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
}

function numero(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ————— PKCE con Google (como app-clinica/src/cloud/pkce.ts y gotrue.ts) —————

const ALFABETO_VERIFICADOR = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * Verificador PKCE de 64 caracteres del alfabeto de la RFC 7636. Se queda en
 * esta pestaña; a Google solo va su hash. Así, quien intercepte el código de
 * vuelta no puede canjearlo.
 */
export function generarVerificador(cripto = globalThis.crypto) {
  if (!cripto || typeof cripto.getRandomValues !== "function") {
    throw new Error("Este navegador no tiene un generador de números aleatorios seguro.");
  }
  const bytes = cripto.getRandomValues(new Uint8Array(64));
  let s = "";
  for (const b of bytes) s += ALFABETO_VERIFICADOR[b % ALFABETO_VERIFICADOR.length];
  return s;
}

/** Bytes → base64url sin relleno. */
export function base64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Reto S256: base64url(SHA-256(verificador)). */
export async function retoS256(verificador, cripto = globalThis.crypto) {
  if (!cripto || !cripto.subtle) throw new Error("Este navegador no tiene WebCrypto (SHA-256).");
  const resumen = await cripto.subtle.digest("SHA-256", new TextEncoder().encode(verificador));
  return base64Url(new Uint8Array(resumen));
}

/**
 * La URL para entrar con Google, con los mismos parámetros que la app
 * (gotrue.ts, authorizeUrl). `elegirCuenta` pide a Google su selector de
 * cuentas: se usa después de «¿No es tu cuenta? Cambiar», porque si no,
 * Google vuelve a entrar sola con la cuenta de antes.
 */
export function urlAutorizar({ reto, vuelta = VUELTA_GOOGLE, elegirCuenta = false }) {
  const q = new URLSearchParams({
    provider: "google",
    redirect_to: vuelta,
    code_challenge: reto,
    code_challenge_method: "s256",
  });
  if (elegirCuenta) q.set("prompt", "select_account");
  return `${SUPABASE_URL}/auth/v1/authorize?${q.toString()}`;
}

/** Donde se canjea el código de Google por la sesión (gotrue.ts, exchangeCode). */
export const URL_CANJE = `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`;

/** Donde se cierra la sesión que abrió esta página (solo esa: scope=local). */
export const URL_SALIR = `${SUPABASE_URL}/auth/v1/logout?scope=local`;

export function cuerpoCanje(codigo, verificador) {
  return { auth_code: codigo, code_verifier: verificador };
}

/**
 * Lo que se guarda de la sesión de GoTrue: el access token, su vencimiento y
 * el correo. Nunca el refresh token (brief § 7.1): si el token vence, la
 * persona vuelve a entrar. null si la respuesta no trae un token.
 */
export function sesionDesdeToken(json, ahoraMs) {
  if (!esObjeto(json) || typeof json.access_token !== "string" || json.access_token === "") return null;
  const usuario = esObjeto(json.user) ? json.user : {};
  const correo = typeof usuario.email === "string" ? usuario.email.trim() : "";
  const venceEn = numero(json.expires_at);
  const duracion = numero(json.expires_in);
  const vence = venceEn !== null ? venceEn * 1000 : ahoraMs + (duracion !== null ? duracion : 3600) * 1000;
  return { token: json.access_token, vence, correo };
}

/** ¿La sesión guardada todavía sirve para llamar a las funciones? */
export function sesionVigente(sesion, ahoraMs) {
  return (
    esObjeto(sesion) &&
    typeof sesion.token === "string" &&
    sesion.token !== "" &&
    typeof sesion.vence === "number" &&
    sesion.vence - MARGEN_SESION_MS > ahoraMs
  );
}

// ————— Llamadas al servidor —————

const FUNCIONES = new Set(["crear-pago", "consultar-pago", "cancelar-suscripcion"]);

/** La URL de una de las funciones del cobro. Un nombre que no es de la lista es un error de programación. */
export function urlFuncion(nombre) {
  if (!FUNCIONES.has(nombre)) throw new TypeError(`urlFuncion: función desconocida ${nombre}`);
  return `${SUPABASE_URL}/functions/v1/${nombre}`;
}

/**
 * Un POST a Supabase con la clave pública y, si hay sesión, el JWT de la
 * persona. Devuelve { status, json } y nunca lanza: sin red, o si el servidor
 * no responde en `plazoMs`, `status` es 0 y la página dice «Sin conexión».
 * El `fetch` llega como argumento: el del navegador, o un doble en los tests.
 */
export async function llamar({ fetch: hacerFetch, url, cuerpo, token = null, plazoMs = PLAZO_MS }) {
  const headers = { apikey: CLAVE_PUBLICA };
  if (cuerpo !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), plazoMs);
  try {
    const res = await hacerFetch(url, {
      method: "POST",
      headers,
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: control.signal,
      // Sin cookies ni caché: la sesión va en el Bearer, y la respuesta de un pago nunca se reutiliza.
      credentials: "omit",
      cache: "no-store",
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null; // un 204, o un error de la plataforma en HTML
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  } finally {
    clearTimeout(corte);
  }
}

// ————— Lo que llega en la URL —————

/**
 * La vuelta de Google: `?code=` si entró, `?error=` si no. GoTrue manda el
 * error en la query y repetido en el fragmento, así que se miran los dos. La
 * descripción del error nunca se muestra: llega en la URL, y cualquiera puede
 * armar un enlace con el texto que quiera.
 */
export function leerVueltaGoogle(search, hash = "") {
  const q = new URLSearchParams(search);
  const h = new URLSearchParams(String(hash).replace(/^#/, ""));
  const codigo = q.get("code");
  if (codigo !== null) {
    // GoTrue entrega un UUID; se acepta cualquier código con caracteres de URL comunes.
    return /^[A-Za-z0-9._~-]{1,512}$/.test(codigo) ? { tipo: "codigo", codigo } : { tipo: "error", motivo: "fallo" };
  }
  const error = q.get("error") ?? h.get("error");
  if (error !== null) {
    const codigoError = q.get("error_code") ?? h.get("error_code") ?? "";
    // access_denied sin otro código es «la persona dijo que no» en la pantalla de Google.
    const cancelado = error === "access_denied" && (codigoError === "" || codigoError === "access_denied");
    return { tipo: "error", motivo: cancelado ? "cancelado" : "fallo" };
  }
  return { tipo: "nada" };
}

/** El texto para una vuelta de Google con error. */
export function mensajeVueltaGoogle(motivo) {
  if (motivo === "cancelado") return "Cancelaste la entrada con Google. Cuando quieras, vuelve a intentarlo.";
  return "No se pudo entrar con Google. Inténtalo de nuevo; si sigue fallando, escríbenos.";
}

/** `?plan=anual` o `?plan=mensual` (los botones de la portada); cualquier otra cosa, null. */
export function leerPlanDeUrl(search) {
  const plan = new URLSearchParams(search).get("plan");
  return plan === "anual" || plan === "mensual" ? plan : null;
}

const STATUS_MP = /^[a-z_]{1,40}$/;

function idSeguro(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) && v !== "null" ? v : null;
}

/**
 * La vuelta de Mercado Pago a /pago/. Checkout Pro agrega `status` (o
 * `collection_status`), `external_reference` y `payment_id` (brief § 3); la
 * suscripción no documenta qué agrega (2bis), así que nada de esto es
 * obligatorio. MP escribe «null» cuando no hay pago. Nada de esto confirma
 * un pago: solo elige el texto cuando no hay sesión para consultar.
 */
export function leerVueltaMP(search) {
  const q = new URLSearchParams(search);
  const crudo = q.get("status") ?? q.get("collection_status");
  const status = crudo !== null && crudo !== "null" && STATUS_MP.test(crudo) ? crudo : null;
  return {
    status,
    externalReference: uuid(q.get("external_reference")),
    pagoId: idSeguro(q.get("payment_id") ?? q.get("collection_id")),
    preapprovalId: idSeguro(q.get("preapproval_id")),
  };
}

// ————— Formato —————

/** 199900 → «$199.900». */
export function pesos(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return "";
  const cifras = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${v < 0 ? "-" : ""}$${cifras}`;
}

/** El día de hoy en Chile continental, `AAAA-MM-DD` (el mismo `hoyChile` del servidor). */
export function hoyChile(ahora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora);
}

/** `AAAA-MM-DD` + n días, en UTC para que ningún cambio de hora corra el día. */
export function sumarDias(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * El día de una fecha del servidor, `AAAA-MM-DD`, o null. Una fecha sola
 * (`cuentas.vence`) se toma tal cual, sin pasar por zonas horarias: así un
 * 20 de noviembre nunca se muestra como 19. Una fecha con hora (el próximo
 * cobro, desde cuándo está pendiente un pago) se lleva al día de Chile.
 */
export function diaChile(valor) {
  if (typeof valor !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const [y, m, d] = valor.split("-").map(Number);
    const fecha = new Date(Date.UTC(y, m - 1, d));
    return fecha.getUTCFullYear() === y && fecha.getUTCMonth() === m - 1 && fecha.getUTCDate() === d ? valor : null;
  }
  const ms = Date.parse(valor);
  return Number.isNaN(ms) ? null : hoyChile(new Date(ms));
}

const NOMBRES_MES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** «20 de noviembre de 2027», o null si no es una fecha. */
export function fechaLarga(valor) {
  const dia = diaChile(valor);
  if (dia === null) return null;
  const [y, m, d] = dia.split("-").map(Number);
  return `${d} de ${NOMBRES_MES[m - 1]} de ${y}`;
}

// ————— Correo (copias de supabase/functions/_shared/mp.ts) —————

/** Sin los espacios de los bordes y en minúsculas: lo mismo que el servidor manda a MP y hashea. */
export function normalizarCorreo(correo) {
  return String(correo ?? "").trim().toLowerCase();
}

// La misma expresión de mp.ts (correoValido): si la página aceptara un correo
// que el servidor rechaza, la persona vería el error recién al pulsar el botón.
const CORREO =
  /^(?=[^@]{1,64}@)[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

/** ¿Es un correo con forma razonable, de 254 caracteres o menos? (mp.ts, correoValido). */
export function correoMpValido(correo) {
  if (typeof correo !== "string") return false;
  const c = correo.trim();
  return c.length <= 254 && CORREO.test(c);
}

/** «daniela@gmail.com» → «d***@gmail.com» (mp.ts, enmascararCorreo). */
export function enmascararCorreo(correo) {
  const c = String(correo ?? "").trim();
  const arroba = c.lastIndexOf("@");
  if (arroba <= 0 || arroba === c.length - 1) return "***";
  const primera = Array.from(c.slice(0, arroba))[0];
  return `${primera}***${c.slice(arroba)}`;
}

const DOMINIOS_MP = ["mercadopago.cl", "mercadopago.com"];

/**
 * ¿Es un link de pago de MP que se puede abrir? https, y un host que sea
 * mercadopago.cl o mercadopago.com o un subdominio suyo, sin usuario,
 * contraseña ni puerto (mp.ts, urlDePagoValida). La página solo navega a una
 * URL que pase esto, aunque venga de nuestro servidor.
 */
export function urlDePagoValida(u) {
  if (typeof u !== "string") return false;
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return DOMINIOS_MP.some((d) => host === d || host.endsWith(`.${d}`));
}

// ————— Respuestas del servidor —————

const SUSCRIPCION_PARA_PAGINA = {
  pending: "pendiente",
  pendiente: "pendiente",
  authorized: "activa",
  activa: "activa",
  paused: "pausada",
  pausada: "pausada",
  canceled: "cancelada",
  cancelled: "cancelada",
  cancelada: "cancelada",
};

/**
 * El estado de una suscripción como lo muestra la página. Acepta las palabras
 * de MP (authorized, paused…) y las que ve el cliente (activa, pausada…): el
 * addendum no fija cuáles manda cada respuesta, y así ninguna queda sin texto.
 */
export function estadoSuscripcion(s) {
  if (typeof s !== "string") return null;
  return SUSCRIPCION_PARA_PAGINA[s.trim().toLowerCase()] ?? null;
}

/**
 * `{ cobro_id, estado, proximo_cobro, confirmada }` → lo que usa la página, o
 * null. `confirmada` (crear-pago) dice si Mercado Pago la mostró viva en esa
 * misma consulta: false es «esto es lo que dice nuestra base, sin confirmar»,
 * y null, que no se intentó (otra consulta de la persona la acaba de releer)
 * o que la respuesta no lo dice (consultar-pago no lo manda). Solo false avisa.
 */
export function leerSuscripcion(json) {
  if (!esObjeto(json)) return null;
  const estado = estadoSuscripcion(json.estado);
  if (estado === null) return null;
  return {
    cobroId: uuid(json.cobro_id),
    estado,
    proximoCobro: diaChile(json.proximo_cobro),
    confirmada: typeof json.confirmada === "boolean" ? json.confirmada : null,
  };
}

/** Las cuotas del anual (MP_CUOTAS_ANUAL, de 1 a 12), o null si la respuesta no las dice. */
function cuotasDe(v) {
  const n = numero(v);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/**
 * La cotización de crear-pago (`cotizar: true`), o null si no se entiende.
 * Sin `mensual_modo`, el mensual es una suscripción: es lo que rige si el
 * secreto MP_MENSUAL falta. `suscripcion` queda undefined si la respuesta no
 * trae el campo (no dice nada), y null si lo trae vacío (no hay ninguna):
 * así una respuesta incompleta no hace desaparecer el botón «Cancelar».
 * `condiciones` es la versión que el servidor guardará en el cobro, y
 * `cuotas`, cuántas ofrece Mercado Pago en el anual: la página los compara
 * con lo que muestra antes de dejar pagar. `privacidadAceptada` es si el
 * servidor tiene la constancia de que esta cuenta aceptó la versión vigente
 * del aviso de privacidad (null si la respuesta no lo dice).
 */
export function leerCotizacion(json) {
  if (!esObjeto(json)) return null;
  const plan = json.plan === "anual" || json.plan === "mensual" ? json.plan : null;
  const monto = numero(json.monto);
  if (plan === null || monto === null || monto <= 0) return null;
  return {
    plan,
    monto,
    tarifa: typeof json.tarifa === "string" ? json.tarifa : null,
    nivelActual: typeof json.nivel_actual === "string" ? json.nivel_actual : null,
    venceActual: diaChile(json.vence_actual),
    venceSiPagas: diaChile(json.vence_si_pagas),
    mensualModo: json.mensual_modo === "pago_unico" ? "pago_unico" : "suscripcion",
    condiciones: typeof json.condiciones === "string" ? json.condiciones : null,
    cuotas: cuotasDe(json.cuotas),
    privacidadAceptada: typeof json.privacidad_aceptada === "boolean" ? json.privacidad_aceptada : null,
    suscripcion: json.suscripcion === undefined ? undefined : leerSuscripcion(json.suscripcion),
  };
}

// ————— El aviso de privacidad (Ley 19.628, art. 4) —————

/**
 * Lo que /pagar/ guarda en sessionStorage cuando la persona marca la casilla
 * del aviso: la versión y la hora de esta pestaña. La constancia que vale es
 * la del servidor, que la anota con su propia hora cuando le llega.
 */
export function aceptacionPrivacidad(ahora = new Date()) {
  return { version: VERSION_PRIVACIDAD, en: ahora.toISOString() };
}

/**
 * La versión del aviso que se manda a crear-pago (`privacidad`, al cotizar y
 * al pagar), o null si en esta pestaña no se aceptó la versión que la página
 * muestra. Nunca se manda una versión que la persona no vio.
 */
export function privacidadParaEnviar(guardada) {
  return esObjeto(guardada) && guardada.version === VERSION_PRIVACIDAD ? VERSION_PRIVACIDAD : null;
}

/**
 * Qué hace la página con lo que dijo crear-pago del aviso de privacidad:
 * - `aceptada`: privacidad_aceptada de la cotización (true, false o null), o
 *   false si al pagar respondió 409 falta_privacidad;
 * - `mandada`: si esta pestaña le mandó la versión que muestra.
 * Devuelve:
 * - "ok": el servidor la tiene, o no dijo nada;
 * - "pedir": no la tiene y no se le mandó: se muestra la casilla del aviso
 *   junto al pago, sin perder el plan ni lo demás que se eligió;
 * - "desactualizada": se le mandó y no la tomó, así que su versión vigente es
 *   otra que la de esta página. Marcar la casilla de nuevo no serviría: hay
 *   que recargar para leer el aviso vigente.
 */
export function estadoPrivacidad({ aceptada, mandada }) {
  if (aceptada !== false) return "ok";
  return mandada ? "desactualizada" : "pedir";
}

/**
 * ¿La versión de las condiciones que guardará el cobro es la que esta página
 * muestra en la casilla? La landing (publicar.sh) y las funciones se publican
 * por separado: si una sale antes que la otra, la persona aceptaría una
 * versión y el cobro guardaría otra. Sin el dato no se puede comprobar, así
 * que tampoco se deja pagar.
 */
export function condicionesVigentes(cotizacion) {
  return cotizacion !== null && cotizacion.condiciones === VERSION_CONDICIONES;
}

/**
 * Qué acepta la casilla de las condiciones: el plan, si es una suscripción
 * (la etiqueta suma el cobro automático), el monto y la versión. Si algo de
 * esto cambia después de marcarla, la casilla se desmarca: aceptar es un acto
 * propio e inequívoco (Ley 19.496 art. 12 A; DS 6 art. 4), y una casilla
 * marcada con el anual no puede valer para un cargo mensual automático.
 * null sin cotización: todavía no hay nada que aceptar.
 */
export function claveAceptacion({ plan, mensualModo, cotizacion }) {
  if (cotizacion === null || cotizacion === undefined) return null;
  return [plan, esSuscripcion(plan, mensualModo) ? "suscripcion" : "pago", cotizacion.monto, cotizacion.condiciones].join("|");
}

/**
 * Justo antes de ir a Mercado Pago: ¿lo que el servidor va a cobrar y guardar
 * es lo que la persona vio y aceptó? crear-pago repite la cotización en su
 * respuesta. Si la versión de las condiciones o el monto cambiaron con la
 * página abierta, no se navega: «Pagas el precio que ves justo antes de ir a
 * Mercado Pago» (/condiciones/, punto 4). En el mensual, tampoco si cambió
 * cómo se cobra (`mensualModo`, el que mostró la página): la persona aceptó
 * un cobro cada mes y le llegaría un pago único, o al revés (R5). Devuelve
 * "ok", "condiciones", "monto", "modo" o "ilegible" (la respuesta no trae la
 * cotización).
 */
export function revisarAntesDeIr(mostrada, recibida, mensualModo = null) {
  if (recibida === null || recibida === undefined) return "ilegible";
  if (recibida.condiciones !== VERSION_CONDICIONES) return "condiciones";
  if (mostrada === null || mostrada === undefined || recibida.monto !== mostrada.monto) return "monto";
  if (recibida.plan === "mensual" && mensualModo !== null && recibida.mensualModo !== mensualModo) return "modo";
  return "ok";
}

/**
 * La suscripción que se muestra cuando llega otra respuesta: la más reciente
 * manda, salvo que diga lo mismo con menos certeza. Si la que se tenía la
 * confirmó Mercado Pago hace un momento (confirmada: true) y la nueva es del
 * mismo cobro y no confirmada (otra consulta, con el candado de la base
 * tomado, o MP que no respondió esta vez), se conserva la confirmada: si no,
 * la tarjeta diría «No pudimos confirmar…» de algo que MP acaba de confirmar
 * (CT3-01). undefined (la respuesta no trae el campo) conserva lo que había.
 */
export function suscripcionMasReciente(antes, nueva) {
  if (nueva === undefined) return antes;
  if (
    esObjeto(antes) &&
    esObjeto(nueva) &&
    antes.confirmada === true &&
    nueva.confirmada !== true &&
    antes.cobroId !== null &&
    antes.cobroId === nueva.cobroId &&
    antes.estado === nueva.estado
  ) {
    return antes;
  }
  return nueva;
}

/** El texto de error que mandó el servidor, si es razonable mostrarlo. */
function textoDelServidor(cuerpo) {
  const t = esObjeto(cuerpo) && typeof cuerpo.error === "string" ? cuerpo.error.trim() : "";
  return t !== "" && t.length <= 300 ? t : null;
}

export const MENSAJES = Object.freeze({
  sinRed: "Sin conexión: revisa tu internet.",
  sesionVencida: "Tu sesión venció: vuelve a entrar.",
  vitalicia: "Tu licencia es vitalicia: no necesitas pagar.",
  demasiados: "Demasiados intentos de pago en una hora. Espera un momento.",
  mpNoResponde: "Mercado Pago no respondió. Intenta de nuevo en un momento.",
  noHabilitado: "El pago en línea no está disponible por ahora. Escríbenos y te activamos por transferencia.",
  planNoDisponible: "Ese plan no está disponible por ahora. Puedes elegir el otro, o escríbenos y vemos cómo pagarlo.",
  correoInvalido: "Revisa el correo de Mercado Pago: no parece un correo válido.",
  urlInvalida: "No pudimos abrir la página de pago. Intenta de nuevo; si sigue, escríbenos.",
  generico: "Algo falló de nuestro lado. Intenta de nuevo en un momento; si sigue, escríbenos.",
  desactualizada: "Esta página se actualizó: recárgala para ver las condiciones vigentes antes de pagar.",
  montoCambio: "El precio cambió mientras tenías la página abierta. Revisa el resumen y vuelve a aceptar las condiciones para pagar.",
  modoCambio: "Las condiciones del plan mensual cambiaron: revisa el resumen y vuelve a aceptar las condiciones para pagar.",
  cancelacionSinConfirmar:
    "No pudimos confirmar la cancelación. Intenta de nuevo en un momento; si sigue igual, escríbenos y la cancelamos nosotros.",
  faltaPrivacidad: "Para pagar, marca que aceptas el aviso de privacidad.",
  privacidadDesactualizada:
    "El aviso de privacidad se actualizó: recarga la página para leer la versión vigente y aceptarla antes de pagar.",
  suscripcionNoVerificable: "No pudimos confirmar el estado de tu suscripción en Mercado Pago. Escríbenos y lo revisamos.",
  suscripcionSinConfirmar:
    "No pudimos confirmar el estado en Mercado Pago: esto es lo último que supimos de tu suscripción. Igual puedes cancelarla aquí; si tienes dudas, escríbenos.",
});

/**
 * crear-pago respondió 503 no_habilitado al pagar, no al cotizar: Mercado Pago
 * no aceptó crear el link con un 4xx que no dice de qué es (2bis: cualquier
 * 4xx de POST /preapproval). Al cotizar sí se podía comprar, así que la compra
 * no se esconde: en el mensual, el rechazo puede venir del correo de Mercado
 * Pago (por ejemplo, el de la cuenta que vende), y la persona tiene que poder
 * corregirlo o elegir el anual sin recargar la página. Cuando el problema es
 * de Arkhé (pago_no_disponible: el vendedor sin validar, o un token de otra
 * cuenta), no se usa este texto: no tiene sentido pedirle revisar su correo (R6).
 */
export function mensajeNoHabilitadoAlPagar(suscripcion) {
  return suscripcion
    ? "Mercado Pago no aceptó crear la suscripción. Revisa el correo de Mercado Pago: debe ser el de tu cuenta de Mercado Pago, o el que escribirás al pagar. También puedes elegir el plan anual, o escribirnos y te activamos por transferencia."
    : "Mercado Pago no aceptó crear el pago por ahora. Intenta de nuevo más tarde, o escríbenos y te activamos por transferencia.";
}

/**
 * Un error de crear-pago, consultar-pago o cancelar-suscripcion, como lo ve
 * la persona (brief § 6.2 y § 7.1, «Errores»). `volverAEntrar` dice que la
 * sesión ya no sirve; `campo`, qué parte de la página tiene que corregir la
 * persona (el correo de MP o la casilla del aviso de privacidad); `contacto`,
 * que el texto pide escribirnos y los contactos tienen que estar a la vista;
 * `reintentar`, que es pasajero y vale la pena intentar de nuevo.
 */
export function errorDeServidor(status, cuerpo) {
  const codigo = esObjeto(cuerpo) && typeof cuerpo.codigo === "string" ? cuerpo.codigo : null;
  if (status === 0) return { codigo: "sin_red", mensaje: MENSAJES.sinRed };
  if (status === 401) return { codigo: "sin_sesion", mensaje: MENSAJES.sesionVencida, volverAEntrar: true };
  // Auth no respondió: la sesión puede estar bien. Es pasajero, con cualquier
  // status, y va antes del 503 genérico, que se lee como «no habilitado».
  if (codigo === "auth_no_responde") return { codigo, mensaje: MENSAJES.generico, reintentar: true };
  // Al pagar sin la constancia del aviso de privacidad en el servidor (decisión 2 del ADR).
  if (status === 409 && codigo === "falta_privacidad") return { codigo, mensaje: MENSAJES.faltaPrivacidad, campo: "privacidad" };
  if (status === 409) return { codigo: "vitalicia", mensaje: MENSAJES.vitalicia };
  if (status === 429) return { codigo: "demasiados_intentos", mensaje: textoDelServidor(cuerpo) ?? MENSAJES.demasiados };
  if (status === 502 || status === 504) return { codigo: "mp_no_responde", mensaje: MENSAJES.mpNoResponde };
  // Un plan desactivado en la base no cierra el otro: la persona puede elegirlo.
  if (status === 503 && codigo === "plan_no_disponible") return { codigo, mensaje: MENSAJES.planNoDisponible };
  // La base dice que hay una suscripción que cobra y Mercado Pago no la deja ver: lo revisa una persona.
  if (status === 503 && codigo === "suscripcion_no_verificable") {
    return { codigo, mensaje: MENSAJES.suscripcionNoVerificable, contacto: true };
  }
  // Lo que no anda es de Arkhé (el vendedor sin validar en MP, o un token de otra cuenta): ni reintentar
  // ni cambiar el correo lo arregla. El texto neutro, con los contactos (R6).
  if (status === 503 && codigo === "pago_no_disponible") return { codigo, mensaje: MENSAJES.noHabilitado, contacto: true };
  if (status === 503) return { codigo: "no_habilitado", mensaje: MENSAJES.noHabilitado };
  if (status === 400 && codigo === "correo_mp_invalido") {
    return { codigo, mensaje: MENSAJES.correoInvalido, campo: "correo" };
  }
  return { codigo: codigo ?? "error", mensaje: MENSAJES.generico };
}

/**
 * La suscripción que trae una respuesta que no deja comprar (habilitado
 * false, o un 409 o 503 que la incluya), si la trae. Aunque no haya nada que
 * comprar, una suscripción viva tiene que verse con su «Cancelar» (A.3).
 */
function suscripcionDeRespuesta(cuerpo) {
  if (!esObjeto(cuerpo) || cuerpo.suscripcion === undefined) return {};
  return { suscripcion: leerSuscripcion(cuerpo.suscripcion) };
}

/**
 * crear-pago con `cotizar: true`: la cotización, o el error. Una cotización
 * con otra versión de las condiciones es el error `pagina_desactualizada`: se
 * pide recargar en vez de dejar pagar. También lo es una que dice que el
 * servidor no tiene la aceptación del aviso de privacidad aunque esta
 * pestaña le mandó la versión que muestra (`privacidadMandada`): su aviso
 * vigente es otro (estadoPrivacidad).
 */
export function leerRespuestaCotizar(status, cuerpo, { privacidadMandada = false } = {}) {
  if (status === 200) {
    if (esObjeto(cuerpo) && cuerpo.habilitado === false) {
      return { tipo: "error", codigo: "no_habilitado", mensaje: MENSAJES.noHabilitado, ...suscripcionDeRespuesta(cuerpo) };
    }
    const cotizacion = leerCotizacion(cuerpo);
    if (cotizacion === null) return { tipo: "error", codigo: "respuesta_ilegible", mensaje: MENSAJES.generico };
    if (!condicionesVigentes(cotizacion)) {
      return { tipo: "error", codigo: "pagina_desactualizada", mensaje: MENSAJES.desactualizada, ...suscripcionDeRespuesta(cuerpo) };
    }
    if (estadoPrivacidad({ aceptada: cotizacion.privacidadAceptada, mandada: privacidadMandada }) === "desactualizada") {
      return { tipo: "error", codigo: "pagina_desactualizada", mensaje: MENSAJES.privacidadDesactualizada, ...suscripcionDeRespuesta(cuerpo) };
    }
    return { tipo: "cotizacion", cotizacion };
  }
  return { tipo: "error", ...errorDeServidor(status, cuerpo), ...suscripcionDeRespuesta(cuerpo) };
}

/**
 * crear-pago sin cotizar (addendum § 2):
 * - con `url`: a Mercado Pago, solo si la URL es de MP. Trae también la
 *   cotización que repite el servidor (monto y versión de las condiciones),
 *   para compararla con revisarAntesDeIr;
 * - `estado: "pendiente"`: ya hay un pago pendiente de ese cobro (brief § 6.2, paso 8);
 * - `tipo: "suscripcion"` con estado activa o pausada y sin url: ya tiene una
 *   suscripción, y el servidor no crea otra.
 * Un 409 falta_privacidad pide la casilla del aviso (`campo: "privacidad"`),
 * salvo que esta pestaña ya le haya mandado la versión que muestra
 * (`privacidadMandada`): entonces la página está desactualizada.
 */
export function leerRespuestaCrearPago(status, cuerpo, { privacidadMandada = false } = {}) {
  if (status !== 200) {
    const error = errorDeServidor(status, cuerpo);
    if (error.codigo === "falta_privacidad" && estadoPrivacidad({ aceptada: false, mandada: privacidadMandada }) === "desactualizada") {
      return { tipo: "error", codigo: "pagina_desactualizada", mensaje: MENSAJES.privacidadDesactualizada };
    }
    // Un 409 (vitalicia) o un 503 (no habilitado) pueden traer la suscripción viva: se conserva, con su «Cancelar».
    return { tipo: "error", ...error, ...suscripcionDeRespuesta(cuerpo) };
  }
  if (!esObjeto(cuerpo)) return { tipo: "error", codigo: "respuesta_ilegible", mensaje: MENSAJES.generico };
  const cobroId = uuid(cuerpo.cobro_id);
  const tipoCobro = cuerpo.tipo === "suscripcion" || cuerpo.tipo === "pago" ? cuerpo.tipo : null;
  if (cuerpo.url !== undefined && cuerpo.url !== null) {
    if (!urlDePagoValida(cuerpo.url)) return { tipo: "error", codigo: "url_invalida", mensaje: MENSAJES.urlInvalida };
    return { tipo: "ir", url: cuerpo.url, cobroId, tipoCobro, reutilizado: cuerpo.reutilizado === true, cotizacion: leerCotizacion(cuerpo) };
  }
  if (cuerpo.estado === "pendiente") {
    return { tipo: "pendiente", cobroId, desde: diaChile(cuerpo.pendiente_desde) };
  }
  const suscripcion = estadoSuscripcion(cuerpo.estado);
  if (tipoCobro === "suscripcion" && (suscripcion === "activa" || suscripcion === "pausada")) {
    // `confirmada` viene en `suscripcion`, que repite lo mismo de arriba (crearPago.ts, respuestaActiva).
    const confirmada = esObjeto(cuerpo.suscripcion) && typeof cuerpo.suscripcion.confirmada === "boolean" ? cuerpo.suscripcion.confirmada : null;
    return {
      tipo: "suscripcion_activa",
      suscripcion: { cobroId, estado: suscripcion, proximoCobro: diaChile(cuerpo.proximo_cobro), confirmada },
    };
  }
  return { tipo: "error", codigo: "respuesta_ilegible", mensaje: MENSAJES.generico };
}

/**
 * cancelar-suscripcion (addendum § 2; supabase/functions/_shared/cancelarSuscripcion.ts):
 * 200 `{ estado: "cancelada", vence, cuenta, retracto_hasta, retracto_hasta_sin_confirmacion }`.
 * `retracto_hasta` es el último día para retractarse si el plazo sigue abierto
 * hoy (10 días corridos desde el primer cobro), o null: con él, la página
 * pregunta por el retracto solo cuando corresponde, como promete /condiciones/
 * (punto 8). `retracto_hasta_sin_confirmacion` es el último de los 90 días que
 * da la ley si no se le envió la confirmación de la compra (punto 9), o null.
 * Los errores de esta función traen un texto pensado para la persona (ofrece
 * cancelar por correo o WhatsApp cuando reintentar no basta): se muestra ese.
 * Solo un 200 que dice `estado: "cancelada"` cuenta: un cuerpo ilegible no
 * confirma nada, y decir «No habrá más cobros» sin que el servidor lo haya
 * visto en Mercado Pago sería prometer lo que no sabemos.
 */
export function leerRespuestaCancelar(status, cuerpo) {
  if (status === 200) {
    if (!esObjeto(cuerpo) || cuerpo.estado !== "cancelada") {
      return { tipo: "error", codigo: "respuesta_ilegible", mensaje: MENSAJES.cancelacionSinConfirmar };
    }
    return {
      tipo: "cancelada",
      vence: diaChile(cuerpo.vence),
      retractoHasta: diaChile(cuerpo.retracto_hasta),
      retractoSinConfirmacion: diaChile(cuerpo.retracto_hasta_sin_confirmacion),
    };
  }
  if (status === 0 || status === 401) return { tipo: "error", ...errorDeServidor(status, cuerpo) };
  const codigo = esObjeto(cuerpo) && typeof cuerpo.codigo === "string" ? cuerpo.codigo : null;
  const delServidor = textoDelServidor(cuerpo);
  if (status === 404) {
    return {
      tipo: "error",
      codigo: codigo ?? "sin_suscripcion",
      mensaje: delServidor ?? "No encontramos una suscripción que cancelar en esta cuenta. Si igual te llega un cobro, escríbenos y te lo devolvemos.",
    };
  }
  if (status === 502 || status === 504) {
    return {
      tipo: "error",
      codigo: codigo ?? "mp_no_responde",
      mensaje: delServidor ?? "Mercado Pago no respondió y la suscripción sigue activa. Intenta de nuevo en un momento; si no se puede, escríbenos y la cancelamos nosotros.",
    };
  }
  const base = errorDeServidor(status, cuerpo);
  return { tipo: "error", ...base, codigo: codigo ?? base.codigo, mensaje: delServidor ?? base.mensaje };
}

/**
 * Hasta qué día se puede retractar, para la pregunta después de cancelar; null
 * si ningún plazo está abierto. `sinConfirmacion` es el plazo de 90 días si la
 * confirmación de la compra no consta como enviada: se dice como condición
 * («si no recibiste el correo…»), porque si llegó, rigen los 10 días
 * (/condiciones/, punto 9; R1).
 */
export function textoRetractoHasta(retractoHasta, sinConfirmacion = null) {
  const fecha = fechaLarga(retractoHasta);
  const larga = fechaLarga(sinConfirmacion);
  if (fecha !== null && larga !== null) {
    return `Puedes hacerlo hasta el ${fecha}, inclusive (si no recibiste el correo de confirmación de tu compra, hasta el ${larga})`;
  }
  if (fecha !== null) return `Puedes hacerlo hasta el ${fecha}, inclusive`;
  if (larga !== null) return `Si no recibiste el correo de confirmación de tu compra, puedes hacerlo hasta el ${larga}, inclusive`;
  return null;
}

/** Los estados que responde consultar-pago (brief § 6.3, más `suscrita` del 2bis). */
export const ESTADOS_PAGO = Object.freeze([
  "esperando",
  "pendiente",
  "suscrita",
  "aprobado",
  "rechazado",
  "anulado",
  "revertido",
  "revision",
]);

/**
 * consultar-pago:
 * - 200: el estado, el vencimiento de la cuenta y, en una suscripción, su estado;
 * - 401 y 404: no hay nada que consultar con esta sesión;
 * - sin red, 429 o 5xx: se vuelve a intentar en la vuelta siguiente.
 * Un estado que no se conoce se muestra como `esperando`: no promete nada.
 */
export function leerRespuestaConsultar(status, cuerpo) {
  if (status === 200 && esObjeto(cuerpo)) {
    const estado = ESTADOS_PAGO.includes(cuerpo.estado) ? cuerpo.estado : "esperando";
    const cuenta = esObjeto(cuerpo.cuenta) ? cuerpo.cuenta : {};
    return {
      tipo: "estado",
      estado,
      // `pago` o `suscripcion`: en una suscripción, un rechazo suele ser un correo de MP que no calza.
      cobroTipo: cuerpo.tipo === "suscripcion" || cuerpo.tipo === "pago" ? cuerpo.tipo : null,
      vence: diaChile(cuerpo.vence) ?? diaChile(cuenta.vence),
      correo: typeof cuenta.email === "string" ? cuenta.email : null,
      suscripcion: leerSuscripcion(cuerpo.suscripcion),
      cobroId: uuid(cuerpo.cobro_id),
    };
  }
  if (status === 401) return { tipo: "sin_sesion" };
  if (status === 404) return { tipo: "no_encontrado" };
  if (status === 0 || status === 429 || status >= 500) return { tipo: "pasajero" };
  return { tipo: "error" };
}

// ————— Textos de /pagar/ —————

/**
 * ¿El mensual de esta cotización es una suscripción? Sin cotización, se
 * supone que sí: es lo que rige por defecto, y el texto se corrige con la
 * cotización antes de que la persona pueda pagar.
 */
export function esSuscripcion(plan, mensualModo) {
  return plan === "mensual" && mensualModo !== "pago_unico";
}

/**
 * Desde y hasta cuándo rige lo que se paga (DS 6 art. 18 con art. 13; requisito
 * «antes de pagar»: desde y hasta cuándo). Empieza el día más lejano entre hoy
 * y el vencimiento actual: la regla de venceSiPagas (precio.ts) y de
 * procesar_pago. Se dice cuándo termina la prueba o la licencia, porque /pagar/
 * no lo muestra en otra parte, y sin eso nadie puede comprobar que pagar no le
 * quita días. null sin la fecha cotizada.
 */
export function periodoCotizado(cotizacion, hoy) {
  const hasta = fechaLarga(cotizacion.venceSiPagas);
  if (hasta === null) return null;
  const v = cotizacion.venceActual;
  const espera = v !== null && v > hoy;
  let porque = "Empieza hoy.";
  if (espera && cotizacion.nivelActual === "prueba") {
    porque = `Empieza cuando termina tu prueba, el ${fechaLarga(v)}: pagar hoy no te quita días.`;
  } else if (espera) {
    porque = `Empieza cuando termina tu licencia vigente, el ${fechaLarga(v)}: pagar hoy no te quita días.`;
  }
  return { desde: fechaLarga(espera ? v : hoy), hasta, porque };
}

/**
 * Cómo se paga el anual. Las cuotas las fija MP_CUOTAS_ANUAL (de 1 a 12) en la
 * preferencia, y la cotización las informa en `cuotas`. Si no las trae, rige
 * 1, el valor por defecto del servidor (D8). No se promete «sin interés»:
 * eso depende de lo que Mercado Pago muestre en el pago.
 */
function textoCuotas(cuotas) {
  return cuotas > 1
    ? `en 1 cuota o en hasta ${cuotas} cuotas (Mercado Pago te muestra el valor de cada cuota, y si tiene interés, antes de pagar)`
    : "en 1 cuota";
}

/**
 * Los textos que van antes del botón (brief § 7.0 y A.4; requisitos legales
 * «antes de pagar»: resumen, costo total por período, medios de pago,
 * confirmación y aceptación expresa). «Para qué cuenta» lleva el correo
 * completo: la máscara (d***@gmail.com) puede calzar con varias cuentas, y el
 * correo ya se ve entero en la misma página.
 */
export function textosCompra({ plan, cotizacion = null, correo = "", mensualModo = "suscripcion", hoy = hoyChile() }) {
  const suscripcion = esSuscripcion(plan, mensualModo);
  const monto = cotizacion !== null ? cotizacion.monto : PRECIOS[plan];
  const precio = pesos(monto);
  const p = cotizacion !== null ? periodoCotizado(cotizacion, hoy) : null;
  const cuotas = cotizacion !== null && cotizacion.cuotas !== null && cotizacion.cuotas !== undefined ? cotizacion.cuotas : 1;

  let queCompras;
  let vigencia;
  let activacion;
  let total;
  let boton;
  if (plan === "anual") {
    queCompras = "Licencia de Arkhé para 1 profesional por 12 meses, en todos tus aparatos.";
    vigencia = p
      ? `Del ${p.desde} al ${p.hasta} (12 meses). ${p.porque}`
      : "12 meses, que empiezan cuando termina tu prueba o tu licencia vigente.";
    activacion = "Sola, apenas Mercado Pago aprueba el pago: normalmente en minutos.";
    total = `${precio}, IVA incluido · Pago único: no se renueva solo.`;
    boton = `Pagar ${precio}`;
  } else if (suscripcion) {
    queCompras = "Licencia de Arkhé para 1 profesional, mes a mes: cada cobro suma 1 mes. Vale en todos tus aparatos.";
    vigencia = p
      ? `Con el primer cobro, del ${p.desde} al ${p.hasta} (1 mes). Cada cobro siguiente suma 1 mes más. ${p.porque}`
      : "Cada cobro suma 1 mes, que empieza cuando termina tu prueba o tu licencia vigente.";
    activacion = "Sola, con el primer cobro, que puede tardar hasta una hora después de suscribirte.";
    total = `${precio} cada mes, IVA incluido · Se cobra solo cada mes hasta que lo canceles.`;
    boton = `Suscribirme por ${precio} al mes`;
  } else {
    queCompras = "Licencia de Arkhé para 1 profesional por 1 mes, en todos tus aparatos.";
    vigencia = p
      ? `Del ${p.desde} al ${p.hasta} (1 mes). ${p.porque}`
      : "1 mes, que empieza cuando termina tu prueba o tu licencia vigente.";
    activacion = "Sola, apenas Mercado Pago aprueba el pago: normalmente en minutos.";
    total = `${precio}, IVA incluido · Pago único por 1 mes: no se renueva solo.`;
    boton = `Pagar ${precio}`;
  }

  // El mensual de pago único va por la misma preferencia que el anual, pero siempre en 1 cuota (crearPago.ts).
  const medios = suscripcion
    ? "Te suscribes en Mercado Pago, que cobra cada mes a tu tarjeta de crédito o débito, o a tu saldo si tienes cuenta de Mercado Pago. No necesitas cuenta de Mercado Pago. No se puede pagar por transferencia. Mercado Pago procesa el pago: Arkhé no ve ni guarda los datos de tu tarjeta."
    : `Pagas en Mercado Pago, ${textoCuotas(plan === "anual" ? cuotas : 1)}: con tarjeta de crédito, débito o prepago, o por transferencia si Mercado Pago te la ofrece, sin crear cuenta. Si tienes cuenta de Mercado Pago, también con tu saldo. Mercado Pago procesa el pago: Arkhé no ve ni guarda los datos de tu tarjeta.`;

  return {
    suscripcion,
    queCompras,
    cuenta: correo ? `${correo}, la cuenta de Google con que entraste.` : "La cuenta de Google con que entraste.",
    vigencia,
    activacion,
    total,
    medios,
    confirmacion: `Te enviaremos la confirmación y una copia íntegra de las condiciones a ${correo || "el correo de tu cuenta"}.`,
    // La aceptación del cobro automático va escrita en la casilla (requisito legal: acto propio e inequívoco).
    cargoAutomatico: suscripcion ? ` y que se cobren ${precio} cada mes hasta que cancele` : "",
    boton,
    precio,
  };
}

/**
 * Lo que dice la tarjeta del plan anual: el precio de la cotización y su
 * equivalente mensual. «Pagas diez meses y usas doce» solo si los precios lo
 * cumplen (es lo que promete la portada, y lo que se promete obliga).
 */
export function textoEquivalenteAnual(montoAnual, montoMensual) {
  const alMes = pesos(Math.round(montoAnual / 12));
  return montoAnual === montoMensual * 10
    ? `Equivale a ${alMes} al mes: pagas diez meses y usas doce.`
    : `Equivale a ${alMes} al mes.`;
}

/**
 * ¿La cuenta ya está pagada y le quedan más de 30 días? Entonces pagar no
 * urge y el botón no se destaca (brief § 7.1, casos especiales). Una prueba
 * no cuenta como pagada.
 */
export function cuentaYaActiva(cotizacion, hoy) {
  if (cotizacion === null || cotizacion.venceActual === null) return false;
  if (cotizacion.nivelActual === null || cotizacion.nivelActual === "prueba") return false;
  return cotizacion.venceActual > sumarDias(hoy, 30);
}

export function textoYaActiva(cotizacion) {
  const hasta = fechaLarga(cotizacion.venceActual);
  const siPagas = fechaLarga(cotizacion.venceSiPagas);
  return siPagas
    ? `Tu cuenta ya está activa hasta el ${hasta}. Si pagas, se extiende hasta el ${siPagas}.`
    : `Tu cuenta ya está activa hasta el ${hasta}.`;
}

/**
 * La tarjeta «Tu suscripción mensual» (requisito legal: la fecha del próximo
 * cobro se ve en /pagar/). Una pausada no se presenta como activa: según
 * mediciones de terceros en producción, Mercado Pago pausa la suscripción
 * cuando se agotan los reintentos de un cobro rechazado, y una pausada no
 * admite más cambio que cancelarla o reactivarla. crear-pago no deja crear
 * otra mientras exista (2bis), así que la tarjeta dice cómo seguir.
 */
export function textoSuscripcion(suscripcion, venceActual) {
  const hasta = fechaLarga(venceActual);
  const proximo = fechaLarga(suscripcion.proximoCobro);
  const lineas = [];
  if (suscripcion.estado === "pausada") {
    lineas.push("Está en pausa: Mercado Pago dejó de cobrarla, así que no hay cobros y tu licencia no se extiende.");
    if (hasta) lineas.push(`Tu licencia queda hasta el ${hasta}.`);
    lineas.push("Para seguir con el plan mensual, cancélala aquí y suscríbete de nuevo, o paga el plan anual. Si tienes dudas, escríbenos.");
    return lineas;
  }
  lineas.push(proximo ? `Está activa. Próximo cobro: ${proximo}.` : "Está activa: Mercado Pago cobra cada mes.");
  if (hasta) lineas.push(`Tu licencia queda hasta el ${hasta}.`);
  if (proximo) lineas.push("Para que no se haga el próximo cobro, cancélala antes de esa fecha. Cancelar no tiene costo.");
  return lineas;
}

/**
 * El aviso de la tarjeta cuando crear-pago no pudo releer la suscripción en
 * Mercado Pago (`confirmada: false`: MP falló, no la deja ver o alguien la
 * acababa de consultar). La tarjeta sigue mostrando lo que dice la base y su
 * botón «Cancelar»: esconderlo justo cuando no sabemos si sigue cobrando
 * dejaría a la persona sin la forma más directa de pararla (A.3). null si MP
 * la confirmó o la respuesta no dice nada.
 */
export function avisoSuscripcionSinConfirmar(suscripcion) {
  return esObjeto(suscripcion) && suscripcion.confirmada === false ? MENSAJES.suscripcionSinConfirmar : null;
}

/** Con el mensual elegido y una suscripción viva: no hay nada que comprar (una por cuenta, A.2). */
export function textoYaSuscrita(estado) {
  return estado === "pausada"
    ? "Tu suscripción mensual está en pausa y, mientras exista, no se puede crear otra. Para seguir con el plan mensual, cancélala arriba, en «Tu suscripción mensual», y suscríbete de nuevo; también puedes elegir el plan anual o escribirnos."
    : "Ya tienes una suscripción mensual activa: no hace falta suscribirte de nuevo. La ves arriba, en «Tu suscripción mensual».";
}

/**
 * Con el anual elegido y una suscripción viva: pagar el anual no la cancela.
 * Una pausada tampoco cobra hoy, pero vuelve a cobrar si se reanuda. null si
 * no hay nada que advertir.
 */
export function textoAvisoAnualSuscrita(estado) {
  if (estado === "activa") {
    return "Tienes una suscripción mensual activa. Si pagas el anual, los 12 meses se suman a tu licencia, pero la suscripción no se cancela sola y sigue cobrando: puedes cancelarla arriba, en «Tu suscripción mensual».";
  }
  if (estado === "pausada") {
    return "Tienes una suscripción mensual en pausa. Si pagas el anual, los 12 meses se suman a tu licencia, pero la suscripción no se cancela sola: si se reanuda, vuelve a cobrar. Puedes cancelarla arriba, en «Tu suscripción mensual».";
  }
  return null;
}

/** La confirmación antes de cancelar (en la misma página, sin window.confirm). */
export function textoConfirmarCancelacion(venceActual) {
  const hasta = fechaLarga(venceActual);
  return hasta
    ? `No habrá más cobros. Tu licencia sigue activa hasta el ${hasta} y después Arkhé pasa a modo lectura, sin borrar nada. Cancelar no tiene costo.`
    : "No habrá más cobros. Tu licencia sigue activa hasta su fecha de término y después Arkhé pasa a modo lectura, sin borrar nada. Cancelar no tiene costo.";
}

export function textoCancelada(vence) {
  const hasta = fechaLarga(vence);
  return [
    "Listo: cancelamos tu suscripción mensual. No habrá más cobros.",
    hasta
      ? `Tu licencia sigue activa hasta el ${hasta}; después, Arkhé pasa a modo lectura, sin borrar nada.`
      : "Tu licencia sigue activa hasta su fecha de término; después, Arkhé pasa a modo lectura, sin borrar nada.",
    "Te confirmaremos la cancelación al correo de tu cuenta.",
  ];
}

export function textoPendiente(desde) {
  const fecha = fechaLarga(desde);
  return fecha
    ? `Tienes un pago pendiente (por ejemplo, una transferencia) desde el ${fecha}. Tu cuenta se activa sola apenas se acredite.`
    : "Tienes un pago pendiente (por ejemplo, una transferencia). Tu cuenta se activa sola apenas se acredite.";
}

// ————— Textos de /pago/ —————

/** Estados en que /pago/ deja de consultar: ya no van a cambiar solos en minutos. */
const FINALES = new Set(["aprobado", "rechazado", "anulado", "revertido", "revision", "cancelada"]);

export function esEstadoFinal(estado) {
  return FINALES.has(estado);
}

/**
 * El estado que muestra /pago/. Una suscripción que quedó cancelada sin
 * ningún cobro (la persona la canceló, o MP la dio de baja) no se queda
 * «esperando» ni se lee como un pago anulado: consultar-pago responde
 * `anulado` con `suscripcion.estado: "cancelada"` (estadoDeSuscripcion, en
 * consultarPago.ts). `pendiente` no entra: con un pago en curso sí puede
 * haber un cobro, y decir «no se cobró nada» sería falso.
 */
export function estadoDePago(respuesta) {
  const s = respuesta.suscripcion;
  if (s !== null && s.estado === "cancelada" && ["esperando", "anulado", "suscrita"].includes(respuesta.estado)) {
    return "cancelada";
  }
  return respuesta.estado;
}

/**
 * Cuánto esperar antes de la próxima consulta, o null para dejar de
 * consultar (SONDEO). `transcurridoMs` se cuenta desde que se abrió la página.
 * `restanteSesionMs` es lo que le queda a la sesión de /pagar/, que no se
 * renueva (brief § 7.1): una consulta que saldría con la sesión vencida solo
 * traería un 401, así que ahí también se deja de consultar.
 */
export function siguienteConsulta(estado, transcurridoMs, restanteSesionMs = Infinity) {
  if (esEstadoFinal(estado)) return null;
  const lento = estado === "suscrita";
  const espera = lento
    ? transcurridoMs < SONDEO.lentoHastaMs ? SONDEO.lentoMs : null
    : transcurridoMs < SONDEO.rapidoHastaMs ? SONDEO.rapidoMs : null;
  if (espera !== null && restanteSesionMs - MARGEN_SESION_MS <= espera) return null;
  return espera;
}

/** Lo que /pago/ agrega cuando la sesión de /pagar/ ya no sirve para consultar. */
export const NOTA_SESION_VENCIDA = "Tu sesión en esta página venció. Para ver el estado de tu licencia, entra de nuevo en arkheapp.cl/pagar/.";

/**
 * El texto de /pago/ con sesión, por estado (brief § 7.2; 2bis). `sin_confirmar`
 * es «esperando» cuando ya pasaron los 2 min de sondeo. `suscripcion` dice si
 * el cobro es una suscripción, y `suscripcionEstado`, cómo está (activa,
 * pausada, cancelada…), según consultar-pago.
 * Devuelve { titulo, texto, detalle, tono, volverAPagar, textoPagar, contacto, consultarDeNuevo };
 * `textoPagar` es el del enlace a /pagar/.
 */
export function textoPago(estado, { correo = "", vence = null, suscripcion = false, suscripcionEstado = null } = {}) {
  const base = { detalle: null, tono: "espera", volverAPagar: false, textoPagar: "Volver a intentarlo", contacto: false, consultarDeNuevo: false };
  switch (estado) {
    case "aprobado": {
      const hasta = fechaLarga(vence);
      const cuenta = enmascararCorreo(correo);
      return {
        ...base,
        tono: "ok",
        titulo: "Listo: tu licencia quedó activa",
        texto: hasta ? `Listo: tu cuenta ${cuenta} quedó activa hasta el ${hasta}.` : `Listo: tu cuenta ${cuenta} quedó activa.`,
        detalle: "Abre Arkhé y entra con esa misma cuenta de Google en Configuración → Cuenta. Si Arkhé estaba abierta, ciérrala y vuelve a abrirla.",
      };
    }
    case "suscrita":
      // No se promete que la página se actualice sola: la sesión de /pagar/ dura cerca de una
      // hora y no se renueva, así que suele vencer antes de que llegue el primer cobro.
      return {
        ...base,
        tono: "ok",
        titulo: "Tu suscripción quedó creada",
        texto: "Tu suscripción quedó creada. El primer cobro puede tardar hasta una hora y tu cuenta se activa sola.",
        detalle:
          "Puedes cerrar esta página. Para ver si ya se activó, abre Arkhé (si estaba abierta, ciérrala y vuelve a abrirla) o entra en arkheapp.cl/pagar/.",
      };
    case "pendiente":
      return {
        ...base,
        titulo: "Tu pago quedó pendiente",
        texto: "Tu pago quedó pendiente (por ejemplo, una transferencia). Tu cuenta se activa sola apenas se acredite; puedes cerrar esta página.",
      };
    case "rechazado":
      // Una suscripción que sigue viva no se puede «volver a intentar» en /pagar/: crear-pago la
      // relee, la ve activa y no crea otra. Mercado Pago reintenta el mismo cobro por su cuenta.
      if (suscripcion && suscripcionEstado === "activa") {
        return {
          ...base,
          tono: "aviso",
          titulo: "El cobro de tu suscripción no se completó",
          texto: "Mercado Pago no pudo hacer el cobro de tu suscripción. Lo volverá a intentar en los próximos días con el mismo medio de pago, y tu cuenta se activa sola cuando el cobro pase.",
          detalle:
            "Para pagar con otro medio de pago o con otro correo de Mercado Pago, cancela esta suscripción en arkheapp.cl/pagar/ y suscríbete de nuevo. Si tienes dudas, escríbenos.",
          volverAPagar: true,
          textoPagar: "Ver mi suscripción",
          contacto: true,
        };
      }
      if (suscripcion && suscripcionEstado === "pausada") {
        return {
          ...base,
          tono: "error",
          titulo: "Mercado Pago dejó de cobrar tu suscripción",
          texto: "El cobro de tu suscripción no se completó y Mercado Pago la dejó en pausa: no habrá cobros y tu licencia no se extiende.",
          detalle:
            "Para seguir con el plan mensual, cancela la suscripción en arkheapp.cl/pagar/ y suscríbete de nuevo, o paga el plan anual. Si tienes dudas, escríbenos.",
          volverAPagar: true,
          textoPagar: "Ver mi suscripción",
          contacto: true,
        };
      }
      return {
        ...base,
        tono: "error",
        titulo: "El pago no se completó",
        texto: "El pago no se completó.",
        detalle: suscripcion
          ? "Revisa que el correo de Mercado Pago sea el mismo con que pagas: si no coincide, Mercado Pago rechaza el pago. Puedes intentarlo de nuevo."
          : "Puedes intentarlo de nuevo con otro medio de pago.",
        volverAPagar: true,
      };
    case "anulado":
      return {
        ...base,
        tono: "error",
        titulo: "El pago quedó anulado",
        texto: "El pago quedó anulado y no se completó. Si quieres, vuelve a intentarlo.",
        volverAPagar: true,
      };
    case "cancelada":
      // Un primer cobro rechazado hace que Mercado Pago cancele la suscripción (matriz de
      // terceros, PA-6), y la causa típica es un correo de MP que no calza: sin este
      // consejo, la persona se suscribe de nuevo con el mismo correo y vuelve a fallar.
      return {
        ...base,
        tono: "error",
        titulo: "La suscripción se canceló",
        texto: "La suscripción se canceló antes del primer cobro, así que no se cobró nada. Si quieres, suscríbete de nuevo.",
        detalle:
          "Si no la cancelaste tú, puede que Mercado Pago haya rechazado el primer cobro. Al suscribirte de nuevo, revisa que el correo de Mercado Pago sea el mismo con que pagas: si no coincide, Mercado Pago rechaza el cobro.",
        volverAPagar: true,
        textoPagar: "Suscribirme de nuevo",
      };
    case "revertido":
      return {
        ...base,
        tono: "error",
        titulo: "Este pago se devolvió",
        texto: "Este pago se devolvió o se desconoció, así que tu licencia volvió a como estaba. Si no lo esperabas, escríbenos.",
        contacto: true,
      };
    case "revision":
      return {
        ...base,
        tono: "aviso",
        titulo: "Tu pago necesita una revisión",
        texto: "Recibimos tu pago, pero necesita una revisión. Te escribiremos al correo de tu cuenta.",
        contacto: true,
      };
    case "sin_confirmar":
      // Tono neutro: que MP tarde no quiere decir que el pago falló. En una suscripción,
      // «esperando» es que todavía no está autorizada: puede faltar ese paso, o el correo no calzó.
      return {
        ...base,
        titulo: "Todavía no tenemos la confirmación",
        texto: "Mercado Pago todavía no nos confirma el pago. Si pagaste, tu cuenta se activa sola apenas se acredite: puedes cerrar esta página.",
        detalle: suscripcion
          ? "Si no alcanzaste a autorizar la suscripción en Mercado Pago, puedes volver a intentarlo en arkheapp.cl/pagar/. Revisa que el correo de Mercado Pago sea el mismo con que pagas: si no coincide, Mercado Pago rechaza el cobro."
          : null,
        consultarDeNuevo: true,
      };
    default:
      return {
        ...base,
        titulo: "Estamos confirmando tu pago",
        texto: "Estamos esperando la confirmación de Mercado Pago. Suele tardar unos segundos.",
        detalle: "Tu licencia se activa sola cuando Mercado Pago confirma el pago, aunque cierres esta página.",
      };
  }
}

/** Los `status` de la vuelta de Checkout Pro que dicen que el pago no se hizo. */
const FRACASOS_CHECKOUT = new Set(["rejected", "cancelled", "failure"]);

/**
 * /pago/ sin sesión de /pagar/: la persona volvió en otra pestaña (por
 * ejemplo, desde la app de Mercado Pago en el teléfono), la sesión venció o
 * el pago empezó en la app 0.17.0. Solo se puede leer lo que MP puso en la
 * URL (brief § 7.2, paso 3), y nada de eso confirma el pago: lo único que
 * activa una licencia es procesar_pago, en el servidor.
 *
 * El `status` solo cuenta en una vuelta de Checkout Pro (sin preapproval_id)
 * y con los valores que MP documenta para ella. De la vuelta de una
 * suscripción MP no documenta nada (2bis), y ahí `pending` quiere decir «sin
 * autorizar», no «pago pendiente». Cualquier otro caso recibe el texto
 * neutro, que no da nada por fallado. Los textos sirven también para quien
 * pagó en /pagar/: la 0.16.4 no tiene botón de pago, y solo relee la cuenta al
 * abrirse.
 */
export function textoSinSesion(vuelta, { sesionVencida = false } = {}) {
  const status = vuelta === null || vuelta.preapprovalId ? null : vuelta.status;
  const base = {
    detalle: sesionVencida ? NOTA_SESION_VENCIDA : null,
    volverAPagar: sesionVencida,
    textoPagar: "Entrar de nuevo",
    contacto: false,
  };
  if (status === "approved") {
    return {
      ...base,
      titulo: "Pago recibido",
      texto: "Pago recibido. Tu licencia se activa sola: abre Arkhé y, si estaba abierta, ciérrala y vuelve a abrirla.",
      tono: "ok",
    };
  }
  if (status === "pending" || status === "in_process") {
    return { ...base, titulo: "Tu pago quedó pendiente", texto: "Tu pago quedó pendiente. Arkhé se activa sola apenas se acredite.", tono: "espera" };
  }
  if (status !== null && FRACASOS_CHECKOUT.has(status)) {
    return {
      ...base,
      titulo: "El pago no se completó",
      texto: "El pago no se completó. Puedes intentarlo de nuevo en arkheapp.cl/pagar/.",
      tono: "error",
      volverAPagar: true,
      textoPagar: "Volver a intentarlo",
      contacto: true,
    };
  }
  return {
    ...base,
    titulo: "Volviste de Mercado Pago",
    texto: "Si completaste el pago o la suscripción en Mercado Pago, Arkhé se activa sola. En la suscripción mensual, el primer cobro puede tardar hasta una hora.",
    detalle: base.detalle ?? "Si Arkhé estaba abierta, ciérrala y vuelve a abrirla para ver tu licencia.",
    tono: "espera",
  };
}
