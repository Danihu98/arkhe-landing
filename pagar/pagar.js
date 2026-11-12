// El DOM de /pagar/ (ADR-0033, 2026-11-08; brief § 7.1, con A.3 y A.4;
// addendum § 2 y § 2bis).
//
// Las reglas y los textos están en logica.js; aquí solo se conectan con la
// página. Tres vistas, que se muestran y ocultan con `hidden`:
//   - cargando: mientras se entra con Google o llega la cotización;
//   - entrar: sin sesión, el plan, el aviso de privacidad y «Entrar con Google»;
//   - compra: con sesión, el plan, el resumen, el retracto, las condiciones y
//     el botón de pago; y la suscripción mensual con su «Cancelar».
//
// Reglas que valen para todo el archivo:
//   - Se escribe siempre con textContent: nada de lo que llega del servidor
//     o de la URL puede volverse HTML.
//   - Solo se navega a Google (por Supabase) o a una URL de pago de Mercado
//     Pago que pase urlDePagoValida.
//   - Mientras hay un pago o una cancelación en curso, `estado.ocupado` y el
//     botón deshabilitado impiden mandar dos veces.

import {
  CLAVES,
  MENSAJES,
  PRECIOS,
  URL_CANJE,
  URL_SALIR,
  aceptacionPrivacidad,
  avisoSuscripcionSinConfirmar,
  claveAceptacion,
  correoMpValido,
  cuentaYaActiva,
  cuerpoCanje,
  esSuscripcion,
  estadoPrivacidad,
  generarVerificador,
  hoyChile,
  leerPlanDeUrl,
  leerRespuestaCancelar,
  leerRespuestaCotizar,
  leerRespuestaCrearPago,
  leerVueltaGoogle,
  llamar,
  mensajeNoHabilitadoAlPagar,
  mensajeVueltaGoogle,
  normalizarCorreo,
  pesos,
  privacidadParaEnviar,
  retoS256,
  revisarAntesDeIr,
  sesionDesdeToken,
  sesionVigente,
  suscripcionMasReciente,
  textoAvisoAnualSuscrita,
  textoCancelada,
  textoConfirmarCancelacion,
  textoEquivalenteAnual,
  textoPendiente,
  textoRetractoHasta,
  textoSuscripcion,
  textoYaActiva,
  textoYaSuscrita,
  textosCompra,
  urlAutorizar,
  urlFuncion,
} from "./logica.js";

const el = (id) => document.getElementById(id);

/** El fetch del navegador, llamado suelto: algunos navegadores lanzan si se invoca como método de otro objeto. */
const fetchNavegador = (url, init) => fetch(url, init);

// ————— sessionStorage —————
// Puede estar bloqueado (modo privado de algunos navegadores, o datos del
// sitio desactivados): leer y escribir nunca lanza, y quien llama decide.

function leerDato(clave) {
  try {
    const t = sessionStorage.getItem(clave);
    return t === null ? null : JSON.parse(t);
  } catch {
    return null;
  }
}

function guardarDato(clave, valor) {
  try {
    sessionStorage.setItem(clave, JSON.stringify(valor));
    return true;
  } catch {
    return false;
  }
}

function borrarDato(clave) {
  try {
    sessionStorage.removeItem(clave);
  } catch {
    // nada que borrar
  }
}

// ————— Estado —————

const estado = {
  vista: "cargando", // cargando · entrar · compra
  sesion: null, // { token, vence, correo }
  plan: "anual",
  cotizaciones: { anual: null, mensual: null },
  mensualModo: "suscripcion",
  suscripcion: null, // { cobroId, estado: activa | pausada, proximoCobro, confirmada }
  cancelada: null, // { vence }: la suscripción que se canceló en esta página
  confirmando: false, // la confirmación de «Cancelar la suscripción» está abierta
  // Recién cancelada: solo se ve la tarjeta de cancelada, sin la compra ni otro retracto al lado,
  // hasta que la persona pida «Elegir un plan otra vez» (/condiciones/, punto 8).
  trasCancelar: false,
  pendiente: null, // { cobroId, desde }: crear-pago respondió «pendiente»
  sinCompra: null, // { mensaje, tono, contacto, reintentar, recargar, planes }: vitalicia, no habilitado o error al cotizar
  ocupado: false, // hay un pago, una entrada o una cancelación en curso
  turno: 0, // cada cotización por cambio de plan: así se descarta una respuesta que llega tarde
  correoEditado: false, // la persona escribió su correo de MP: no se pisa con el de la cuenta
  // El servidor no tiene la constancia del aviso de privacidad vigente (estadoPrivacidad: "pedir"):
  // la casilla del aviso aparece junto al pago.
  pedirPrivacidad: false,
};

// ————— Ayudantes del DOM —————

function mostrar(id, visible) {
  el(id).hidden = !visible;
}

/** Bloquea un botón mientras se procesa: deshabilitado, con aria-busy y un texto que dice qué pasa. */
function ocupar(boton, texto) {
  if (boton.dataset.texto === undefined) boton.dataset.texto = boton.textContent;
  boton.disabled = true;
  boton.setAttribute("aria-busy", "true");
  boton.textContent = texto;
}

