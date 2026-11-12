// El DOM de /pago/, la página a la que vuelve Mercado Pago (ADR-0033,
// 2026-11-08; brief § 7.2; addendum § 2bis, «Primer cobro y retorno»).
//
// Esta página nunca confirma nada por sí misma: lo único que activa una
// licencia es procesar_pago, en el servidor. Aquí solo se pregunta.
//   - Con la sesión de /pagar/ en esta pestaña: consultar-pago cada 4 s
//     durante 2 min, y también al volver a la pestaña. Una suscripción ya
//     autorizada (`suscrita`) espera su primer cobro alrededor de una hora:
//     se avisa eso y se pregunta cada minuto (SONDEO, en logica.js), mientras
//     la sesión dure: no se renueva, y suele vencer antes de ese cobro.
//   - Sin sesión (volvió en otra pestaña, la sesión venció o el pago empezó
//     en la app): solo se lee lo que MP puso en la URL, para elegir entre
//     textos fijos (textoSinSesion).
// La query se borra apenas se lee (history.replaceState). Todo se escribe con
// textContent.

import {
  CLAVES,
  NOTA_SESION_VENCIDA,
  SONDEO,
  esEstadoFinal,
  estadoDePago,
  leerRespuestaConsultar,
  leerVueltaMP,
  llamar,
  sesionVigente,
  siguienteConsulta,
  textoPago,
  textoSinSesion,
  urlFuncion,
  uuid,
} from "../pagar/logica.js";

const el = (id) => document.getElementById(id);
const fetchNavegador = (url, init) => fetch(url, init);

function leerDato(clave) {
  try {
    const t = sessionStorage.getItem(clave);
    return t === null ? null : JSON.parse(t);
  } catch {
    return null;
  }
}

function mostrar(id, visible) {
  el(id).hidden = !visible;
}

const estado = {
  vuelta: null, // lo que MP puso en la URL
  sesion: null,
  cobroId: null, // null = la última suscripción de la cuenta (consultar-pago sin cobro_id, 2bis)
  esSuscripcion: false,
  suscripcionEstado: null, // activa · pausada · cancelada · pendiente, según consultar-pago
  inicio: Date.now(), // desde cuándo se cuenta el sondeo
  ultimaConsulta: 0,
  enCurso: false,
  final: false,
  temporizador: null,
  mostrado: "esperando",
  correo: "",
  vence: null,
};

// ————— Pintar —————

function pintarTexto(t) {
  el("titulo").textContent = t.titulo;
  el("texto").textContent = t.texto;
  el("detalle").textContent = t.detalle ?? "";
  mostrar("detalle", Boolean(t.detalle));
  el("resultado").className = `resultado resultado--${t.tono}`;
}

/** El enlace a /pagar/: su texto cambia según para qué sirve (volver a intentar, ver la suscripción, entrar de nuevo). */
function pintarEnlacePagar(visible, texto) {
  el("a-pagar").textContent = texto;
  mostrar("a-pagar", visible);
}

function pintarEstado(nombre) {
  estado.mostrado = nombre;
  const t = textoPago(nombre, {
    correo: estado.correo,
    vence: estado.vence,
    suscripcion: estado.esSuscripcion,
    suscripcionEstado: estado.suscripcionEstado,
  });
  pintarTexto(t);
  pintarEnlacePagar(t.volverAPagar, t.textoPagar);
  mostrar("contacto", t.contacto);
  mostrar("b-consultar", t.consultarDeNuevo);
}

/** Sin sesión que consultar: el texto sale de la URL de vuelta (brief § 7.2, paso 3; textoSinSesion). */
function pintarSinSesion(sesionVencida) {
  estado.final = true;
  clearTimeout(estado.temporizador);
  const t = textoSinSesion(estado.vuelta, { sesionVencida });
  pintarTexto(t);
  mostrar("consultando", false);
  mostrar("sin-red", false);
  pintarEnlacePagar(t.volverAPagar, t.textoPagar);
  mostrar("b-consultar", false);
  mostrar("contacto", t.contacto);
}

/**
 * La sesión de /pagar/ ya no sirve para consultar (401, o no alcanza para la
 * próxima consulta). Si todavía no se sabía nada, el texto sale de la URL. Si
 * ya se sabía algo (por ejemplo, «Tu suscripción quedó creada»), eso queda a
 * la vista y solo se dice cómo seguir, con un enlace a /pagar/.
 */
function alVencerSesion() {
  if (estado.mostrado === "esperando" || estado.mostrado === "sin_confirmar") {
    pintarSinSesion(true);
    return;
  }
  estado.final = true;
  clearTimeout(estado.temporizador);
  mostrar("consultando", false);
  mostrar("sin-red", false);
  mostrar("b-consultar", false);
  el("detalle").textContent = NOTA_SESION_VENCIDA;
  mostrar("detalle", true);
  pintarEnlacePagar(true, "Entrar de nuevo");
}

// ————— Consultar —————

