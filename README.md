# Arkhé · página de venta (arkheapp.cl)

Página estática, sin build: cinco capítulos con índice, el tablero de Ana que se arma al llegar a su figura y los desplegables «ver el detalle». Publicada el 11 de noviembre de 2026.

- La fuente es `landing/index.html` del repo privado de Arkhé: se edita directo.
- Se publica con `bash landing/publicar.sh` desde la raíz de ese repo (GitHub Pages, repo `Danihu98/arkhe-landing`, dominio arkheapp.cl). Reemplaza todo lo publicado, así que se corre solo desde la rama que tiene la página completa, con `/condiciones/`, `/privacidad/`, `/pagar/` y `/pago/`.
- Las pantallas de la app salen de `web-venta/capturas/scripts/escenario.js`, que recorre la versión web local de Arkhé con un caso ficticio; `armar_imagenes.py` las deja en `landing/img` y `og.js` arma la imagen para compartir.
- Sin analytics, sin cookies y sin formularios. No carga librerías: solo las letras de Google Fonts.
- Las láminas son de dominio público o CC0; sus créditos van al pie de la página.
- Todas las pantallas de la app son de un caso ficticio.