function liberar(boton) {
  boton.disabled = false;
  boton.removeAttribute("aria-busy");
  if (boton.dataset.texto !== undefined) {
    boton.textContent = boton.dataset.texto;
    delete boton.dataset.texto;
  }
}

function avisar(texto) {
  const p = el("aviso");
  p.textContent = texto ?? "";
  p.hidden = !texto;
}

function mostrarError(id, texto) {
  const p = el(id);
  if (texto !== undefined) p.textContent = texto;
  p.hidden = false;
}

/** El estado del pago bajo el botón: «Te llevamos a Mercado Pago…» o un error, con los contactos si sirven. */
function estadoPago(texto, tono, contacto = false) {
  const p = el("pagar-estado");
  p.textContent = texto ?? "";
  p.className = `estado${tono === "error" ? " estado--error" : tono === "ok" ? " estado--ok" : ""}`;
  p.hidden = !texto;
  mostrar("pagar-contacto", Boolean(texto) && contacto);
}

// ————— La casilla de las condiciones —————

/** Lo que acepta la casilla ahora: el plan, el modo del mensual, el monto y la versión (claveAceptacion). */
function claveActual() {
  return claveAceptacion({ plan: estado.plan, mensualModo: estado.mensualModo, cotizacion: estado.cotizaciones[estado.plan] });
}

/** Desmarca la casilla: lo que se aceptó ya no es lo que se va a pagar. */
function desmarcarCondiciones() {
  const casilla = el("c-condiciones");
  casilla.checked = false;
  delete casilla.dataset.acepto;
  el("e-condiciones").hidden = true;
}

// ————— El aviso de privacidad (Ley 19.628, art. 4) —————
// Se acepta antes de entrar con Google (#c-privacidad) y queda en esta
// pestaña. crear-pago recibe la versión al cotizar y al pagar, y guarda la
// constancia con su hora. Si el servidor dice que no la tiene, la casilla
// vuelve a aparecer junto al pago (#c-privacidad-pago).

/** La versión del aviso que se manda a crear-pago: la aceptada en esta pestaña, o null. */
function privacidadAceptadaAqui() {
  if (estado.pedirPrivacidad && el("c-privacidad-pago").checked) return privacidadParaEnviar(aceptacionPrivacidad());
  return privacidadParaEnviar(leerDato(CLAVES.privacidad));
}

/** El servidor ya tiene la constancia (o se cerró la sesión): la casilla junto al pago se va. */
function olvidarPedirPrivacidad() {
  estado.pedirPrivacidad = false;
  el("c-privacidad-pago").checked = false;
  el("e-privacidad-pago").hidden = true;
}

/** Lleva el foco sin mover la página de golpe: para lectores de pantalla y teclado. */
function enfocar(id) {
  const n = el(id);
  if (n && !n.hidden) n.focus({ preventScroll: false });
}

// ————— Pintar —————

function venceActual() {
  return estado.cotizaciones.anual?.venceActual ?? estado.cotizaciones.mensual?.venceActual ?? null;
}

function pintarPlanes() {
  for (const radio of document.querySelectorAll('input[name="plan"]')) radio.checked = radio.value === estado.plan;
  const anual = estado.cotizaciones.anual?.monto ?? PRECIOS.anual;
  const mensual = estado.cotizaciones.mensual?.monto ?? PRECIOS.mensual;
  el("precio-anual").textContent = pesos(anual);
  el("precio-mensual").textContent = pesos(mensual);
  el("equivale-anual").textContent = textoEquivalenteAnual(anual, mensual);
  const unico = estado.mensualModo === "pago_unico";
  el("unidad-mensual").textContent = unico ? "por 1 mes" : "cada mes";
  for (const n of document.querySelectorAll("[data-mensual]")) {
    n.hidden = n.dataset.mensual !== (unico ? "pago_unico" : "suscripcion");
  }
  el("planes").disabled = estado.ocupado;
}

function pintarSuscripcion(visible) {
  const s = estado.suscripcion;
  const c = estado.cancelada;
  mostrar("suscripcion", visible && (s !== null || c !== null));
  if (!visible) return;
  mostrar("suscripcion-info", s !== null && !estado.confirmando);
  mostrar("confirmar", s !== null && estado.confirmando);
  mostrar("cancelada", s === null && c !== null);
  if (s !== null) {
    const lineas = textoSuscripcion(s, venceActual());
    ["suscripcion-1", "suscripcion-2", "suscripcion-3"].forEach((id, i) => {
      el(id).textContent = lineas[i] ?? "";
      mostrar(id, lineas[i] !== undefined);
    });
    el("confirmar-texto").textContent = textoConfirmarCancelacion(venceActual());
    // Sin confirmar en MP: se dice, y el botón «Cancelar» sigue a la vista (A.3).
    const aviso = avisoSuscripcionSinConfirmar(s);
    el("suscripcion-aviso").textContent = aviso ?? "";
    mostrar("suscripcion-aviso", aviso !== null);
  }
  if (s === null && c !== null) {
    const lineas = textoCancelada(c.vence);
    el("cancelada-1").textContent = lineas[0];
    el("cancelada-2").textContent = lineas[1];
    el("cancelada-3").textContent = lineas[2];
    // /condiciones/ (punto 8): si cancela dentro del plazo de retracto, aquí mismo se le pregunta.
    const retracto = textoRetractoHasta(c.retractoHasta, c.retractoSinConfirmacion ?? null);
    mostrar("pregunta-retracto", retracto !== null);
    el("retracto-hasta").textContent = retracto ?? "";
    mostrar("cancelada-acciones", estado.trasCancelar);
  }
}