function programar() {
  clearTimeout(estado.temporizador);
  if (estado.final) {
    mostrar("consultando", false);
    return;
  }
  const transcurrido = Date.now() - estado.inicio;
  const espera = siguienteConsulta(estado.mostrado, transcurrido, estado.sesion.vence - Date.now());
  if (espera === null) {
    mostrar("consultando", false);
    // Habría seguido consultando, pero la sesión no alcanza: se dice cómo ver el estado después.
    if (siguienteConsulta(estado.mostrado, transcurrido) !== null) {
      alVencerSesion();
      return;
    }
    // Pasaron los 2 min sin respuesta de MP: se dice, sin dar el pago por perdido.
    if (estado.mostrado === "esperando") pintarEstado("sin_confirmar");
    return;
  }
  mostrar("consultando", espera === SONDEO.rapidoMs);
  estado.temporizador = setTimeout(() => {
    // El sondeo lento corre solo con la página a la vista; al volver a ella, alVolver pregunta de inmediato.
    if (espera === SONDEO.lentoMs && document.visibilityState !== "visible") {
      programar();
      return;
    }
    void consultar(false);
  }, espera);
}

async function consultar(forzar) {
  if (estado.enCurso || estado.final || estado.sesion === null) return;
  estado.enCurso = true;
  estado.ultimaConsulta = Date.now();
  const cuerpo = estado.cobroId !== null ? { cobro_id: estado.cobroId } : {};
  if (forzar) cuerpo.forzar = true;
  const r = await llamar({ fetch: fetchNavegador, url: urlFuncion("consultar-pago"), cuerpo, token: estado.sesion.token });
  estado.enCurso = false;
  const res = leerRespuestaConsultar(r.status, r.json);

  if (res.tipo === "estado") {
    mostrar("sin-red", false);
    if (res.cobroId !== null && estado.cobroId === null) estado.cobroId = res.cobroId;
    if (res.cobroTipo === "suscripcion" || res.suscripcion !== null) estado.esSuscripcion = true;
    estado.suscripcionEstado = res.suscripcion?.estado ?? null;
    if (res.correo) estado.correo = res.correo;
    estado.vence = res.vence;
    const visible = estadoDePago(res);
    estado.final = esEstadoFinal(visible);
    pintarEstado(visible);
    if (estado.final) el("titulo").focus({ preventScroll: true });
  } else if (res.tipo === "sin_sesion") {
    alVencerSesion();
    return;
  } else if (res.tipo === "no_encontrado" || res.tipo === "error") {
    // Un cobro que no es de esta cuenta (o que no existe) se ve igual que sin sesión.
    pintarSinSesion(false);
    return;
  } else {
    // Sin red, 429 o 5xx: es pasajero, y se vuelve a preguntar en la vuelta siguiente.
    mostrar("sin-red", true);
  }
  programar();
}

/** Al volver a la pestaña (por ejemplo, desde la app de Mercado Pago): preguntar ya, sin esperar el turno. */
function alVolver() {
  if (estado.final || estado.sesion === null || document.visibilityState !== "visible") return;
  if (Date.now() - estado.ultimaConsulta < SONDEO.rapidoMs) return;
  if (!sesionVigente(estado.sesion, Date.now())) {
    alVencerSesion();
    return;
  }
  void consultar(false);
}

// ————— Inicio —————

function iniciar() {
  estado.vuelta = leerVueltaMP(location.search);
  // La query (ids y estado del pago) no se queda en el historial ni en una recarga.
  if (location.search !== "" || location.hash !== "") history.replaceState(null, "", location.pathname);

  // «Cerrar» solo sirve si otra ventana abrió esta (brief § 7.2, paso 4).
  mostrar("b-cerrar", Boolean(window.opener));
  el("b-cerrar").addEventListener("click", () => window.close());
  el("b-consultar").addEventListener("click", () => {
    // Con la sesión vencida, consultar solo traería un 401: se dice cómo seguir.
    if (!sesionVigente(estado.sesion, Date.now())) {
      alVencerSesion();
      return;
    }
    // Pedirlo a mano reabre los 2 min de sondeo.
    estado.inicio = Date.now();
    pintarEstado("esperando");
    void consultar(true);
  });
  window.addEventListener("focus", alVolver);
  document.addEventListener("visibilitychange", alVolver);

  const sesion = leerDato(CLAVES.sesion);
  if (!sesionVigente(sesion, Date.now())) {
    // Con una sesión guardada que ya venció, además del texto se ofrece entrar de nuevo.
    pintarSinSesion(sesion !== null);
    return;
  }
  estado.sesion = sesion;
  estado.correo = typeof sesion.correo === "string" ? sesion.correo : "";

  const guardado = leerDato(CLAVES.cobro);
  const idGuardado = guardado !== null && typeof guardado === "object" ? uuid(guardado.id) : null;
  // La referencia de la URL manda (Checkout Pro la trae); la suscripción no
  // la trae (2bis), y para eso está el cobro que /pagar/ guardó. Sin ninguno
  // de los dos, consultar-pago resuelve la última suscripción de la cuenta.
  // El servidor solo responde por cobros de esta misma cuenta (404 si no).
  estado.cobroId = estado.vuelta.externalReference ?? idGuardado;
  estado.esSuscripcion =
    estado.vuelta.preapprovalId !== null ||
    (guardado !== null && guardado.tipo === "suscripcion" && estado.cobroId === idGuardado);

  pintarEstado("esperando");
  mostrar("consultando", true);
  void consultar(false);
}

iniciar();