function pintarCompra() {
  const sc = estado.sinCompra;
  // Mensual con una suscripción viva (activa o en pausa): no hay nada que comprar (una por cuenta, A.2), así que no hay resumen.
  const yaSuscrita = sc === null && esSuscripcion(estado.plan, estado.mensualModo) && estado.suscripcion !== null;
  mostrar("t-compra", sc === null && !yaSuscrita);
  mostrar("sin-compra", sc !== null);
  mostrar("ya-suscrita", yaSuscrita);
  if (yaSuscrita) el("ya-suscrita").textContent = textoYaSuscrita(estado.suscripcion.estado);
  mostrar("nota-fundador", sc === null);
  mostrar("nota-precio", sc === null);
  if (sc !== null || yaSuscrita) {
    mostrar("resumen-bloque", false);
    mostrar("cargando-plan", false);
  }
  if (yaSuscrita) return;
  if (sc !== null) {
    const p = el("sin-compra-texto");
    p.textContent = sc.mensaje;
    p.className = `estado${sc.tono === "error" ? " estado--error" : sc.tono === "ok" ? " estado--ok" : ""}`;
    mostrar("sin-compra-contacto", sc.contacto);
    mostrar("sin-compra-acciones", sc.reintentar);
    el("b-reintentar").textContent = sc.recargar ? "Recargar la página" : "Intentar de nuevo";
    return;
  }

  const plan = estado.plan;
  const cot = estado.cotizaciones[plan];
  // Sin la cotización de este plan no se muestra el resumen ni el botón: nadie paga sin ver hasta cuándo y cuánto.
  mostrar("cargando-plan", cot === null);
  mostrar("resumen-bloque", cot !== null);
  if (cot === null) return;

  const t = textosCompra({ plan, cotizacion: cot, correo: estado.sesion.correo, mensualModo: estado.mensualModo, hoy: hoyChile() });
  // Si lo que se aceptó (plan, cobro automático, monto o versión) ya no es lo que se muestra,
  // la casilla se desmarca: nunca queda marcada bajo una etiqueta que la persona no marcó.
  const casilla = el("c-condiciones");
  if (casilla.checked && casilla.dataset.acepto !== claveActual()) desmarcarCondiciones();
  el("r-que").textContent = t.queCompras;
  el("r-cuenta").textContent = t.cuenta;
  el("r-vigencia").textContent = t.vigencia;
  el("r-activacion").textContent = t.activacion;
  el("r-total").textContent = t.total;
  el("r-medios").textContent = t.medios;
  el("r-confirmacion").textContent = t.confirmacion;
  el("reglas-monto").textContent = t.precio;
  el("c-cargo").textContent = t.cargoAutomatico;
  for (const n of document.querySelectorAll("[data-retracto]")) {
    n.hidden = n.dataset.retracto !== (t.suscripcion ? "primer-cobro" : "pago");
  }
  mostrar("reglas-mensual", t.suscripcion);

  const pendiente = estado.pendiente !== null;
  mostrar("pendiente", pendiente);
  mostrar("pagar-bloque", !pendiente);
  mostrar("privacidad-pago", estado.pedirPrivacidad);
  if (pendiente) el("pendiente-texto").textContent = textoPendiente(estado.pendiente.desde);

  // Con más de 30 días pagados por delante, el botón sigue, pero sin destacar (brief § 7.1).
  const yaActiva = cuentaYaActiva(cot, hoyChile());
  mostrar("ya-activa", yaActiva);
  if (yaActiva) el("ya-activa").textContent = textoYaActiva(cot);
  const avisoAnual = plan === "anual" ? textoAvisoAnualSuscrita(estado.suscripcion?.estado ?? null) : null;
  mostrar("aviso-anual-suscrita", avisoAnual !== null);
  if (avisoAnual !== null) el("aviso-anual-suscrita").textContent = avisoAnual;

  const boton = el("b-pagar");
  boton.className = yaActiva ? "btn btn-linea" : "btn";
  if (boton.getAttribute("aria-busy") !== "true") boton.textContent = t.boton;
}

function pintar() {
  const v = estado.vista;
  const conSesion = v === "compra" && estado.sesion !== null;
  const confirmando = conSesion && estado.confirmando;
  const sinCompra = conSesion && estado.sinCompra !== null;
  const trasCancelar = conSesion && estado.trasCancelar;

  mostrar("cargando", v === "cargando");

  mostrar("cuenta", conSesion);
  if (conSesion) el("cuenta-correo").textContent = estado.sesion.correo || "tu cuenta de Google";

  pintarSuscripcion(conSesion);

  // Los planes: antes de entrar y con sesión, salvo que no haya nada que
  // comprar, que esté abierta la confirmación de cancelar (ahí, solo eso) o
  // que se acabe de cancelar: justo después, ningún botón de pago al lado.
  const verPlanes = v === "entrar" || (conSesion && (!sinCompra || estado.sinCompra.planes) && !confirmando && !trasCancelar);
  mostrar("t-planes", verPlanes);
  mostrar("planes", verPlanes);
  pintarPlanes();

  mostrar("entrar", v === "entrar");

  const verCorreo =
    conSesion &&
    !sinCompra &&
    !confirmando &&
    !trasCancelar &&
    esSuscripcion(estado.plan, estado.mensualModo) &&
    estado.cotizaciones.mensual !== null &&
    estado.suscripcion === null &&
    estado.pendiente === null;
  mostrar("correo-mp", verCorreo);
  if (verCorreo && !estado.correoEditado && el("i-correo-mp").value === "") {
    // Precargado con el correo de la cuenta de Arkhé, y editable (A.2).
    el("i-correo-mp").value = estado.sesion.correo;
  }
  el("i-correo-mp").readOnly = estado.ocupado;

  mostrar("compra", conSesion && !confirmando && !trasCancelar);
  if (conSesion && !confirmando && !trasCancelar) pintarCompra();

  // Con sesión y sin una suscripción viva: quien vino a cancelar sabe por qué no ve
  // el botón (otra cuenta de Google, o ya no está activa) y qué hacer (R7).
  const cotizado = estado.cotizaciones.anual !== null || estado.cotizaciones.mensual !== null || sinCompra;
  mostrar(
    "sin-suscripcion",
    conSesion && cotizado && !confirmando && !trasCancelar && estado.suscripcion === null && estado.cancelada === null && estado.mensualModo === "suscripcion",
  );
}

// ————— Sesión —————

function cerrarSesionLocal() {
  borrarDato(CLAVES.sesion);
  borrarDato(CLAVES.cobro);
  estado.sesion = null;
  estado.cotizaciones = { anual: null, mensual: null };
  estado.suscripcion = null;
  estado.cancelada = null;
  estado.confirmando = false;
  estado.trasCancelar = false;
  estado.pendiente = null;
  estado.sinCompra = null;
  estado.ocupado = false;
  estado.correoEditado = false;
  el("i-correo-mp").value = "";
  desmarcarCondiciones();
  olvidarPedirPrivacidad();
}

function mostrarEntrar(mensaje) {
  estado.vista = "entrar";
  avisar(mensaje);
  pintar();
}

/** «Entrar con Google para pagar»: PKCE S256, como la app (pkce.ts y gotrue.ts). */
async function entrar() {
  if (estado.ocupado) return;
  if (!el("c-privacidad").checked) {
    mostrarError("e-privacidad");
    el("c-privacidad").focus();
    return;
  }
  estado.ocupado = true;
  const boton = el("b-entrar");
  ocupar(boton, "Abriendo Google…");
  try {
    const verificador = generarVerificador();
    const reto = await retoS256(verificador);
    // El verificador se queda en esta pestaña: sin él, el código que vuelve de Google no sirve.
    if (!guardarDato(CLAVES.pkce, { verificador, plan: estado.plan, creado: Date.now() })) throw new Error("sessionStorage");
    // Qué versión del aviso se aceptó: va a crear-pago, que guarda la constancia en el servidor.
    guardarDato(CLAVES.privacidad, aceptacionPrivacidad());
    location.assign(urlAutorizar({ reto, elegirCuenta: leerDato(CLAVES.elegirCuenta) === true }));
  } catch {
    estado.ocupado = false;
    liberar(boton);
    avisar("Este navegador no deja guardar lo necesario para entrar. Prueba con otro navegador o escríbenos.");
    enfocar("aviso");
  }
}

/** Vuelta de Google con `?code=`: se canjea por la sesión (brief § 7.1, estado 2). */
async function entrarConCodigo(codigo) {
  estado.vista = "cargando";
  el("cargando").textContent = "Entrando con Google…";
  pintar();
  const pkce = leerDato(CLAVES.pkce);
  borrarDato(CLAVES.pkce); // un verificador sirve una sola vez
  if (pkce === null || typeof pkce.verificador !== "string") {
    mostrarEntrar("La entrada con Google empezó en otra pestaña o venció. Vuelve a intentarlo desde aquí.");
    return;
  }
  if (pkce.plan === "anual" || pkce.plan === "mensual") estado.plan = pkce.plan;
  const r = await llamar({ fetch: fetchNavegador, url: URL_CANJE, cuerpo: cuerpoCanje(codigo, pkce.verificador) });
  const sesion = r.status === 200 ? sesionDesdeToken(r.json, Date.now()) : null;
  if (sesion === null) {
    mostrarEntrar(r.status === 0 ? "Sin conexión: revisa tu internet." : "No se pudo entrar con Google. Inténtalo de nuevo; si sigue fallando, escríbenos.");
    return;
  }
  // Solo el access token, su vencimiento y el correo: nunca el refresh token.
  guardarDato(CLAVES.sesion, sesion);
  borrarDato(CLAVES.elegirCuenta);
  estado.sesion = sesion;
  await cargarCompra();
}

/** «¿No es tu cuenta? Cambiar»: borra la sesión de esta pestaña y vuelve a «Entrar con Google». */
function cambiarCuenta() {
  if (estado.ocupado) return;
  const token = estado.sesion?.token ?? null;
  cerrarSesionLocal();
  // La próxima vez Google muestra su selector de cuentas; si no, entra sola con la misma.
  guardarDato(CLAVES.elegirCuenta, true);
  // La otra cuenta acepta el aviso por sí misma, antes de entrar.
  borrarDato(CLAVES.privacidad);
  el("c-privacidad").checked = false;
  // Se cierra también en el servidor la sesión que abrió esta página. Si falla, vence sola.
  if (token !== null) void llamar({ fetch: fetchNavegador, url: URL_SALIR, token });
  mostrarEntrar(null);
  enfocar("t-planes");
}

// ————— Cotización —————

/** crear-pago con `cotizar: true` para un plan; guarda lo que trae y devuelve el resultado. */
async function cotizar(plan) {
  const cuerpo = { plan, plataforma: "pagina", cotizar: true };
  // La versión del aviso de privacidad que se aceptó en esta pestaña. Si es la
  // vigente, crear-pago guarda la constancia (versión, primera y última vez) con
  // la hora del servidor, y responde privacidad_aceptada.
  const privacidad = privacidadAceptadaAqui();
  if (privacidad !== null) cuerpo.privacidad = privacidad;
  const r = await llamar({ fetch: fetchNavegador, url: urlFuncion("crear-pago"), cuerpo, token: estado.sesion.token });
  const res = leerRespuestaCotizar(r.status, r.json, { privacidadMandada: privacidad !== null });
  // La suscripción viene en cada cotización (y en las respuestas que no dejan
  // comprar, si la traen) y la más reciente manda; si una respuesta no trae el
  // campo, no dice nada y se conserva lo que se sabía. Así el botón «Cancelar»
  // no depende de poder comprar (A.3).
  const suscripcion = res.tipo === "cotizacion" ? res.cotizacion.suscripcion : res.suscripcion;
  if (suscripcion !== undefined) {
    // Una confirmada en MP hace un momento no se reemplaza por la misma sin confirmar (CT3-01).
    estado.suscripcion = suscripcionMasReciente(estado.suscripcion, suscripcion);
    if (suscripcion !== null) {
      estado.cancelada = null;
      estado.trasCancelar = false;
    }
  }
  if (res.tipo === "cotizacion") {
    estado.cotizaciones[plan] = res.cotizacion;
    estado.mensualModo = res.cotizacion.mensualModo;
    // Sin la constancia en el servidor (y sin habérsela mandado), la casilla del aviso
    // aparece junto al pago; con ella, se va. Si la respuesta no dice nada, queda como estaba.
    const aceptada = res.cotizacion.privacidadAceptada;
    if (estadoPrivacidad({ aceptada, mandada: privacidad !== null }) === "pedir") estado.pedirPrivacidad = true;
    else if (aceptada === true) olvidarPedirPrivacidad();
  }
  return res;
}

/**
 * Lo que no deja comprar: vitalicia (409), no habilitado (503), una página
 * desactualizada (las condiciones del servidor son otras) u otro error al
 * cotizar. `planes` deja a la vista los planes: un plan no disponible no
 * cierra el otro. `recargar`: el botón recarga la página en vez de cotizar de nuevo.
 */
function sinCompraPor(res) {
  if (res.codigo === "vitalicia") return { mensaje: res.mensaje, tono: "ok", contacto: false, reintentar: false, recargar: false, planes: false };
  if (res.codigo === "no_habilitado") return { mensaje: res.mensaje, tono: "aviso", contacto: true, reintentar: false, recargar: false, planes: false };
  if (res.codigo === "plan_no_disponible") return { mensaje: res.mensaje, tono: "aviso", contacto: true, reintentar: false, recargar: false, planes: true };
  if (res.codigo === "pagina_desactualizada") return { mensaje: res.mensaje, tono: "error", contacto: false, reintentar: true, recargar: true, planes: false };
  // Lo demás (sin red, Auth que no respondió, un error nuestro…) se puede reintentar; si el texto pide escribirnos, van los contactos.
  return { mensaje: res.mensaje, tono: "error", contacto: res.contacto === true, reintentar: true, recargar: false, planes: false };
}

/** Estado 3 del brief: con sesión, cotizar y mostrar el resumen. */
async function cargarCompra() {
  estado.vista = "cargando";
  estado.sinCompra = null;
  el("cargando").textContent = "Cargando tu cuenta…";
  avisar(null);
  pintar();
  // El anual primero: es el plan que se ofrece primero, y su respuesta ya trae
  // el modo del mensual y la suscripción activa, si hay. Si el anual no está
  // disponible, igual se cotiza el mensual: trae la suscripción (con su
  // «Cancelar») y, si la persona eligió el mensual, es su cotización.
  const anual = await cotizar("anual");
  let res = anual;
  const anualNoDisponible = anual.tipo === "error" && anual.codigo === "plan_no_disponible";
  if (estado.plan === "mensual" && (anual.tipo === "cotizacion" || anualNoDisponible)) res = await cotizar("mensual");
  else if (anualNoDisponible) await cotizar("mensual");
  if (res.tipo !== "cotizacion") {
    if (res.volverAEntrar) {
      cerrarSesionLocal();
      mostrarEntrar(res.mensaje);
      return;
    }
    estado.sinCompra = sinCompraPor(res);
  }
  estado.vista = "compra";
  pintar();
}

async function cambiarPlan(plan) {
  if (plan === estado.plan || estado.ocupado) return;
  estado.plan = plan;
  guardarDato(CLAVES.plan, plan);
  estado.pendiente = null; // el pago pendiente era del cobro del otro plan
  if (estado.sinCompra?.planes) estado.sinCompra = null; // «ese plan no está disponible» era del otro plan
  // Lo aceptado era el otro plan: en el mensual, la etiqueta suma el cobro
  // automático, y eso solo lo acepta la persona marcando de nuevo.
  desmarcarCondiciones();
  el("e-correo-mp").hidden = true;
  estadoPago(null);
  if (estado.vista !== "compra" || estado.cotizaciones[plan] !== null) {
    pintar();
    return;
  }
  const turno = ++estado.turno;
  pintar(); // «Cargando el precio…»
  const res = await cotizar(plan);
  if (turno !== estado.turno || estado.vista !== "compra") return; // la persona ya eligió otra cosa
  if (res.tipo !== "cotizacion") {
    if (res.volverAEntrar) {
      cerrarSesionLocal();
      mostrarEntrar(res.mensaje);
      return;
    }
    estado.sinCompra = sinCompraPor(res);
  }
  pintar();
}

// ————— Pagar —————

/** Estado 4 del brief: crear-pago y, si responde con una URL de MP, ir a pagar en esta misma pestaña. */
async function pagar(nuevo) {
  if (estado.ocupado || estado.vista !== "compra" || estado.sesion === null) return;
  const plan = estado.plan;
  if (estado.cotizaciones[plan] === null) return;
  const suscripcion = esSuscripcion(plan, estado.mensualModo);

  let correoMp = null;
  let primero = null;
  if (suscripcion) {
    const escrito = el("i-correo-mp").value;
    if (correoMpValido(escrito)) {
      correoMp = normalizarCorreo(escrito);
      el("e-correo-mp").hidden = true;
    } else {
      mostrarError(
        "e-correo-mp",
        escrito.trim() === ""
          ? "Escribe el correo con que pagarás en Mercado Pago."
          : "Revisa el correo: no parece un correo válido. Por ejemplo, nombre@gmail.com.",
      );
      primero = el("i-correo-mp");
    }
  }
  // Si el servidor no tiene la constancia del aviso de privacidad, la casilla
  // está junto al pago y sin ella no se paga (crear-pago respondería 409).
  if (estado.pedirPrivacidad && !el("c-privacidad-pago").checked) {
    mostrarError("e-privacidad-pago", MENSAJES.faltaPrivacidad);
    primero ??= el("c-privacidad-pago");
  }
  // La aceptación es un acto propio: la casilla viene sin marcar y sin ella no
  // se paga. Tiene que haberse marcado para esto mismo (plan, monto y versión).
  const casilla = el("c-condiciones");
  if (casilla.checked && casilla.dataset.acepto !== claveActual()) desmarcarCondiciones();
  if (!casilla.checked) {
    mostrarError("e-condiciones");
    primero ??= casilla;
  }
  if (primero !== null) {
    primero.focus();
    return;
  }

  estado.ocupado = true;
  const boton = nuevo ? el("b-otra-forma") : el("b-pagar");
  ocupar(boton, "Procesando…");
  estadoPago(null);
  pintarPlanes();
  el("i-correo-mp").readOnly = true;

  const cuerpo = { plan, plataforma: "pagina" };
  if (nuevo) cuerpo.nuevo = true;
  if (correoMp !== null) cuerpo.correo_mp = correoMp;
  // Al pagar también va la versión del aviso aceptada aquí: crear-pago la guarda
  // y exige la constancia de la vigente antes de crear nada.
  const privacidad = privacidadAceptadaAqui();
  if (privacidad !== null) cuerpo.privacidad = privacidad;
  const r = await llamar({ fetch: fetchNavegador, url: urlFuncion("crear-pago"), cuerpo, token: estado.sesion.token });
  const res = leerRespuestaCrearPago(r.status, r.json, { privacidadMandada: privacidad !== null });
  // Solo se va a Mercado Pago si lo que el servidor cobra y guarda es lo que se aceptó.
  const revision = res.tipo === "ir" ? revisarAntesDeIr(estado.cotizaciones[plan], res.cotizacion, estado.mensualModo) : null;

  if (res.tipo === "ir" && revision === "ok") {
    // /pago/ sigue este cobro al volver; la suscripción no trae su id en la URL de vuelta (2bis).
    guardarDato(CLAVES.cobro, {
      id: res.cobroId,
      plan,
      tipo: res.tipoCobro ?? (suscripcion ? "suscripcion" : "pago"),
      creado: Date.now(),
    });
    boton.textContent = "Abriendo Mercado Pago…";
    estadoPago("Te llevamos a Mercado Pago…", "ok");
    location.assign(res.url); // el botón queda bloqueado: la página se va
    return;
  }

  estado.ocupado = false;
  liberar(boton);
  el("i-correo-mp").readOnly = false;
  // Un error que trae la suscripción viva (409 o 503) la actualiza: su tarjeta y su «Cancelar» siguen (A.3).
  if (res.tipo === "error" && res.suscripcion !== undefined) {
    estado.suscripcion = suscripcionMasReciente(estado.suscripcion, res.suscripcion);
    if (res.suscripcion !== null) estado.cancelada = null;
  }
  if (res.tipo === "ir") {
    if (revision === "monto") {
      // El precio cambió con la página abierta: se muestra el nuevo y se pide aceptar de nuevo.
      estado.cotizaciones[plan] = res.cotizacion;
      desmarcarCondiciones();
      pintar();
      estadoPago(MENSAJES.montoCambio, "error");
      enfocar("t-compra");
      return;
    }
    if (revision === "condiciones") {
      estado.sinCompra = sinCompraPor({ codigo: "pagina_desactualizada", mensaje: MENSAJES.desactualizada });
      pintar();
      enfocar("sin-compra-texto");
      return;
    }
    if (revision === "modo") {
      // El mensual pasó de suscripción a pago único, o al revés, con la página abierta (R5):
      // se muestra cómo se cobra ahora y la persona acepta de nuevo.
      estado.mensualModo = res.cotizacion.mensualModo;
      estado.cotizaciones[plan] = res.cotizacion;
      desmarcarCondiciones();
      pintar();
      estadoPago(MENSAJES.modoCambio, "error");
      enfocar("t-compra");
      return;
    }
    pintar();
    estadoPago(MENSAJES.generico, "error");
    return;
  }
  if (res.tipo === "pendiente") {
    estado.pendiente = { cobroId: res.cobroId, desde: res.desde };
    pintar();
    enfocar("pendiente-texto");
    return;
  }
  if (res.tipo === "suscripcion_activa") {
    estado.suscripcion = suscripcionMasReciente(estado.suscripcion, res.suscripcion);
    estado.cancelada = null;
    pintar();
    enfocar("t-suscripcion");
    return;
  }
  if (res.volverAEntrar) {
    cerrarSesionLocal();
    mostrarEntrar(res.mensaje);
    enfocar("aviso");
    return;
  }
  if (res.campo === "correo") {
    if (!suscripcion) {
      // La página mostraba el mensual como pago único y el servidor ya lo cobra como
      // suscripción (pide el correo de MP, que aquí ni se veía): se vuelve a cotizar (R5).
      const nueva = await cotizar(plan);
      desmarcarCondiciones();
      pintar();
      estadoPago(nueva.tipo === "cotizacion" ? MENSAJES.modoCambio : nueva.mensaje, "error");
      enfocar("t-compra");
      return;
    }
    pintar();
    mostrarError("e-correo-mp", res.mensaje);
    el("i-correo-mp").focus();
    return;
  }
  if (res.campo === "privacidad") {
    // El servidor no tiene la constancia del aviso: vuelve la casilla, con su error,
    // junto al pago. El plan, el correo y la casilla de las condiciones quedan como estaban.
    estado.pedirPrivacidad = true;
    pintar();
    mostrarError("e-privacidad-pago", res.mensaje);
    el("c-privacidad-pago").focus();
    return;
  }
  if (res.codigo === "pagina_desactualizada") {
    // El aviso de privacidad vigente en el servidor es otro que el de esta página: solo sirve recargar.
    estado.sinCompra = sinCompraPor(res);
    pintar();
    enfocar("sin-compra-texto");
    return;
  }
  if (res.codigo === "vitalicia") {
    estado.sinCompra = sinCompraPor(res);
    pintar();
    enfocar("sin-compra-texto");
    return;
  }
  if (res.codigo === "no_habilitado") {
    // Al cotizar sí se podía comprar: el aviso va bajo el botón y los planes y
    // el correo quedan a la vista, para corregir el correo o pasarse al otro plan.
    pintar();
    estadoPago(mensajeNoHabilitadoAlPagar(suscripcion), "error", true);
    return;
  }
  if (res.codigo === "pago_no_disponible") {
    // Es de Arkhé (el vendedor sin validar en MP, o un token de otra cuenta): el texto
    // neutro y los contactos, sin pedirle revisar su correo (R6).
    pintar();
    estadoPago(res.mensaje, "error", true);
    return;
  }
  // Lo demás va bajo el botón: sin red, Auth que no respondió (se reintenta), o una
  // suscripción que Mercado Pago no deja ver (lo revisa una persona: van los contactos).
  pintar();
  estadoPago(res.mensaje, "error", res.contacto === true);
}

// ————— Cancelar la suscripción (A.3) —————

function abrirConfirmacion() {
  if (estado.ocupado || estado.suscripcion === null) return;
  estado.confirmando = true;
  el("confirmar-error").hidden = true;
  pintar();
  enfocar("t-confirmar");
}

function cerrarConfirmacion() {
  if (estado.ocupado) return;
  estado.confirmando = false;
  pintar();
  enfocar("b-cancelar");
}

async function confirmarCancelacion() {
  if (estado.ocupado || estado.sesion === null) return;
  estado.ocupado = true;
  const boton = el("b-confirmar");
  ocupar(boton, "Cancelando…");
  el("b-no-cancelar").disabled = true;
  el("confirmar-error").hidden = true;
  const r = await llamar({ fetch: fetchNavegador, url: urlFuncion("cancelar-suscripcion"), cuerpo: {}, token: estado.sesion.token });
  const res = leerRespuestaCancelar(r.status, r.json);
  estado.ocupado = false;
  liberar(boton);
  el("b-no-cancelar").disabled = false;

  if (res.tipo === "cancelada") {
    estado.suscripcion = null;
    estado.cancelada = { vence: res.vence ?? venceActual(), retractoHasta: res.retractoHasta, retractoSinConfirmacion: res.retractoSinConfirmacion };
    estado.confirmando = false;
    // Justo después de cancelar no se ofrece pagar: «no te mostramos pantallas para
    // convencerte de que te quedes» (/condiciones/, punto 8). La compra vuelve si la persona la pide.
    estado.trasCancelar = true;
    desmarcarCondiciones();
    pintar();
    enfocar("cancelada-1");
    return;
  }
  if (res.volverAEntrar) {
    cerrarSesionLocal();
    mostrarEntrar(res.mensaje);
    enfocar("aviso");
    return;
  }
  if (res.codigo === "sin_suscripcion") {
    // Ya no había nada que cancelar (por ejemplo, se canceló desde Mercado Pago):
    // la tarjeta se va y el aviso queda arriba, a la vista con cualquier plan.
    estado.suscripcion = null;
    estado.confirmando = false;
    pintar();
    avisar(res.mensaje);
    enfocar("aviso");
    return;
  }
  mostrarError("confirmar-error", res.mensaje);
}

// ————— Inicio —————

function conectar() {
  for (const radio of document.querySelectorAll('input[name="plan"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) void cambiarPlan(radio.value);
    });
  }
  el("c-privacidad").addEventListener("change", () => {
    if (el("c-privacidad").checked) el("e-privacidad").hidden = true;
  });
  el("c-privacidad-pago").addEventListener("change", () => {
    // Marcada, queda en esta pestaña y va a crear-pago en la próxima cotización o pago; desmarcada, se retira.
    if (el("c-privacidad-pago").checked) {
      guardarDato(CLAVES.privacidad, aceptacionPrivacidad());
      el("e-privacidad-pago").hidden = true;
    } else {
      borrarDato(CLAVES.privacidad);
    }
  });
  el("c-condiciones").addEventListener("change", () => {
    const casilla = el("c-condiciones");
    if (casilla.checked) {
      // Queda anotado qué se aceptó: si cambia el plan, el modo, el monto o la versión, se desmarca.
      casilla.dataset.acepto = claveActual() ?? "";
      el("e-condiciones").hidden = true;
    } else {
      delete casilla.dataset.acepto;
    }
  });
  el("i-correo-mp").addEventListener("input", () => {
    estado.correoEditado = true;
    el("e-correo-mp").hidden = true;
  });
  el("i-correo-mp").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void pagar(false);
  });
  el("b-entrar").addEventListener("click", () => void entrar());
  el("b-pagar").addEventListener("click", () => void pagar(false));
  el("b-otra-forma").addEventListener("click", () => void pagar(true));
  el("b-cancelar").addEventListener("click", abrirConfirmacion);
  el("b-no-cancelar").addEventListener("click", cerrarConfirmacion);
  el("b-confirmar").addEventListener("click", () => void confirmarCancelacion());
  el("b-cambiar").addEventListener("click", cambiarCuenta);
  el("b-reintentar").addEventListener("click", () => {
    // Con otra versión de las condiciones en el servidor, solo sirve traer la página nueva.
    if (estado.sinCompra?.recargar) location.reload();
    else void cargarCompra();
  });
  el("b-elegir-plan").addEventListener("click", () => {
    estado.trasCancelar = false;
    pintar();
    enfocar("t-planes");
  });

  // Volver con «Atrás» desde Google o Mercado Pago puede traer la página
  // congelada tal como se fue (bfcache), con el botón bloqueado: se libera.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    estado.ocupado = false;
    for (const b of document.querySelectorAll('button[aria-busy="true"]')) liberar(b);
    el("b-no-cancelar").disabled = false;
    estadoPago(null);
    pintar();
  });
}

async function iniciar() {
  conectar();
  pintar(); // «Cargando…» desde el primer instante: sin JavaScript, en cambio, se ve el aviso de <noscript>
  const url = new URL(location.href);
  const vuelta = leerVueltaGoogle(url.search, url.hash);
  const planUrl = leerPlanDeUrl(url.search);
  const planGuardado = leerDato(CLAVES.plan);
  if (planUrl !== null) estado.plan = planUrl;
  else if (planGuardado === "anual" || planGuardado === "mensual") estado.plan = planGuardado;
  guardarDato(CLAVES.plan, estado.plan);

  // La URL se limpia antes de cualquier espera: un código de Google sirve una
  // sola vez y no debe quedar en el historial ni en una recarga.
  if (url.search !== "" || url.hash !== "") history.replaceState(null, "", url.pathname);

  if (vuelta.tipo === "codigo") {
    await entrarConCodigo(vuelta.codigo);
    return;
  }
  if (vuelta.tipo === "error") {
    borrarDato(CLAVES.pkce);
    mostrarEntrar(mensajeVueltaGoogle(vuelta.motivo));
    return;
  }
  const sesion = leerDato(CLAVES.sesion);
  if (sesionVigente(sesion, Date.now())) {
    estado.sesion = sesion;
    await cargarCompra();
    return;
  }
  if (sesion !== null) {
    borrarDato(CLAVES.sesion);
    mostrarEntrar("Tu sesión venció: vuelve a entrar.");
    return;
  }
  mostrarEntrar(null);
}

void iniciar();
